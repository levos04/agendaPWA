/* global AgendaDB */
'use strict';

const $ = (sel) => document.querySelector(sel);
const state = { activities: [], filter: 'all', search: '', deferredInstall: null, swReg: null };

// ---------- Utilidades ----------
const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function toast(msg, ms = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

const fmtDate = (iso) =>
  new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

/** Convierte una fecha ISO al formato de <input type="datetime-local"> en hora local */
function toLocalInput(iso) {
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// ---------- Render ----------
async function refresh() {
  state.activities = await AgendaDB.getAll();
  state.activities.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  render();
  updateSyncBadge();
}

function render() {
  const list = $('#activity-list');
  const q = state.search.toLowerCase();
  const items = state.activities.filter((a) => {
    if (state.filter === 'pending' && a.done) return false;
    if (state.filter === 'done' && !a.done) return false;
    if (q && !(`${a.title} ${a.description} ${a.category}`.toLowerCase().includes(q))) return false;
    return true;
  });

  list.replaceChildren(...items.map(renderItem));
  $('#empty').hidden = items.length > 0;
  const pending = state.activities.filter((a) => !a.done).length;
  $('#counter').textContent = `${state.activities.length} en total · ${pending} pendientes`;
}

function renderItem(a) {
  const li = document.createElement('li');
  li.className = `activity ${a.priority}${a.done ? ' done' : ''}`;
  li.id = a.id;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = !!a.done;
  check.setAttribute('aria-label', `Marcar "${a.title}" como completada`);
  check.addEventListener('change', () => toggleDone(a.id, check.checked));

  const body = document.createElement('div');
  const title = document.createElement('p');
  title.className = 'a-title';
  title.textContent = a.title;
  const desc = document.createElement('p');
  desc.className = 'a-desc';
  desc.textContent = a.description || '';
  const meta = document.createElement('div');
  meta.className = 'a-meta';
  const chips = [
    ['chip', `📅 ${fmtDate(a.dueAt)}`],
    ['chip', a.category],
    ['chip', `Prioridad ${a.priority}`]
  ];
  if (a.remindAt) chips.push(['chip', `⏰ ${fmtDate(a.remindAt)}`]);
  if (!a.done && new Date(a.dueAt) < new Date()) chips.push(['chip overdue', 'Vencida']);
  if (!a.synced) chips.push(['chip unsynced', 'Sin sincronizar']);
  chips.forEach(([cls, text]) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    meta.append(s);
  });
  body.append(title);
  if (a.description) body.append(desc);
  body.append(meta);

  const actions = document.createElement('div');
  actions.className = 'a-actions';
  const edit = document.createElement('button');
  edit.className = 'icon-btn';
  edit.textContent = 'Editar';
  edit.setAttribute('aria-label', `Editar "${a.title}"`);
  edit.addEventListener('click', () => startEdit(a.id));
  const del = document.createElement('button');
  del.className = 'icon-btn danger';
  del.textContent = 'Eliminar';
  del.setAttribute('aria-label', `Eliminar "${a.title}"`);
  del.addEventListener('click', () => removeActivity(a.id));
  actions.append(edit, del);

  li.append(check, body, actions);
  return li;
}

// ---------- CRUD ----------
async function onSubmit(e) {
  e.preventDefault();
  const id = $('#activity-id').value || uuid();
  const existing = $('#activity-id').value ? await AgendaDB.get(id) : null;
  const dueAt = new Date($('#dueAt').value).toISOString();
  const reminder = Number($('#reminder').value);
  const remindAt = reminder >= 0 ? new Date(new Date(dueAt).getTime() - reminder * 60000).toISOString() : null;

  const activity = {
    ...(existing || { createdAt: Date.now(), done: false }),
    id,
    title: $('#title').value.trim(),
    description: $('#description').value.trim(),
    dueAt,
    reminder,
    remindAt,
    category: $('#category').value,
    priority: $('#priority').value,
    notified: existing && existing.remindAt === remindAt ? existing.notified : false
  };
  if (!activity.title) return toast('El título es obligatorio');

  await AgendaDB.save(activity);
  toast(existing ? 'Actividad actualizada' : 'Actividad registrada');
  resetForm();
  await refresh();
  requestSync();
}

async function toggleDone(id, done) {
  const a = await AgendaDB.get(id);
  if (!a) return;
  await AgendaDB.save({ ...a, done });
  await refresh();
  requestSync();
}

async function startEdit(id) {
  const a = await AgendaDB.get(id);
  if (!a) return;
  $('#activity-id').value = a.id;
  $('#title').value = a.title;
  $('#description').value = a.description || '';
  $('#dueAt').value = toLocalInput(a.dueAt);
  $('#reminder').value = String(a.reminder ?? -1);
  $('#category').value = a.category;
  $('#priority').value = a.priority;
  $('#form-title').textContent = 'Editar actividad';
  $('#save-btn').textContent = 'Guardar cambios';
  $('#cancel-btn').hidden = false;
  $('#title').focus();
}

async function removeActivity(id) {
  const a = await AgendaDB.get(id);
  if (!a || !confirm(`¿Eliminar "${a.title}"?`)) return;
  await AgendaDB.remove(id);
  toast('Actividad eliminada');
  await refresh();
  requestSync();
}

function resetForm() {
  $('#activity-form').reset();
  $('#activity-id').value = '';
  $('#form-title').textContent = 'Nueva actividad';
  $('#save-btn').textContent = 'Guardar actividad';
  $('#cancel-btn').hidden = true;
  setDefaultDate();
}

function setDefaultDate() {
  const d = new Date(Date.now() + 60 * 60000);
  d.setSeconds(0, 0);
  $('#dueAt').value = toLocalInput(d.toISOString());
}

// ---------- Estado de red y sincronización ----------
function updateNetBadge() {
  const el = $('#net-status');
  const on = navigator.onLine;
  el.textContent = on ? 'En línea' : 'Sin conexión';
  el.className = `badge ${on ? 'online' : 'offline'}`;
}

async function updateSyncBadge() {
  const n = await AgendaDB.countOutbox();
  const el = $('#sync-status');
  el.textContent = n ? `${n} cambio(s) pendiente(s)` : 'Sincronizado';
  el.className = `badge ${n ? 'pending' : 'neutral'}`;
  const last = await AgendaDB.getMeta('lastSync');
  $('#last-sync').textContent = `Última sincronización: ${last ? fmtDate(last) : 'nunca'}`;
}

let syncing = false;
async function syncNow({ silent = false } = {}) {
  if (syncing) return;
  if (!navigator.onLine) {
    if (!silent) toast('Sin conexión: los cambios se enviarán al reconectar');
    return;
  }
  syncing = true;
  try {
    const { sent } = await AgendaDB.syncNow();
    if (!silent || sent) toast(sent ? `Sincronizados ${sent} cambio(s) con el servidor` : 'Todo está sincronizado');
    await refresh();
  } catch (err) {
    if (!silent) toast('No se pudo sincronizar: ' + err.message);
  } finally {
    syncing = false;
  }
}

/**
 * Pide sincronizar: registra Background Sync (si el navegador lo soporta) para que
 * el Service Worker envíe los cambios aunque la pestaña se cierre, y además intenta enseguida.
 */
async function requestSync() {
  await updateSyncBadge();
  if (state.swReg && 'sync' in state.swReg) {
    try {
      await state.swReg.sync.register('sync-activities');
    } catch { /* sin permiso de Background Sync: se usa el evento online */ }
  }
  syncNow({ silent: true });
}

// ---------- Notificaciones ----------
function updatePermBadge() {
  const p = 'Notification' in window ? Notification.permission : 'no soportado';
  const map = { granted: 'concedido', denied: 'denegado', default: 'sin decidir' };
  $('#perm-status').textContent = map[p] || p;
}

async function askPermission() {
  if (!('Notification' in window)) return toast('Este navegador no soporta notificaciones');
  const p = await Notification.requestPermission();
  updatePermBadge();
  toast(p === 'granted' ? 'Notificaciones activadas' : 'Permiso de notificaciones no concedido');
  return p;
}

async function showLocalNotification(title, options = {}) {
  if (Notification.permission !== 'granted') {
    const p = await askPermission();
    if (p !== 'granted') return;
  }
  const reg = await navigator.serviceWorker.ready;
  return reg.showNotification(title, {
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    vibrate: [100, 50, 100],
    ...options
  });
}

/** Revisa recordatorios vencidos con la Notifications API (funciona sin conexión mientras la app está abierta) */
async function checkLocalReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = Date.now();
  const due = (await AgendaDB.getAll()).filter(
    (a) => a.remindAt && !a.done && !a.notified && new Date(a.remindAt).getTime() <= now
  );
  for (const a of due) {
    await showLocalNotification(`⏰ Recordatorio: ${a.title}`, {
      body: a.description || `Programada para ${fmtDate(a.dueAt)}`,
      tag: `reminder-${a.id}`, // mismo tag que el Push del servidor: evita duplicados
      data: { url: `/#${a.id}` }
    });
    await AgendaDB.markNotified(a.id);
  }
}

