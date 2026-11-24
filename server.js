/**
 * Backend de Agenda PWA
 * - Sirve los archivos estáticos de /public
 * - Expone la llave pública VAPID y guarda suscripciones Push
 * - Recibe la cola de cambios offline (/api/sync) y resuelve conflictos (last-write-wins)
 * - Revisa periódicamente los recordatorios vencidos y envía notificaciones Push
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- VAPID ----------
function loadVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (fs.existsSync(VAPID_FILE)) return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.log('[vapid] Llaves generadas y guardadas en data/vapid.json');
  return keys;
}
const vapid = loadVapidKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

// ---------- "Base de datos" en archivo JSON ----------
function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { activities: {}, subscriptions: [] };
  }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- App ----------
const app = express();
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Cabeceras de seguridad básicas (Best Practices en Lighthouse)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

// El SW y el manifest no deben quedarse en caché HTTP para que las actualizaciones lleguen
app.get(['/sw.js', '/manifest.webmanifest'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  next();
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (/\.(png|svg|ico)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
      else if (!/sw\.js$|manifest\.webmanifest$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/vapid-public-key', (req, res) => res.json({ publicKey: vapid.publicKey }));

app.get('/api/activities', (req, res) => {
  const db = readDb();
  res.json({ activities: Object.values(db.activities).filter((a) => !a.deleted) });
});

/**
 * Recibe operaciones pendientes del cliente:
 * [{ op: 'upsert' | 'delete', id, data?, updatedAt }]
 * Aplica "last-write-wins" según updatedAt y devuelve el estado completo.
 */
app.post('/api/sync', (req, res) => {
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : null;
  if (!ops) return res.status(400).json({ error: 'Formato inválido: se esperaba { ops: [] }' });

  const db = readDb();
  let applied = 0;
  for (const op of ops) {
    if (!op || typeof op.id !== 'string') continue;
    const current = db.activities[op.id];
    const incomingTs = Number(op.updatedAt) || Date.now();
    if (current && current.updatedAt > incomingTs) continue; // el servidor tiene una versión más nueva

    if (op.op === 'delete') {
      db.activities[op.id] = { id: op.id, deleted: true, updatedAt: incomingTs };
    } else if (op.op === 'upsert' && op.data) {
      const prevPushed = current && current.remindAt === op.data.remindAt ? current.pushed : false;
      db.activities[op.id] = { ...op.data, id: op.id, updatedAt: incomingTs, pushed: prevPushed };
    }
    applied++;
  }
  writeDb(db);
  res.json({ applied, activities: Object.values(db.activities).filter((a) => !a.deleted) });
});

app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
  const db = readDb();
  if (!db.subscriptions.some((s) => s.endpoint === sub.endpoint)) db.subscriptions.push(sub);
  writeDb(db);
  res.status(201).json({ ok: true, total: db.subscriptions.length });
});

app.post('/api/unsubscribe', (req, res) => {
  const db = readDb();
  db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== req.body?.endpoint);
  writeDb(db);
  res.json({ ok: true });
});

async function sendPushToAll(payload) {
  const db = readDb();
  const results = await Promise.allSettled(
    db.subscriptions.map((sub) => webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 }))
  );
  // Elimina suscripciones expiradas (404/410)
  const alive = db.subscriptions.filter((_, i) => {
    const r = results[i];
    return !(r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode));
  });
  if (alive.length !== db.subscriptions.length) {
    const fresh = readDb();
    fresh.subscriptions = alive;
    writeDb(fresh);
  }
  return results.filter((r) => r.status === 'fulfilled').length;
}

app.post('/api/notify', async (req, res) => {
  const { title = 'Agenda PWA', body = 'Notificación Push de prueba desde el servidor 🚀' } = req.body || {};
  try {
    const sent = await sendPushToAll({ title, body, url: '/' });
    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Programador de recordatorios (Push) ----------
async function checkReminders() {
  const db = readDb();
  const now = Date.now();
  const due = Object.values(db.activities).filter(
    (a) => !a.deleted && !a.done && a.remindAt && !a.pushed && new Date(a.remindAt).getTime() <= now
  );
  if (!due.length) return;
  for (const a of due) {
    await sendPushToAll({
      title: `⏰ Recordatorio: ${a.title}`,
      body: a.description || `Programada para ${new Date(a.dueAt).toLocaleString('es-MX')}`,
      tag: `reminder-${a.id}`,
      url: `/#${a.id}`
    });
  }
  const fresh = readDb();
  for (const a of due) if (fresh.activities[a.id]) fresh.activities[a.id].pushed = true;
  writeDb(fresh);
  console.log(`[push] ${due.length} recordatorio(s) enviados`);
}
setInterval(() => checkReminders().catch((e) => console.error('[push]', e.message)), 30_000);

// Fallback SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Agenda PWA escuchando en http://localhost:${PORT}`));
