// Чистая логика без DOM и IndexedDB — её покрывают тесты (npm test).
// Деньги везде хранятся в копейках (целые числа), даты — строками 'YYYY-MM-DD'
// в локальном часовом поясе, месяцы — 'YYYY-MM'.

export const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_DAT = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export const TYPES = new Set(['expense', 'income']);
export const DEBT_DIRECTIONS = new Set(['lent', 'owe']); // lent — мне должны, owe — я должен
export const PERIODS = new Set(['monthly', 'yearly']);

// ---------- Даты ----------

export const pad2 = (n) => String(n).padStart(2, '0');
export const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const todayISO = (now = new Date()) => toISODate(now);
export const monthKey = (iso) => iso.slice(0, 7);
export const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
export const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

export function addDays(iso, n) {
  const { y, m, d } = parseISO(iso);
  return toISODate(new Date(y, m - 1, d + n));
}

export function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad2((idx % 12) + 1)}`;
}

export function monthTitle(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function dayTitle(iso, today) {
  if (iso === today) return 'Сегодня';
  if (iso === addDays(today, -1)) return 'Вчера';
  const { y, m, d } = parseISO(iso);
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  const year = y !== parseISO(today).y ? ` ${y}` : '';
  return `${d} ${MONTHS_GEN[m - 1]}${year}, ${weekday}`;
}

export function shortDate(iso) {
  const { m, d } = parseISO(iso);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

// ---------- Деньги и числа ----------

export const MAX_AMOUNT = 99_999_999_999; // копейки, чуть меньше миллиарда рублей

// '1 234,56' → 123456; мусор, ноль и больше двух знаков после запятой → null
export function parseAmount(input) {
  const s = String(input ?? '').replace(/[\s\u00a0\u202f₽]/g, '').replace(',', '.');
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(s)) return null;
  const kop = Math.round(Number(s) * 100);
  return kop > 0 && kop <= MAX_AMOUNT ? kop : null;
}

export function amountToInput(kop) {
  return kop % 100 === 0 ? String(kop / 100) : (kop / 100).toFixed(2).replace('.', ',');
}

const fmt0 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCompact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });

export function formatMoney(kop, { sign = false } = {}) {
  const abs = Math.abs(kop);
  const body = (abs % 100 === 0 ? fmt0 : fmt2).format(abs / 100);
  const prefix = kop < 0 ? '−' : sign && kop > 0 ? '+' : '';
  return `${prefix}${body}\u00a0₽`;
}

// Подписи осей: 12 тыс., 1,5 млн
export const formatCompact = (rub) => fmtCompact.format(rub);

export function formatPercent(fraction) {
  const p = fraction * 100;
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b > 1 && b < 5) return few;
  return many;
}

// Круглые деления оси от нуля: шаг 1/2/2.5/5 × 10^k, последний ≥ max
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * pow).find((s) => s >= raw);
  const n = Math.ceil(max / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => i * step);
}

// ---------- Агрегаты ----------

export const inMonth = (txs, key) => txs.filter((t) => t.date.startsWith(`${key}-`));

export function summarize(txs) {
  let expense = 0;
  let income = 0;
  for (const t of txs) {
    if (t.type === 'income') income += t.amount;
    else expense += t.amount;
  }
  return { expense, income, balance: income - expense };
}

export function byCategory(txs, type) {
  const map = new Map();
  for (const t of txs) {
    if (t.type !== type) continue;
    const e = map.get(t.categoryId) ?? { categoryId: t.categoryId, total: 0, count: 0 };
    e.total += t.amount;
    e.count += 1;
    map.set(t.categoryId, e);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export function byDay(txs, key, type) {
  const [y, m] = key.split('-').map(Number);
  const out = new Array(daysInMonth(y, m)).fill(0);
  for (const t of txs) {
    if (t.type === type && t.date.startsWith(`${key}-`)) out[Number(t.date.slice(8, 10)) - 1] += t.amount;
  }
  return out;
}

export function byMonth(txs, endKey, count) {
  const rows = Array.from({ length: count }, (_, i) => ({ month: shiftMonth(endKey, i - count + 1), expense: 0, income: 0 }));
  const idx = new Map(rows.map((r, i) => [r.month, i]));
  for (const t of txs) {
    const i = idx.get(t.date.slice(0, 7));
    if (i !== undefined) rows[i][t.type === 'income' ? 'income' : 'expense'] += t.amount;
  }
  return rows;
}

// Группы по дням, свежие сверху; внутри дня — последние добавленные сверху
export function groupByDate(txs) {
  const map = new Map();
  for (const t of txs) {
    if (!map.has(t.date)) map.set(t.date, []);
    map.get(t.date).push(t);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, items]) => ({ date, items: items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)), ...summarize(items) }));
}

export const percentChange = (cur, prev) => (prev > 0 ? (cur - prev) / prev : null);

// Для текущего месяца сравниваем с тем же отрезком прошлого (1–N число),
// иначе 3 сентября выглядело бы как «−90% к августу»
export function comparePeriods(txs, key, today) {
  const prevKey = shiftMonth(key, -1);
  const partialDay = key === monthKey(today) ? parseISO(today).d : null;
  const prevTxs = inMonth(txs, prevKey).filter((t) => partialDay === null || Number(t.date.slice(8, 10)) <= partialDay);
  return { cur: summarize(inMonth(txs, key)), prev: summarize(prevTxs), prevKey, partialDay };
}

// Делитель для «в среднем в день»: в текущем месяце — прошедшие дни
export function daysForAverage(key, today) {
  if (key === monthKey(today)) return parseISO(today).d;
  const [y, m] = key.split('-').map(Number);
  return daysInMonth(y, m);
}

// ---------- Регулярные платежи ----------
// Якорный день берётся из startDate; если в месяце его нет (31 февраля),
// платёж ставится на последний день месяца.

export function nthOccurrence(startISO, period, k) {
  const { y, m, d } = parseISO(startISO);
  const idx = y * 12 + (m - 1) + k * (period === 'yearly' ? 12 : 1);
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${pad2(nm)}-${pad2(Math.min(d, daysInMonth(ny, nm)))}`;
}

