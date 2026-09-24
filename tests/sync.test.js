import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../app/js/logic.js';
import { syncOnce, toBase64, fromBase64, SyncError } from '../app/js/sync.js';

// «GitHub» в памяти: sha меняется при каждой записи, запись со старым sha — конфликт
function fakeRemote() {
  const r = { sha: null, text: null, version: 0, writes: 0, beforeWrite: null };
  r.client = {
    async read(etag) {
      if (etag && etag === `e${r.version}`) return { notModified: true };
      return r.text === null ? { sha: null, text: null, etag: null } : { sha: r.sha, text: r.text, etag: `e${r.version}` };
    },
    async write(text, sha) {
      if (r.beforeWrite) {
        const hook = r.beforeWrite;
        r.beforeWrite = null;
        await hook();
      }
      if (sha !== r.sha) throw new SyncError('conflict', 'conflict');
      r.version += 1;
      r.writes += 1;
      r.sha = `s${r.version}`;
      r.text = text;
      return r.sha;
    },
  };
  return r;
}

// Устройство: хранилище с «надгробиями» и той же логикой применения, что в db.mergeIn
function device(name) {
  const stores = Object.fromEntries(L.SYNC_STORES.map((s) => [s, new Map()]));
  const d = {
    name,
    sync: { etag: null, sha: null, dirty: true },
    local: {
      async getAll() {
        return Object.fromEntries(L.SYNC_STORES.map((s) => [s, [...stores[s].values()]]));
      },
      async apply(changes) {
        let n = 0;
        for (const [s, recs] of Object.entries(changes)) {
          for (const rec of recs) {
            const cur = stores[s].get(rec.id);
            const merged = cur ? L.resolveRecord(cur, rec, s) : rec;
            if (!cur || L.recordKey(merged) !== L.recordKey(cur)) {
              stores[s].set(rec.id, merged);
              n += 1;
            }
          }
        }
        return n;
      },
    },
    put(store, rec) {
      stores[store].set(rec.id, rec);
      d.sync.dirty = true;
    },
    remove(store, id, at) {
      stores[store].set(id, { id, deleted: true, updatedAt: at });
      d.sync.dirty = true;
    },
    get: (store, id) => stores[store].get(id),
    live: (store) => [...stores[store].values()].filter((r) => !r.deleted),
    async syncWith(remote) {
      const res = await syncOnce({ client: remote.client, local: d.local, ...d.sync, deviceName: name, sleep: async () => {} });
      d.sync = { etag: res.etag, sha: res.sha, dirty: false };
      return res;
    },
  };
  return d;
}

const tx = (id, amount, updatedAt, extra = {}) => ({ id, type: 'expense', amount, categoryId: 'exp-food', date: '2026-09-24', note: '', createdAt: updatedAt, updatedAt, ...extra });

test('recordKey не зависит от порядка полей и undefined', () => {
  assert.equal(L.recordKey({ a: 1, b: 2 }), L.recordKey({ b: 2, a: 1, c: undefined }));
  assert.notEqual(L.recordKey({ a: 1 }), L.recordKey({ a: 2 }));
});

test('resolveRecord: свежее побеждает, удаление при равенстве, ничья одинакова с обеих сторон', () => {
  const a = tx('x', 100, 1);
  const b = tx('x', 200, 2);
  assert.equal(L.resolveRecord(a, b, 'transactions'), b);
  assert.equal(L.resolveRecord(b, a, 'transactions'), b);
  const dead = { id: 'x', deleted: true, updatedAt: 2 };
  assert.equal(L.resolveRecord(b, dead, 'transactions'), dead);
  const c = tx('x', 300, 2);
  assert.deepEqual(L.resolveRecord(b, c, 'transactions'), L.resolveRecord(c, b, 'transactions'));
});

test('resolveRecord: у правил lastDate не откатывается назад', () => {
  const rule = { id: 'r', type: 'expense', amount: 100, categoryId: 'exp-subs', startDate: '2026-01-15', period: 'monthly', active: true };
  const edited = { ...rule, amount: 500, lastDate: '2026-08-15', updatedAt: 10 };
  const progressed = { ...rule, lastDate: '2026-09-15', updatedAt: 5 };
  const merged = L.resolveRecord(progressed, edited, 'recurring');
  assert.equal(merged.amount, 500);
  assert.equal(merged.lastDate, '2026-09-15');
  assert.deepEqual(L.resolveRecord(edited, progressed, 'recurring'), merged);
});

test('mergeStore: что забрать себе и нужно ли отправлять', () => {
  const local = [tx('a', 1, 1), tx('b', 2, 5)];
  const remote = [tx('b', 3, 4), tx('c', 4, 1)];
  const { toLocal, remoteStale } = L.mergeStore(local, remote, 'transactions');
  assert.deepEqual(toLocal.map((r) => r.id), ['c']);
  assert.equal(remoteStale, true);
  const same = L.mergeStore([tx('a', 1, 1)], [{ ...tx('a', 1, 1) }], 'transactions');
  assert.deepEqual(same, { toLocal: [], remoteStale: false });
});

