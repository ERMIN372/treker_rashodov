// Тонкая обёртка над IndexedDB. Данные живут только на этом устройстве.
const DB_NAME = 'treker-rashodov';
const DB_VERSION = 3; // 2 — долги, 3 — быстрые кнопки
const DATA_STORES = ['transactions', 'categories', 'recurring', 'debts', 'presets'];
const ALL_STORES = [...DATA_STORES, 'meta'];

let dbPromise = null;

function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Миграции по шагам: существующие данные не трогаются
    req.onupgradeneeded = (e) => {
      const d = req.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('transactions', { keyPath: 'id' }).createIndex('date', 'date');
        d.createObjectStore('categories', { keyPath: 'id' });
        d.createObjectStore('recurring', { keyPath: 'id' });
        d.createObjectStore('meta', { keyPath: 'key' });
      }
      if (e.oldVersion < 2) d.createObjectStore('debts', { keyPath: 'id' });
      if (e.oldVersion < 3) d.createObjectStore('presets', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      // Новая версия приложения в другой вкладке обновляет базу — уступаем ей
      d.onversionchange = () => {
        d.close();
        location.reload();
      };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Выполняет work внутри транзакции и ждёт её фиксации.
// Если work вернул IDBRequest, результатом будет его result.
async function run(stores, mode, work) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const req = work(t);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Запись в хранилище прервана'));
  });
}

export const db = {
  getAll: (store) => run([store], 'readonly', (t) => t.objectStore(store).getAll()),

  put: (store, value) => run([store], 'readwrite', (t) => void t.objectStore(store).put(value)),

  delete: (store, id) => run([store], 'readwrite', (t) => void t.objectStore(store).delete(id)),

  // Несколько изменений атомарно: [{ store, put: value } | { store, delete: id }]
  bulk(ops) {
    if (!ops.length) return Promise.resolve();
    const stores = [...new Set(ops.map((o) => o.store))];
    return run(stores, 'readwrite', (t) => {
      for (const o of ops) {
        const s = t.objectStore(o.store);
        if ('delete' in o) s.delete(o.delete);
        else s.put(o.put);
      }
    });
  },

  // Версии с другого устройства: каждая сверяется с текущей внутри транзакции,
  // чтобы не затереть правку, сделанную прямо во время синхронизации.
  // merge(store, current, incoming) → что записать или null. Возвращает число записей.
  mergeIn(changes, merge) {
    const stores = Object.keys(changes);
    if (!stores.length) return Promise.resolve(0);
    let applied = 0;
    return run(stores, 'readwrite', (t) => {
      for (const name of stores) {
        const s = t.objectStore(name);
        for (const rec of changes[name]) {
          const req = s.get(rec.id);
          req.onsuccess = () => {
            const next = merge(name, req.result, rec);
            if (next) {
              s.put(next);
              applied += 1;
            }
          };
        }
      }
    }).then(() => applied);
  },

  // Полная замена данных (восстановление из копии) — одной транзакцией
  replaceAll(data) {
    return run(DATA_STORES, 'readwrite', (t) => {
      for (const name of DATA_STORES) {
        const s = t.objectStore(name);
        s.clear();
        for (const v of data[name] ?? []) s.put(v);
      }
    });
  },

  clearAll: () => run(ALL_STORES, 'readwrite', (t) => ALL_STORES.forEach((s) => t.objectStore(s).clear())),

  getMeta: (key) => run(['meta'], 'readonly', (t) => t.objectStore('meta').get(key)).then((row) => row?.value),

  setMeta: (key, value) => run(['meta'], 'readwrite', (t) => void t.objectStore('meta').put({ key, value })),
};