// Даты, которые пора записать: после lastDate и не позже untilISO
export function dueOccurrences(rule, untilISO, limit = 1200) {
  const out = [];
  for (let k = 0; k < limit; k++) {
    const date = nthOccurrence(rule.startDate, rule.period, k);
    if (date > untilISO) break;
    if (!rule.lastDate || date > rule.lastDate) out.push(date);
  }
  return out;
}

export function nextOccurrence(rule, todayIso, limit = 1200) {
  for (let k = 0; k < limit; k++) {
    const date = nthOccurrence(rule.startDate, rule.period, k);
    if (date > todayIso && (!rule.lastDate || date > rule.lastDate)) return date;
  }
  return null;
}

export const monthlyEquivalent = (rule) => (rule.period === 'yearly' ? Math.round(rule.amount / 12) : rule.amount);

export function periodTitle(rule) {
  const { m, d } = parseISO(rule.startDate);
  return rule.period === 'yearly' ? `каждый год, ${d} ${MONTHS_GEN[m - 1]}` : `каждый месяц, ${d}-го`;
}

// ---------- Категории ----------

export const OTHER_CATEGORY = { expense: 'exp-other', income: 'inc-other' };
const isOther = (c) => c.id === OTHER_CATEGORY[c.type];

const DEFAULTS = [
  ['exp-food', 'expense', 'Продукты', '🛒'],
  ['exp-cafe', 'expense', 'Кафе и рестораны', '🍔'],
  ['exp-transport', 'expense', 'Транспорт', '🚕'],
  ['exp-home', 'expense', 'Дом и ЖКХ', '🏠'],
  ['exp-phone', 'expense', 'Связь и интернет', '📱'],
  ['exp-health', 'expense', 'Здоровье', '💊'],
  ['exp-clothes', 'expense', 'Одежда', '👕'],
  ['exp-fun', 'expense', 'Развлечения', '🎬'],
  ['exp-subs', 'expense', 'Подписки', '🔁'],
  ['exp-gifts', 'expense', 'Подарки', '🎁'],
  ['exp-travel', 'expense', 'Путешествия', '✈️'],
  ['exp-other', 'expense', 'Другое', '📦'],
  ['inc-salary', 'income', 'Зарплата', '💼'],
  ['inc-side', 'income', 'Подработка', '💻'],
  ['inc-gifts', 'income', 'Подарки', '🎁'],
  ['inc-cashback', 'income', 'Кэшбэк и проценты', '💸'],
  ['inc-other', 'income', 'Другое', '📦'],
];