test('serializeSync ↔ parseSyncData, надгробия допустимы, мусор — нет', () => {
  const data = { transactions: [tx('b', 1, 1), { id: 'dead', deleted: true, updatedAt: 3 }, tx('a', 2, 2)], categories: L.defaultCategories(), recurring: [] };
  const text = L.serializeSync(data, new Date('2026-09-24T00:00:00Z'));
  const parsed = L.parseSyncData(text);
  assert.equal(parsed.transactions.length, 3);
  assert.ok(text.split('\n').length > 20, 'по записи на строку');
  assert.throws(() => L.parseSyncData('{"format":"x"}'), /посторонний/);
  const broken = JSON.parse(text);
  broken.transactions.push({ id: 'z', amount: -1 });
  assert.throws(() => L.parseSyncData(JSON.stringify(broken)), /повреждён/);
});

test('ключ подключения и нормализация репозитория', () => {
  const token = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';
  const key = L.makeSyncKey({ repo: 'ermin372/treker-data', token });
  assert.deepEqual(L.parseSyncKey(` ${key} `), { repo: 'ermin372/treker-data', token });
  assert.equal(L.parseSyncKey('treker1|bad repo|x'), null);
  assert.equal(L.parseSyncKey(token), null);
  assert.equal(L.normalizeRepo('https://github.com/ERMIN372/treker-data.git/'), 'ERMIN372/treker-data');
  assert.equal(L.deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone');
  assert.equal(L.deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows');
});

test('base64 с кириллицей и эмодзи', () => {
  const s = 'Пятёрочка 🛒 — 350,50 ₽';
  assert.equal(fromBase64(toBase64(s)), s);
  assert.equal(fromBase64('0J/RgNC40LLQtdGC\n'), 'Привет');
});

test('синхронизация: телефон и компьютер сходятся к одним данным', async () => {
  const gh = fakeRemote();
  const phone = device('iPhone');
  const pc = device('Windows');
  for (const c of L.defaultCategories()) {
    phone.put('categories', c);
    pc.put('categories', c);
  }
  phone.put('transactions', tx('p1', 100, 1000));
  pc.put('transactions', tx('c1', 200, 1001));

  assert.equal((await phone.syncWith(gh)).pushed, true);
  const r2 = await pc.syncWith(gh);
  assert.equal(r2.pulled, 1);
  assert.equal(r2.pushed, true);
  await phone.syncWith(gh);
  assert.deepEqual(phone.live('transactions').map((t) => t.id).sort(), ['c1', 'p1']);
  assert.deepEqual(pc.live('transactions').map((t) => t.id).sort(), ['c1', 'p1']);
  assert.equal(phone.live('categories').length, L.defaultCategories().length);

  // Без изменений — ни одной лишней записи в репозиторий (нет «пинг-понга»)
  const writes = gh.writes;
  assert.equal((await phone.syncWith(gh)).pushed, false);
  assert.equal((await pc.syncWith(gh)).pushed, false);
  assert.equal(gh.writes, writes);
});

test('синхронизация: удаление и правка на разных устройствах', async () => {
  const gh = fakeRemote();
  const phone = device('iPhone');
  const pc = device('Windows');
  phone.put('transactions', tx('a', 100, 1000));
  phone.put('transactions', tx('b', 100, 1000));
  await phone.syncWith(gh);
  await pc.syncWith(gh);

  phone.remove('transactions', 'a', 2000); // удалили на телефоне
  pc.put('transactions', tx('b', 999, 2500)); // поправили на компе
  await phone.syncWith(gh);
  await pc.syncWith(gh);
  await phone.syncWith(gh);

  for (const d of [phone, pc]) {
    assert.deepEqual(d.live('transactions').map((t) => [t.id, t.amount]), [['b', 999]], d.name);
    assert.equal(d.get('transactions', 'a').deleted, true, 'надгробие осталось');
  }
});

test('синхронизация: одновременная запись → конфликт → повтор без потерь', async () => {
  const gh = fakeRemote();
  const phone = device('iPhone');
  const pc = device('Windows');
  await phone.syncWith(gh);
  await pc.syncWith(gh);
  phone.put('transactions', tx('p', 1, 3000));
  pc.put('transactions', tx('c', 2, 3001));
  // Телефон прочитал файл, но пока он писал, успел записать компьютер
  gh.beforeWrite = () => pc.syncWith(gh);
  const res = await phone.syncWith(gh);
  assert.equal(res.pushed, true);
  await pc.syncWith(gh);
  const remote = L.parseSyncData(gh.text).transactions.map((t) => t.id).sort();
  assert.deepEqual(remote, ['c', 'p']);
  assert.deepEqual(pc.live('transactions').map((t) => t.id).sort(), ['c', 'p']);
});

test('синхронизация: 304 без локальных изменений — ничего не пишем', async () => {
  const gh = fakeRemote();
  const phone = device('iPhone');
  phone.put('transactions', tx('a', 1, 1));
  await phone.syncWith(gh);
  await phone.syncWith(gh); // получили etag
  const writes = gh.writes;
  const res = await phone.syncWith(gh);
  assert.equal(res.pushed, false);
  assert.equal(gh.writes, writes);
  phone.put('transactions', tx('b', 1, 2));
  assert.equal((await phone.syncWith(gh)).pushed, true, '304 + локальная правка → запись');
});

test('синхронизация: повреждённый файл в репо не перезаписывается', async () => {
  const gh = fakeRemote();
  gh.text = '{"oops": true}';
  gh.sha = 's0';
  const phone = device('iPhone');
  phone.put('transactions', tx('a', 1, 1));
  await assert.rejects(phone.syncWith(gh), /посторонний/);
  assert.equal(gh.text, '{"oops": true}');
});
