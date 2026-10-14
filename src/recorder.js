// Optional log of every turn (question, page list, screenshot, answer,
// highlights), for finding and fixing mistakes with scripts/eval.js.
// Kept in IndexedDB on this computer only, never sent anywhere. Off unless
// the family turns it on in the settings.

const DB_NAME = "veebiabiline-log";
const STORE = "turns";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

// Resolves to the new turn's id.
export const addTurn = (turn) => withStore("readwrite", (store) => store.add(turn));

export const markTurn = (id, fields) =>
  withStore("readwrite", (store) => {
    const request = store.get(id);
    request.onsuccess = () => request.result && store.put({ ...request.result, ...fields });
  });

export const allTurns = () => withStore("readonly", (store) => store.getAll());
export const countTurns = () => withStore("readonly", (store) => store.count());
export const clearTurns = () => withStore("readwrite", (store) => store.clear());