export const defaultCategories = () => DEFAULTS.map(([id, type, name, emoji], order) => ({ id, type, name, emoji, order }));

// «Другое» всегда последней — туда переезжают операции удалённых категорий
export const sortCategories = (cats) => [...cats].sort((a, b) => isOther(a) - isOther(b) || a.order - b.order);

export function withRequiredCategories(cats) {
  const out = [...cats];
  for (const def of defaultCategories()) {
    if (isOther(def) && !out.some((c) => c.id === def.id)) out.push({ ...def, order: 1000 });
  }
  return out;
}

// ---------- Экспорт / импорт ----------

// CSV для Excel с русской локалью: разделитель «;», запятая в дробях, BOM для UTF-8.
// Расходы со знаком минус, чтобы суммирование столбца давало баланс.
export function toCSV(txs, categories) {
  const cats = new Map(categories.map((c) => [c.id, c]));
  const text = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // защита от формул в Excel
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['Дата', 'Тип', 'Категория', 'Сумма', 'Комментарий'].join(';')];
  const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const t of sorted) {
    const sum = `${t.type === 'income' ? '' : '-'}${(t.amount / 100).toFixed(2).replace('.', ',')}`;
    rows.push([t.date, t.type === 'income' ? 'Доход' : 'Расход', text(cats.get(t.categoryId)?.name), sum, text(t.note)].join(';'));
  }
  return `﻿${rows.join('\r\n')}`;
}

export const BACKUP_FORMAT = 'treker-rashodov-backup';

export function makeBackup({ transactions, categories, recurring, debts = [], presets = [] }, now = new Date()) {
  return { format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), transactions, categories, recurring, debts, presets };
}

// Проверки записей — общие для резервной копии и файла синхронизации
const isAmount = (a) => Number.isInteger(a) && a > 0 && a <= MAX_AMOUNT;
const isId = (s) => typeof s === 'string' && s.length > 0;
const VALIDATORS = {
  transactions: (t) => isId(t?.id) && TYPES.has(t.type) && isAmount(t.amount) && isISODate(t.date) && isId(t.categoryId),
  categories: (c) => isId(c?.id) && typeof c.name === 'string' && TYPES.has(c.type),
  recurring: (r) => isId(r?.id) && TYPES.has(r.type) && isAmount(r.amount) && isISODate(r.startDate) && PERIODS.has(r.period) && isId(r.categoryId),
  debts: (d) => isId(d?.id) && DEBT_DIRECTIONS.has(d.direction) && typeof d.person === 'string' && d.person.trim() !== ''
    && isAmount(d.amount) && isISODate(d.date) && (d.dueDate == null || isISODate(d.dueDate))
    && (d.payments ?? []).every((p) => isId(p?.id) && isAmount(p.amount) && isISODate(p.date))
    && (d.removedPayments ?? []).every(isId),
  presets: (p) => isId(p?.id) && typeof p.label === 'string' && p.label.trim() !== '' && TYPES.has(p.type) && isId(p.categoryId)
    && Array.isArray(p.amounts) && p.amounts.length >= 1 && p.amounts.length <= MAX_PRESET_AMOUNTS && p.amounts.every(isAmount),
};
const RECORD_NAMES = { transactions: 'операция', categories: 'категория', recurring: 'регулярный платёж', debts: 'долг', presets: 'быстрая кнопка' };

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл не читается как JSON.');
  }
  if (data?.format !== BACKUP_FORMAT) throw new Error('Это не резервная копия трекера расходов.');
  if (data.version > 1) throw new Error('Копия сделана более новой версией приложения — обнови страницу.');
  // в старых копиях долгов и быстрых кнопок нет
  const { transactions, categories, recurring = [], debts = [], presets = [] } = data;
  const lists = { transactions, categories, recurring, debts, presets };
  if (!Object.values(lists).every(Array.isArray)) throw new Error('Копия повреждена.');
  for (const name of Object.keys(lists)) {
    const i = lists[name].findIndex((r) => !VALIDATORS[name](r));
    if (i >= 0) throw new Error(`Копия повреждена: ${RECORD_NAMES[name]} №${i + 1}.`);
  }
  return lists;
}

