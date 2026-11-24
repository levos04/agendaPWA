/**
 * Capa de acceso a IndexedDB.
 * Script clásico: se usa tanto en la página (window) como en el Service Worker (importScripts).
 *
 * Object stores:
 *  - activities : actividades (keyPath "id")
 *  - outbox     : cola de cambios pendientes de sincronizar (autoIncrement)
 *  - meta       : pares clave/valor (p. ej. última sincronización)
 */
(function (global) {
  const DB_NAME = 'agenda-pwa';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('activities')) {
          const store = db.createObjectStore('activities', { keyPath: 'id' });
          store.createIndex('dueAt', 'dueAt');
          store.createIndex('done', 'done');
        }
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function tx(storeNames, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => (result = r), reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const AgendaDB = {
    open,

    /** READ: todas las actividades */
    getAll() {
      return tx('activities', 'readonly', (t) => promisify(t.objectStore('activities').getAll()));
    },

    /** READ: una actividad */
    get(id) {
      return tx('activities', 'readonly', (t) => promisify(t.objectStore('activities').get(id)));
    },

    /** CREATE / UPDATE: guarda y encola el cambio para sincronizar */
    save(activity) {
      const now = Date.now();
      const record = { ...activity, updatedAt: now, synced: false };
      return tx(['activities', 'outbox'], 'readwrite', (t) => {
        t.objectStore('activities').put(record);
        t.objectStore('outbox').add({ op: 'upsert', id: record.id, data: strip(record), updatedAt: now });
        return record;
      });
    },

    /** DELETE: elimina y encola el borrado */
    remove(id) {
      const now = Date.now();
      return tx(['activities', 'outbox'], 'readwrite', (t) => {
        t.objectStore('activities').delete(id);
        t.objectStore('outbox').add({ op: 'delete', id, updatedAt: now });
      });
    },

    /** Marca una actividad como notificada localmente (no genera cambio a sincronizar) */
    markNotified(id) {
      return tx('activities', 'readwrite', async (t) => {
        const store = t.objectStore('activities');
        const a = await promisify(store.get(id));
        if (a) {
          a.notified = true;
          store.put(a);
        }
      });
    },

    getOutbox() {
      return tx('outbox', 'readonly', (t) => promisify(t.objectStore('outbox').getAll()));
    },

    countOutbox() {
      return tx('outbox', 'readonly', (t) => promisify(t.objectStore('outbox').count()));
    },

    /** Elimina de la cola las operaciones confirmadas por el servidor */
    clearOutbox(seqs) {
      return tx('outbox', 'readwrite', (t) => {
        const store = t.objectStore('outbox');
        seqs.forEach((s) => store.delete(s));
      });
    },

    /**
     * Mezcla las actividades del servidor con las locales.
     * Las que siguen pendientes en la outbox se respetan (el cambio local es más reciente).
     */
    mergeFromServer(serverActivities) {
      return tx(['activities', 'outbox'], 'readwrite', async (t) => {
        const actStore = t.objectStore('activities');
        const pending = await promisify(t.objectStore('outbox').getAll());
        const pendingIds = new Set(pending.map((p) => p.id));
        const local = await promisify(actStore.getAll());
        const serverIds = new Set(serverActivities.map((a) => a.id));

        for (const s of serverActivities) {
          if (pendingIds.has(s.id)) continue;
          const l = local.find((x) => x.id === s.id);
          if (!l || l.updatedAt <= s.updatedAt) {
            actStore.put({ ...s, synced: true, notified: l ? l.notified && l.remindAt === s.remindAt : false });
          }
        }
        // Lo que ya estaba sincronizado y no existe en el servidor fue eliminado en otro dispositivo
        for (const l of local) {
          if (l.synced && !serverIds.has(l.id) && !pendingIds.has(l.id)) actStore.delete(l.id);
        }
      });
    },

    setMeta(key, value) {
      return tx('meta', 'readwrite', (t) => t.objectStore('meta').put(value, key));
    },

    getMeta(key) {
      return tx('meta', 'readonly', (t) => promisify(t.objectStore('meta').get(key)));
    }
  };

  /** Quita campos que solo tienen sentido localmente */
  function strip(record) {
    const { synced, notified, ...rest } = record;
    return rest;
  }

  /**
   * Envía la outbox al servidor. Compartido por la página y por el SW (Background Sync).
   * Devuelve { sent, activities } o lanza error si no hay red.
   */
  AgendaDB.syncNow = async function syncNow() {
    const outbox = await AgendaDB.getOutbox();
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops: outbox.map(({ seq, ...op }) => op) })
    });
    if (!res.ok) throw new Error('Error del servidor: ' + res.status);
    const data = await res.json();
    await AgendaDB.clearOutbox(outbox.map((o) => o.seq));
    await AgendaDB.mergeFromServer(data.activities || []);
    await AgendaDB.setMeta('lastSync', Date.now());
    return { sent: outbox.length, activities: data.activities };
  };

  global.AgendaDB = AgendaDB;
})(typeof self !== 'undefined' ? self : window);
