/* 最小 IndexedDB 封裝：資料存在使用者自己的瀏覽器，離線可用。 */

const DB_NAME = 'payment-records'
const VERSION = 1
const STORES = ['records', 'persons', 'settings']

let dbPromise = null

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('資料庫被其他分頁鎖住'))
    }).catch((e) => {
      dbPromise = null
      throw e
    })
  }
  return dbPromise
}

function run(store, mode, action) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = action(tx.objectStore(store))
        tx.oncomplete = () => resolve(req?.result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export const put = (store, value) => run(store, 'readwrite', (s) => s.put(value))
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key))
export const getAll = (store) => run(store, 'readonly', (s) => s.getAll())
export const clear = (store) => run(store, 'readwrite', (s) => s.clear())
export const wipe = () => Promise.all(STORES.map((s) => clear(s)))