// ---------- Синхронизация: слияние записей ----------
// У каждой записи есть updatedAt (мс). Удаление хранится «надгробием»
// { id, deleted: true, updatedAt }, иначе удалённое на одном устройстве
// вернулось бы с другого. При конфликте побеждает более свежая версия.

export const SYNC_STORES = ['transactions', 'categories', 'recurring', 'debts', 'presets'];
const OPTIONAL_STORES = new Set(['debts', 'presets']); // появились позже — в старых файлах их нет
export const SYNC_FORMAT = 'treker-rashodov-sync';

export const stampOf = (r) => r.updatedAt ?? r.createdAt ?? 0;
export const isTombstone = (r) => isId(r?.id) && r.deleted === true && Number.isFinite(r.updatedAt);

// Ключ для сравнения записей без учёта порядка полей и undefined
export function recordKey(r) {
  return JSON.stringify(Object.keys(r).filter((k) => r[k] !== undefined).sort().map((k) => [k, r[k]]));
}

// Должна ли версия b заменить версию a
export function isNewer(b, a) {
  const sb = stampOf(b);
  const sa = stampOf(a);
  if (sb !== sa) return sb > sa;
  if (Boolean(b.deleted) !== Boolean(a.deleted)) return Boolean(b.deleted);
  return recordKey(b) > recordKey(a); // ничья решается одинаково на всех устройствах
}

const maxDate = (x, y) => (!x ? y ?? null : !y ? x : x > y ? x : y);

const unionById = (x = [], y = []) => [...new Map([...x, ...y].map((p) => [p.id, p])).values()].sort((p, q) => (p.date + p.id < q.date + q.id ? -1 : 1));

// Итог слияния двух версий одной записи. У правил регулярных платежей
// lastDate берётся максимальный, чтобы платёж не записался второй раз.
// У долгов возвраты объединяются: внесённые на двух устройствах не теряются.
export function resolveRecord(a, b, store) {
  let winner = isNewer(b, a) ? b : a;
  if (store === 'recurring' && !a.deleted && !b.deleted) {
    const lastDate = maxDate(a.lastDate, b.lastDate);
    if ((winner.lastDate ?? null) !== lastDate) winner = { ...winner, lastDate };
  }
  if (store === 'debts' && !a.deleted && !b.deleted) {
    const payments = unionById(a.payments, b.payments);
    const removed = [...new Set([...(a.removedPayments ?? []), ...(b.removedPayments ?? [])])].sort();
    const merged = { ...winner, payments, removedPayments: removed };
    if (recordKey(merged) !== recordKey(winner)) winner = merged;
  }
  return winner;
}

// toLocal — что записать у себя; remoteStale — нужно ли отправить своё на сервер
export function mergeStore(local, remote, store) {
  const localById = new Map(local.map((r) => [r.id, r]));
  const seen = new Set();
  const toLocal = [];
  let remoteStale = false;
  for (const r of remote) {
    seen.add(r.id);
    const l = localById.get(r.id);
    const merged = l ? resolveRecord(l, r, store) : r;
    if (!l || recordKey(merged) !== recordKey(l)) toLocal.push(merged);
    if (recordKey(merged) !== recordKey(r)) remoteStale = true;
  }
  if (!remoteStale) remoteStale = local.some((l) => !seen.has(l.id));
  return { toLocal, remoteStale };
}

