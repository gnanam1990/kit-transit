// IndexedDB draft store for offline receiving (T-016). Drafts are unsigned
// working state only; a draft records every raw scan plus the normalized
// counted lines so reconnect can show a diff before anything is signed.

"use strict";

const Drafts = (() => {
  const DB = "kit-transit";
  const STORE = "drafts";
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out.result ?? out);
      t.onerror = () => reject(t.error);
    });
  }

  return {
    save: (draft) => tx("readwrite", (s) => s.put({ ...draft, updatedAt: Date.now() })),
    load: (id) => tx("readonly", (s) => s.get(id)),
    all: () => tx("readonly", (s) => s.getAll()),
    remove: (id) => tx("readwrite", (s) => s.delete(id)),
  };
})();
