// Чистая логика без DOM и IndexedDB — её покрывают тесты (npm test).
// Деньги везде хранятся в копейках (целые числа), даты — строками 'YYYY-MM-DD'
// в локальном часовом поясе, месяцы — 'YYYY-MM'.

export const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_DAT = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export const TYPES = new Set(['expense', 'income']);
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
  const s = String(input ?? '').replace(/[\s  ₽]/g, '').replace(',', '.');
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
  return `${prefix}${body} ₽`;
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

export function makeBackup({ transactions, categories, recurring }, now = new Date()) {
  return { format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), transactions, categories, recurring };
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Файл не читается как JSON.');
  }
  if (data?.format !== BACKUP_FORMAT) throw new Error('Это не резервная копия трекера расходов.');
  if (data.version > 1) throw new Error('Копия сделана более новой версией приложения — обнови страницу.');
  const { transactions, categories, recurring = [] } = data;
  if (![transactions, categories, recurring].every(Array.isArray)) throw new Error('Копия повреждена.');

  const bad = (what, i) => new Error(`Копия повреждена: ${what} №${i + 1}.`);
  const isAmount = (a) => Number.isInteger(a) && a > 0 && a <= MAX_AMOUNT;
  const isId = (s) => typeof s === 'string' && s.length > 0;
  categories.forEach((c, i) => {
    if (!isId(c?.id) || typeof c.name !== 'string' || !TYPES.has(c.type)) throw bad('категория', i);
  });
  transactions.forEach((t, i) => {
    if (!isId(t?.id) || !TYPES.has(t.type) || !isAmount(t.amount) || !isISODate(t.date) || !isId(t.categoryId)) throw bad('операция', i);
  });
  recurring.forEach((r, i) => {
    if (!isId(r?.id) || !TYPES.has(r.type) || !isAmount(r.amount) || !isISODate(r.startDate) || !PERIODS.has(r.period) || !isId(r.categoryId)) {
      throw bad('регулярный платёж', i);
    }
  });
  return { transactions, categories, recurring };
}