// По записи на строку и в стабильном порядке — история в GitHub читается как дифф
export function serializeSync(data, now = new Date()) {
  const order = (a, b) => ((a.date ?? '') + a.id < (b.date ?? '') + b.id ? -1 : 1);
  const block = (name) => `"${name}": [\n${[...(data[name] ?? [])].sort(order).map((r) => JSON.stringify(r)).join(',\n')}\n]`;
  return `{"format": "${SYNC_FORMAT}", "version": 1, "savedAt": "${now.toISOString()}",\n${SYNC_STORES.map(block).join(',\n')}\n}\n`;
}

export function parseSyncData(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл синхронизации в репозитории повреждён (не JSON).');
  }
  if (data?.format !== SYNC_FORMAT) throw new Error('В репозитории лежит посторонний файл rashody.json — выбери другой репозиторий.');
  if (data.version > 1) throw new Error('Данные записаны более новой версией приложения — обнови страницу.');
  for (const name of SYNC_STORES) {
    if (data[name] === undefined && OPTIONAL_STORES.has(name)) data[name] = [];
    if (!Array.isArray(data[name])) throw new Error('Файл синхронизации повреждён.');
    const i = data[name].findIndex((r) => !(isTombstone(r) || VALIDATORS[name](r)));
    if (i >= 0) throw new Error(`Файл синхронизации повреждён: ${RECORD_NAMES[name]} №${i + 1}.`);
  }
  return data;
}

// Ключ подключения устройства: репозиторий + токен одной строкой (для QR и копирования)
const KEY_PREFIX = 'treker1';
export const isRepo = (s) => typeof s === 'string' && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s);
export const isToken = (s) => typeof s === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(s);

export function normalizeRepo(input) {
  return String(input ?? '').trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

export const makeSyncKey = ({ repo, token }) => `${KEY_PREFIX}|${repo}|${token}`;

export function parseSyncKey(input) {
  const parts = String(input ?? '').trim().split('|');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return null;
  const [, repo, token] = parts;
  return isRepo(repo) && isToken(token) ? { repo, token } : null;
}

export function deviceName(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'устройство';
}

// ---------- Долги ----------
// { id, direction: 'lent' | 'owe', person, amount, note, date, dueDate?, payments: [{ id, amount, date }], removedPayments: [id] }
// Возвраты хранятся списком внутри долга; удалённый возврат помечается в removedPayments,
// чтобы при синхронизации он не вернулся с другого устройства.

export const livePayments = (d) => {
  const removed = new Set(d.removedPayments ?? []);
  return (d.payments ?? []).filter((p) => !removed.has(p.id));
};
export const debtPaid = (d) => livePayments(d).reduce((sum, p) => sum + p.amount, 0);
export const debtRemaining = (d) => Math.max(0, d.amount - debtPaid(d));
export const isDebtClosed = (d) => debtRemaining(d) === 0;
export const isDebtOverdue = (d, today) => !isDebtClosed(d) && Boolean(d.dueDate) && d.dueDate < today;

export function summarizeDebts(debts) {
  let lent = 0;
  let owe = 0;
  for (const d of debts) {
    if (d.direction === 'lent') lent += debtRemaining(d);
    else owe += debtRemaining(d);
  }
  return { lent, owe, net: lent - owe };
}

// Открытые: сначала просроченные, потом по сроку, без срока — в конце, свежие выше
export function sortDebts(debts, today) {
  const key = (d) => [isDebtOverdue(d, today) ? 0 : 1, d.dueDate ?? '9999-99-99', d.date];
  return [...debts].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0] - kb[0] || ka[1].localeCompare(kb[1]) || kb[2].localeCompare(ka[2]);
  });
}

