// Синхронизация через файл в приватном GitHub-репозитории пользователя.
// Сервера у приложения нет: каждое устройство само читает файл, сливает его
// со своими данными и, если нужно, записывает обратно (с проверкой sha,
// чтобы не затереть одновременную запись другого устройства).
import { SYNC_STORES, mergeStore, parseSyncData, serializeSync } from './logic.js';

export const SYNC_FILE = 'rashody.json';
const API = 'https://api.github.com';

export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// Заголовки только из списка, который GitHub разрешает для CORS
// (X-GitHub-Api-Version не шлём — по умолчанию и так актуальная версия)
export function createGitHubClient({ repo, token, api = API, path = SYNC_FILE, fetchImpl = (...a) => fetch(...a) }) {
  const fileUrl = `${api}/repos/${repo}/contents/${path}`;

  async function call(url, { headers, ...init } = {}) {
    try {
      return await fetchImpl(url, {
        cache: 'no-store',
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...headers },
      });
    } catch {
      throw new SyncError('network', 'Нет связи с GitHub');
    }
  }

  async function fail(res) {
    let message = '';
    try {
      message = (await res.json()).message ?? '';
    } catch {
      /* тело не JSON */
    }
    if (res.status === 401) throw new SyncError('auth', 'Токен не подходит: он истёк или отозван. Создай новый.');
    if (res.status === 403 && /rate limit/i.test(message)) throw new SyncError('rate', 'GitHub временно ограничил запросы, повторю позже.');
    if (res.status === 403) throw new SyncError('forbidden', 'У токена нет права записи: нужно Contents → Read and write.');
    if (res.status === 404) throw new SyncError('not-found', 'Репозиторий не найден или у токена нет к нему доступа.');
    if (res.status === 409 || res.status === 422) throw new SyncError('conflict', 'Данные одновременно изменились на другом устройстве.');
    throw new SyncError('http', `GitHub ответил ${res.status}${message ? `: ${message}` : ''}`);
  }

  return {
    // Проверка при подключении: репозиторий доступен и он приватный
    async checkRepo() {
      const res = await call(`${api}/repos/${repo}`);
      if (!res.ok) await fail(res);
      const info = await res.json();
      if (!info.private) {
        throw new SyncError('public', 'Репозиторий публичный — твои расходы увидят все. Сделай его приватным: Settings → Danger Zone → Change visibility.');
      }
      return info;
    },

    // { notModified } | { sha, text, etag }; файла ещё нет → sha и text = null
    async read(etag) {
      const res = await call(fileUrl, etag ? { headers: { 'If-None-Match': etag } } : {});
      if (res.status === 304) return { notModified: true };
      if (res.status === 404) return { sha: null, text: null, etag: null };
      if (!res.ok) await fail(res);
      const body = await res.json();
      let text;
      if (body.encoding === 'base64') {
        text = fromBase64(body.content);
      } else {
        // Файлы больше 1 МБ API отдаёт без содержимого — забираем «сырым»
        const raw = await call(fileUrl, { headers: { Accept: 'application/vnd.github.raw+json' } });
        if (!raw.ok) await fail(raw);
        text = await raw.text();
      }
      return { sha: body.sha, text, etag: res.headers.get('ETag') };
    },

    async write(text, sha, message) {
      const res = await call(fileUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content: toBase64(text), ...(sha ? { sha } : {}) }),
      });
      if (!res.ok) await fail(res);
      return (await res.json()).content.sha;
    },
  };
}

/**
 * Один цикл синхронизации.
 * local.getAll() → { transactions, categories, recurring } вместе с «надгробиями»;
 * local.apply(changes) записывает пришедшие версии и возвращает, сколько записей реально изменилось.
 * etag/sha — от прошлой синхронизации; dirty — есть ли локальные изменения после неё.
 */
export async function syncOnce({ client, local, etag = null, sha = null, dirty = true, deviceName = 'устройство', sleep }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let pulled = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await wait(400 * 2 ** attempt);
    const remote = await client.read(attempt ? null : etag);
    let remoteSha = sha;
    let remoteStale = dirty;
    if (!remote.notModified) {
      remoteSha = remote.sha;
      etag = remote.etag;
      const data = remote.text ? parseSyncData(remote.text) : null; // битый файл — ошибка, ничего не пишем
      const mine = await local.getAll();
      const changes = {};
      remoteStale = !data;
      for (const name of SYNC_STORES) {
        const res = mergeStore(mine[name], data?.[name] ?? [], name);
        if (res.toLocal.length) changes[name] = res.toLocal;
        if (res.remoteStale) remoteStale = true;
      }
      if (Object.keys(changes).length) pulled += await local.apply(changes);
    }
    if (!remoteStale) return { etag, sha: remoteSha, pulled, pushed: false };
    try {
      const newSha = await client.write(serializeSync(await local.getAll()), remoteSha, `Синхронизация: ${deviceName}`);
      return { etag: null, sha: newSha, pulled, pushed: true };
    } catch (err) {
      if (err.code !== 'conflict') throw err;
      // Другое устройство успело записать — перечитываем и сливаем заново
    }
  }
  throw new SyncError('conflict', 'Не получилось договориться с другим устройством — повторю позже.');
}