// ---------- Push API ----------
async function updatePushBadge() {
  if (!state.swReg || !('PushManager' in window)) {
    $('#push-status').textContent = 'no soportado';
    return;
  }
  const sub = await state.swReg.pushManager.getSubscription();
  $('#push-status').textContent = sub ? 'suscrito' : 'no suscrito';
  $('#push-sub-btn').textContent = sub ? 'Cancelar suscripción Push' : 'Suscribirse a Push';
}

async function togglePush() {
  if (!('PushManager' in window)) return toast('Push API no soportada en este navegador');
  if (!navigator.onLine) return toast('Necesitas conexión para suscribirte a Push');
  const existing = await state.swReg.pushManager.getSubscription();
  try {
    if (existing) {
      await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint })
      });
      await existing.unsubscribe();
      toast('Suscripción Push cancelada');
    } else {
      if ((await askPermission()) !== 'granted') return;
      const { publicKey } = await (await fetch('/api/vapid-public-key')).json();
      const sub = await state.swReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
      });
      toast('Suscrito a notificaciones Push');
    }
  } catch (err) {
    toast('Error con Push: ' + err.message);
  }
  updatePushBadge();
}

async function testPush() {
  if (!navigator.onLine) return toast('Necesitas conexión para enviar un Push');
  try {
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Agenda PWA', body: 'Push de prueba enviado desde el servidor 🚀' })
    });
    const data = await res.json();
    toast(data.sent ? `Push enviado a ${data.sent} dispositivo(s)` : 'No hay dispositivos suscritos');
  } catch (err) {
    toast('Error al enviar Push: ' + err.message);
  }
}