// Имена людей для подсказки при вводе: самые частые сверху
export function debtPeople(debts) {
  const count = new Map();
  for (const d of debts) count.set(d.person, (count.get(d.person) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')).map(([name]) => name);
}

// ---------- Быстрые кнопки ----------
// { id, emoji, label, type, categoryId, amounts: [копейки…], note, order }
// Одна сумма — запись в один тап; несколько — выбор из них.

export const MAX_PRESET_AMOUNTS = 8;

// «200, 300, 400» или «200 / 300»; запятая без пробела — это копейки: «99,90»
export function parseAmounts(input) {
  const parts = String(input ?? '').split(/\s*[;/|]\s*|,\s+|\s{2,}/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_PRESET_AMOUNTS) return null;
  const amounts = parts.map(parseAmount);
  return amounts.every(Boolean) ? amounts : null;
}

export const formatAmounts = (amounts) => amounts.map(amountToInput).join(', ');

export const sortPresets = (presets) => [...presets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label, 'ru'));

// ---------- Сводка для ИИ ----------
// Только агрегаты: имена из долгов не уходят никогда, комментарии — по желанию.

export const AI_PROMPT = `Ты — внимательный финансовый аналитик. Ниже сводка моих личных расходов и доходов из трекера (валюта — рубли). Разбери её и ответь по-русски, кратко и по делу, без морализаторства:

1. Итог месяца в 3–5 пунктах: сколько потрачено, куда ушло больше всего, как это соотносится с доходами.
2. Что заметно выросло или упало по сравнению с прошлыми месяцами — с цифрами и процентами.
3. Необычные или крупные разовые траты, на которые стоит обратить внимание.
4. Частые мелкие траты: сколько они съедают за месяц и как их сократить.
5. Регулярные платежи и подписки: что выглядит лишним или дорогим.
6. Три конкретных совета на следующий месяц с оценкой экономии в рублях.
7. Реалистичный лимит на следующий месяц по основным категориям.

Если месяц ещё не закончился или данных мало — учитывай это и не делай поспешных выводов.`;

const pct = (cur, prev) => {
  const p = percentChange(cur, prev);
  return p === null ? '' : ` (${p >= 0 ? '+' : '−'}${Math.round(Math.abs(p) * 100)}% к прошлому)`;
};

export function aiSummary(data, { month, today, includeNotes = false, months = 3 }) {
  const { transactions, categories, recurring = [], debts = [] } = data;
  const cats = new Map(categories.map((c) => [c.id, c.name]));
  const catName = (id) => cats.get(id) ?? 'Без категории';
  // Прошлые месяцы без единой записи — шум, их не показываем
  const keys = Array.from({ length: months }, (_, i) => shiftMonth(month, i - months + 1))
    .filter((key) => key === month || inMonth(transactions, key).length > 0);
  const current = month === monthKey(today);
  const title = (key) => monthTitle(key).toLowerCase();
  const money = (kop) => formatMoney(kop).replace(/\u00a0/g, ' ');
  const rub = (kop) => money(Math.round(kop / 100) * 100); // средние — без копеек
  const lines = [];

  const compare = keys.length > 1 ? `; для сравнения — ${keys.slice(0, -1).map(title).join(' и ')}` : '; прошлых месяцев для сравнения нет';
  lines.push(`Период: ${title(month)}${current ? ` (данные по ${parseISO(today).d} число — месяц ещё идёт)` : ''}${compare}.`);

  lines.push('', 'Итоги по месяцам:');
  const sums = keys.map((key) => ({ key, ...summarize(inMonth(transactions, key)) }));
  for (const r of sums) {
    const days = daysForAverage(r.key, today);
    lines.push(`- ${monthTitle(r.key)}: расходы ${money(r.expense)}, доходы ${money(r.income)}, баланс ${formatMoney(r.balance, { sign: true }).replace(/\u00a0/g, ' ')}, в среднем ${rub(r.expense / days)} в день`);
  }

  const expenseByCat = keys.map((key) => new Map(byCategory(inMonth(transactions, key), 'expense').map((e) => [e.categoryId, e.total])));
  const catIds = [...new Set(expenseByCat.flatMap((mp) => [...mp.keys()]))]
    .sort((a, b) => (expenseByCat.at(-1).get(b) ?? 0) - (expenseByCat.at(-1).get(a) ?? 0));
  if (catIds.length) {
    lines.push('', `Расходы по категориям (${keys.map((k) => MONTHS_SHORT[Number(k.slice(5)) - 1]).join(' / ')}):`);
    for (const id of catIds) {
      const vals = expenseByCat.map((mp) => mp.get(id) ?? 0);
      lines.push(`- ${catName(id)}: ${vals.map((v) => money(v)).join(' / ')}${pct(vals.at(-1), vals.at(-2))}`);
    }
  }

  const monthTx = inMonth(transactions, month);
  const incomeCats = byCategory(monthTx, 'income');
  if (incomeCats.length) {
    lines.push('', `Доходы за ${title(month)}:`);
    for (const e of incomeCats) lines.push(`- ${catName(e.categoryId)}: ${money(e.total)}`);
  }

  const expenses = monthTx.filter((t) => t.type === 'expense');
  // Частые траты: по комментарию (если можно) или по категории
  const groupKey = (t) => (includeNotes && t.note ? `${catName(t.categoryId)} — «${t.note}»` : catName(t.categoryId));
  const freq = new Map();
  for (const t of expenses) {
    if (t.recurringId) continue;
    const e = freq.get(groupKey(t)) ?? { count: 0, total: 0, max: 0 };
    e.count += 1;
    e.total += t.amount;
    e.max = Math.max(e.max, t.amount);
    freq.set(groupKey(t), e);
  }
  const frequent = [...freq.entries()].filter(([, e]) => e.count >= 3).sort((a, b) => b[1].total - a[1].total).slice(0, 10);

  // Крупные разовые: без однотипных мелких, которые уже посчитаны как частые
  const small = new Set(frequent.filter(([, e]) => e.max <= (e.total / e.count) * 1.5).map(([key]) => key));
  const top = expenses.filter((t) => !small.has(groupKey(t))).sort((a, b) => b.amount - a.amount).slice(0, 7);
  if (top.length) {
    lines.push('', `Крупнейшие расходы за ${title(month)}:`);
    for (const t of top) lines.push(`- ${shortDate(t.date)}, ${catName(t.categoryId)}: ${money(t.amount)}${includeNotes && t.note ? ` — «${t.note}»` : ''}${t.recurringId ? ' (регулярный)' : ''}`);
  }

  if (frequent.length) {
    lines.push('', `Частые траты за ${title(month)} (от 3 раз):`);
    for (const [key, e] of frequent) lines.push(`- ${key}: ${e.count} раз, в среднем ${rub(e.total / e.count)}, всего ${money(e.total)}`);
  }

  const rules = recurring.filter((r) => r.active && r.type === 'expense');
  if (rules.length) {
    lines.push('', 'Регулярные платежи (активные):');
    for (const r of rules) lines.push(`- ${catName(r.categoryId)}${includeNotes && r.note ? ` «${r.note}»` : ''}: ${money(r.amount)} ${r.period === 'yearly' ? 'в год' : 'в месяц'}`);
    lines.push(`Итого регулярных расходов ≈ ${money(rules.reduce((sum, r) => sum + monthlyEquivalent(r), 0))} в месяц.`);
  }

  const open = debts.filter((d) => !isDebtClosed(d));
  if (open.length) {
    const s = summarizeDebts(open);
    const overdue = open.filter((d) => isDebtOverdue(d, today)).length;
    lines.push('', `Долги (открытые, без имён): мне должны ${money(s.lent)}, я должен ${money(s.owe)}${overdue ? `, просрочено: ${overdue}` : ''}.`);
  }

  return `${AI_PROMPT}\n\nДанные:\n${lines.join('\n')}\n`;
}