// ---------- Instalación ----------
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstall = e;
  $('#install-btn').hidden = false;
});
window.addEventListener('appinstalled', () => {
  $('#install-btn').hidden = true;
  toast('¡App instalada!');
});

// ---------- Inicio ----------
async function init() {
  setDefaultDate();
  updateNetBadge();
  updatePermBadge();

  $('#activity-form').addEventListener('submit', onSubmit);
  $('#cancel-btn').addEventListener('click', resetForm);
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    render();
  });
  document.querySelectorAll('.seg').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      state.filter = btn.dataset.filter;
      render();
    })
  );
  $('#perm-btn').addEventListener('click', askPermission);
  $('#local-notif-btn').addEventListener('click', () =>
    showLocalNotification('Agenda PWA', { body: 'Notificación local generada con la Notifications API ✅', tag: 'test-local' })
  );
  $('#push-sub-btn').addEventListener('click', togglePush);
  $('#push-test-btn').addEventListener('click', testPush);
  $('#sync-btn').addEventListener('click', () => syncNow());
  $('#install-btn').addEventListener('click', async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $('#install-btn').hidden = true;
  });

  window.addEventListener('online', () => {
    updateNetBadge();
    toast('Conexión recuperada: sincronizando…');
    syncNow({ silent: true });
  });
  window.addEventListener('offline', () => {
    updateNetBadge();
    toast('Sin conexión: los cambios se guardan localmente');
  });

  if ('serviceWorker' in navigator) {
    try {
      state.swReg = await navigator.serviceWorker.register('/sw.js');
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'SYNC_DONE') {
          refresh();
          if (e.data.sent) toast(`Sincronizados ${e.data.sent} cambio(s) en segundo plano`);
        }
      });
    } catch (err) {
      console.error('No se pudo registrar el Service Worker', err);
    }
  }
  await updatePushBadge();
  await refresh();
  syncNow({ silent: true });

  checkLocalReminders();
  setInterval(checkLocalReminders, 20_000);
  setInterval(() => render(), 60_000); // actualiza etiquetas "Vencida"

  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
}

document.addEventListener('DOMContentLoaded', init);
