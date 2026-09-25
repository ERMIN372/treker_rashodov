import { db } from './db.js';
import * as L from './logic.js';
import { columnChart } from './charts.js';
import { createGitHubClient, syncOnce } from './sync.js';
import * as Lock from './lock.js';

// При деплое метка заменяется на короткий хэш коммита (см. .github/workflows/pages.yml).
// Сравнивать с самой меткой нельзя — sed заменит и её, поэтому проверяем префикс.
const APP_BUILD = '__BUILD__';
const IS_DEV = APP_BUILD.startsWith('__');

const SERIES_COLOR = { expense: 'var(--s-expense)', income: 'var(--s-income)' };
const TYPE_LABEL = { expense: 'Расход', income: 'Доход' };
const TITLES = { list: 'Операции', stats: 'Статистика', recurring: 'Регулярные', debts: 'Долги', settings: 'Настройки' };
const TX_FORMS = ['операция', 'операции', 'операций'];
const BACKUP_EVERY_MS = 30 * 24 * 3600 * 1000;
const SNOOZE_MS = 7 * 24 * 3600 * 1000;

const state = {
  transactions: [],
  categories: [],
  recurring: [],
  debts: [],
  presets: [],
  debtFilter: 'open',
  month: L.monthKey(L.todayISO()),
  tab: 'list',
  statsType: 'expense',
  catType: 'expense',
  filterCategory: null,
  lastBackup: null,
  backupSnooze: null,
  // id удалённых записей: удаления хранятся «надгробиями» ради синхронизации
  tombstones: Object.fromEntries(L.SYNC_STORES.map((s) => [s, new Set()])),
};

// ---------- DOM-хелперы ----------

const $ = (sel) => document.querySelector(sel);
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden']);
const clean = (children) => children.flat(Infinity).filter((c) => c != null && c !== false && c !== '');

// replaceChildren сам не пропускает null и не разворачивает массивы
const mount = (el, ...children) => el.replaceChildren(...clean(children));

// Текст всегда вставляется как текстовые узлы — никакого innerHTML с данными
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...clean(children));
  return el;
}

const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

function removeById(list, id) {
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
}

// ---------- Данные ----------

// Единая точка записи: ставит время изменения, удаление превращает в «надгробие»,
// обновляет состояние и планирует синхронизацию.
// ops: [{ store, put: запись } | { store, delete: запись }]; stamp: false — не трогать updatedAt
async function persist(ops, { stamp = true } = {}) {
  const now = Date.now();
  const writes = ops.map(({ store, put, delete: del }) => ({
    store,
    put: del ? { id: del.id, deleted: true, updatedAt: now } : stamp ? { ...put, updatedAt: now } : put,
  }));
  await db.bulk(writes);
  for (const { store, put } of writes) {
    if (put.deleted) {
      removeById(state[store], put.id);
      state.tombstones[store].add(put.id);
    } else {
      upsert(state[store], put);
      state.tombstones[store].delete(put.id);
    }
  }
  markSyncDirty();
}

// Все записи вместе с «надгробиями» — в таком виде их видит синхронизация
const localData = {
  async getAll() {
    const lists = await Promise.all(L.SYNC_STORES.map((s) => db.getAll(s)));
    return Object.fromEntries(L.SYNC_STORES.map((s, i) => [s, lists[i]]));
  },
  apply: (changes) => db.mergeIn(changes, (store, cur, incoming) => {
    const next = cur ? L.resolveRecord(cur, incoming, store) : incoming;
    return !cur || L.recordKey(next) !== L.recordKey(cur) ? next : null;
  }),
};

async function loadState() {
  const all = await localData.getAll();
  for (const name of L.SYNC_STORES) {
    state[name] = all[name].filter((r) => !r.deleted);
    state.tombstones[name] = new Set(all[name].filter((r) => r.deleted).map((r) => r.id));
  }
}

const catById = (id) => state.categories.find((c) => c.id === id) ?? { id, type: 'expense', name: 'Без категории', emoji: '❔' };
const catsOfType = (type) => L.sortCategories(state.categories.filter((c) => c.type === type));
const signedMoney = (t) => L.formatMoney(t.type === 'income' ? t.amount : -t.amount, { sign: true });

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function localGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* приватный режим — не страшно */
  }
}

// ---------- Тост ----------

let toastTimer;
function toast(text, action) {
  const el = $('#toast');
  mount(el,
    h('span', null, text),
    action && h('button', { type: 'button', onclick: () => { hideToast(); action.run(); } }, action.label),
  );
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2500);
}

function hideToast() {
  $('#toast').hidden = true;
}

// ---------- Шторка (форма поверх экрана) ----------

const sheet = $('#sheet');
let reloadWhenSheetCloses = false;
let renderWhenSheetCloses = false;

function openSheet({ title, body, onSave }) {
  let saving = false; // двойной тап по «Готово» не должен создать дубль
  const form = h('form', {
    class: 'sheet-form',
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (saving) return;
      saving = true;
      try {
        if ((await onSave()) !== false) closeSheet();
      } catch (err) {
        console.error(err);
        alert(`Не удалось сохранить: ${err?.message ?? err}`);
      } finally {
        saving = false;
      }
    },
  },
    h('header', { class: 'sheet-head' },
      h('button', { type: 'button', class: 'link-btn', onclick: closeSheet }, 'Отмена'),
      h('h2', { id: 'sheetTitle' }, title),
      h('button', { type: 'submit', class: 'link-btn strong' }, 'Готово')),
    h('div', { class: 'sheet-body' }, body));
  sheet.replaceChildren(form);
  if (!sheet.open) sheet.showModal(); // уже открыта — просто меняем содержимое
}

function closeSheet() {
  if (sheet.open) sheet.close();
}

sheet.addEventListener('click', (e) => e.target === sheet && closeSheet());
sheet.addEventListener('close', () => {
  stopScanner();
  sheet.replaceChildren();
  if (reloadWhenSheetCloses) location.reload();
  if (renderWhenSheetCloses) {
    renderWhenSheetCloses = false;
    render();
  }
});

// ---------- Элементы форм ----------

function segmented(options, value, onChange, label) {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const draw = (current) => wrap.replaceChildren(...options.map(([val, text]) => h('button', {
    type: 'button',
    role: 'radio',
    'aria-checked': String(val === current),
    onclick: () => {
      if (val === current) return;
      draw(val);
      onChange(val);
    },
  }, text)));
  draw(value);
  return wrap;
}

function field(label, ...controls) {
  return h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), ...controls);
}

function amountInput(kop) {
  const input = h('input', {
    class: 'amount-input',
    inputmode: 'decimal',
    autocomplete: 'off',
    enterkeyhint: 'done',
    placeholder: '0',
    'aria-label': 'Сумма в рублях',
    value: kop ? L.amountToInput(kop) : '',
  });
  const fit = () => { input.style.width = `${Math.max(1, input.value.length) + 0.5}ch`; };
  input.addEventListener('input', fit);
  fit();
  return { input, el: h('label', { class: 'amount-wrap' }, input, h('span', { class: 'amount-cur' }, '₽')) };
}

function categoryPicker(type, selectedId, onPick) {
  const grid = h('div', { class: 'cat-grid', role: 'radiogroup', 'aria-label': 'Категория' });
  const draw = (t, selected) => grid.replaceChildren(...catsOfType(t).map((c) => h('button', {
    type: 'button',
    role: 'radio',
    class: 'cat-chip',
    'aria-checked': String(c.id === selected),
    onclick: () => {
      draw(t, c.id);
      onPick(c.id);
    },
  }, h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, c.emoji), h('span', { class: 'cat-name' }, c.name))));
  draw(type, selectedId);
  return { el: grid, setType: (t) => draw(t, null) };
}

function dateInput(value) {
  return h('input', { type: 'date', class: 'input', value });
}

// ---------- Операции: добавление / правка / удаление ----------

function defaultDate() {
  const today = L.todayISO();
  return L.monthKey(today) === state.month ? today : `${state.month}-01`;
}

function openTxSheet(tx = null, preset = null) {
  const today = L.todayISO();
  const draft = { type: tx?.type ?? preset?.type ?? 'expense', categoryId: tx?.categoryId ?? preset?.categoryId ?? null };
  const amount = amountInput(tx?.amount);
  const err = h('p', { class: 'form-error', role: 'alert' });
  const picker = categoryPicker(draft.type, draft.categoryId, (id) => {
    draft.categoryId = id;
    err.textContent = '';
  });
  const date = dateInput(tx?.date ?? defaultDate());
  const note = h('input', { class: 'input', maxlength: 120, enterkeyhint: 'done', placeholder: 'Необязательно', value: tx?.note ?? preset?.note ?? '' });
  const quick = (label, iso) => h('button', { type: 'button', class: 'chip', onclick: () => { date.value = iso; } }, label);

  openSheet({
    title: tx ? 'Операция' : 'Новая операция',
    body: [
      segmented([['expense', 'Расход'], ['income', 'Доход']], draft.type, (t) => {
        draft.type = t;
        draft.categoryId = null;
        picker.setType(t);
      }, 'Тип операции'),
      amount.el,
      err,
      field('Категория', picker.el),
      field('Дата', h('div', { class: 'date-row' }, date, quick('Сегодня', today), quick('Вчера', L.addDays(today, -1)))),
      field('Комментарий', note),
      tx?.recurringId && h('p', { class: 'hint' }, '🔁 Записано автоматически из регулярного платежа'),
      tx && h('button', { type: 'button', class: 'danger-btn', onclick: () => deleteTx(tx) }, 'Удалить операцию'),
    ],
    onSave: async () => {
      const kop = L.parseAmount(amount.input.value);
      if (!kop) {
        err.textContent = 'Введи сумму больше нуля, максимум две цифры после запятой';
        amount.input.focus();
        return false;
      }
      if (!draft.categoryId) {
        err.textContent = 'Выбери категорию';
        return false;
      }
      if (!L.isISODate(date.value)) {
        err.textContent = 'Укажи дату';
        return false;
      }
      const item = {
        ...(tx ?? { id: uid(), createdAt: Date.now() }),
        type: draft.type,
        amount: kop,
        categoryId: draft.categoryId,
        date: date.value,
        note: note.value.trim(),
      };
      await persist([{ store: 'transactions', put: item }]);
      const monthChanged = L.monthKey(item.date) !== state.month;
      state.month = L.monthKey(item.date);
      render();
      if (tx) toast('Сохранено');
      else toast(`${TYPE_LABEL[item.type]} ${L.formatMoney(item.amount)} добавлен${monthChanged ? ` · ${L.monthTitle(state.month)}` : ''}`);
      return true;
    },
  });
  if (!tx) amount.input.focus();
}

async function deleteTx(tx) {
  await persist([{ store: 'transactions', delete: tx }]);
  closeSheet();
  render();
  toast('Операция удалена', {
    label: 'Вернуть',
    run: async () => {
      await persist([{ store: 'transactions', put: tx }]);
      render();
    },
  });
}

// ---------- Регулярные платежи ----------

// Записывает все наступившие платежи. id операции детерминирован
// (правило + дата), поэтому ни повторный запуск, ни второе устройство дублей не создадут.
// Время изменения у автоплатежа нулевое: любая ручная правка или удаление
// (на любом устройстве) всегда сильнее автоматической записи.
let recurringRun = null;
function applyRecurring() {
  recurringRun ??= (async () => {
    const today = L.todayISO();
    const known = new Set([...state.transactions.map((t) => t.id), ...state.tombstones.transactions]);
    const ops = [];
    let added = 0;
    for (const r of state.recurring) {
      if (!r.active) continue;
      const dates = L.dueOccurrences(r, today);
      if (!dates.length) continue;
      for (const date of dates) {
        const id = `rec-${r.id}-${date}`;
        if (known.has(id)) continue;
        ops.push({ store: 'transactions', put: { id, type: r.type, amount: r.amount, categoryId: r.categoryId, date, note: r.note ?? '', recurringId: r.id, createdAt: 0, updatedAt: 0 } });
        added += 1;
      }
      // lastDate при слиянии берётся максимальный, поэтому время правки правила не трогаем
      ops.push({ store: 'recurring', put: { ...r, lastDate: dates.at(-1) } });
    }
    if (!ops.length) return 0;
    await persist(ops, { stamp: false });
    return added;
  })().finally(() => {
    recurringRun = null;
  });
  return recurringRun;
}

function openRuleSheet(rule = null) {
  const today = L.todayISO();
  const draft = { type: rule?.type ?? 'expense', categoryId: rule?.categoryId ?? null, period: rule?.period ?? 'monthly' };
  const name = h('input', { class: 'input', maxlength: 60, enterkeyhint: 'done', placeholder: 'Например: Spotify, аренда, зарплата', value: rule?.note ?? '' });
  const amount = amountInput(rule?.amount);
  const err = h('p', { class: 'form-error', role: 'alert' });
  const picker = categoryPicker(draft.type, draft.categoryId, (id) => {
    draft.categoryId = id;
    err.textContent = '';
  });
  const start = dateInput(rule?.startDate ?? today);
  const hint = h('p', { class: 'hint' });
  const updateHint = () => {
    if (!L.isISODate(start.value)) {
      hint.textContent = '';
      return;
    }
    const when = `Будет записываться ${L.periodTitle({ startDate: start.value, period: draft.period })}.`;
    hint.textContent = !rule && start.value <= today
      ? `${when} Все платежи с этой даты по сегодня запишутся сразу — если нужны только будущие, поставь дату следующего платежа.`
      : `${when} Платёж появится в операциях сам, когда откроешь приложение в этот день или позже.`;
  };
  start.addEventListener('change', updateHint);
  start.addEventListener('input', updateHint);
  updateHint();
  const active = h('input', { type: 'checkbox', class: 'switch', checked: rule?.active ?? true, 'aria-label': 'Активен' });

  openSheet({
    title: rule ? 'Регулярный платёж' : 'Новый регулярный',
    body: [
      segmented([['expense', 'Расход'], ['income', 'Доход']], draft.type, (t) => {
        draft.type = t;
        draft.categoryId = null;
        picker.setType(t);
      }, 'Тип платежа'),
      amount.el,
      err,
      field('Название', name),
      field('Категория', picker.el),
      field('Как часто', segmented([['monthly', 'Каждый месяц'], ['yearly', 'Каждый год']], draft.period, (p) => {
        draft.period = p;
        updateHint();
      }, 'Периодичность')),
      field(rule ? 'Дата первого платежа' : 'Дата первого платежа (от неё считается число)', start),
      hint,
      rule && h('label', { class: 'toggle-row' }, h('span', null, 'Активен'), active),
      rule && h('button', { type: 'button', class: 'danger-btn', onclick: () => deleteRule(rule) }, 'Удалить регулярный платёж'),
    ],
    onSave: async () => {
      const kop = L.parseAmount(amount.input.value);
      if (!kop) {
        err.textContent = 'Введи сумму больше нуля';
        amount.input.focus();
        return false;
      }
      if (!draft.categoryId) {
        err.textContent = 'Выбери категорию';
        return false;
      }
      if (!L.isISODate(start.value)) {
        err.textContent = 'Укажи дату первого платежа';
        return false;
      }
      const item = {
        ...(rule ?? { id: uid(), lastDate: null, createdAt: Date.now() }),
        type: draft.type,
        amount: kop,
        categoryId: draft.categoryId,
        note: name.value.trim(),
        period: draft.period,
        startDate: start.value,
        active: active.checked,
      };
      // После паузы не записываем то, что было пропущено за время паузы
      if (rule && !rule.active && item.active) {
        const yesterday = L.addDays(today, -1);
        item.lastDate = rule.lastDate && rule.lastDate > yesterday ? rule.lastDate : yesterday;
      }
      await persist([{ store: 'recurring', put: item }]);
      const added = await applyRecurring();
      render();
      toast(added ? `Сохранено, записано платежей: ${added}` : 'Сохранено');
      return true;
    },
  });
  if (!rule) amount.input.focus();
}

async function deleteRule(rule) {
  await persist([{ store: 'recurring', delete: rule }]);
  closeSheet();
  render();
  toast('Удалено. Уже записанные операции остались', {
    label: 'Вернуть',
    run: async () => {
      await persist([{ store: 'recurring', put: rule }]);
      render();
    },
  });
}

// ---------- Категории ----------

function firstGrapheme(s) {
  const v = s.trim();
  if (!v) return '';
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(v)][0].segment;
  return Array.from(v)[0];
}

function openCategorySheet(cat, type) {
  const emoji = h('input', { class: 'input emoji-input', maxlength: 16, placeholder: '🙂', 'aria-label': 'Эмодзи', value: cat?.emoji ?? '' });
  const name = h('input', { class: 'input', maxlength: 40, enterkeyhint: 'done', placeholder: 'Название', 'aria-label': 'Название', value: cat?.name ?? '' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const isOther = cat && L.OTHER_CATEGORY[cat.type] === cat.id;

  openSheet({
    title: cat ? 'Категория' : `Новая категория ${type === 'income' ? 'дохода' : 'расхода'}`,
    body: [
      field('Эмодзи и название', h('div', { class: 'date-row' }, emoji, name)),
      h('p', { class: 'hint' }, 'Эмодзи — с обычной клавиатуры айфона (кнопка 🌐 или 🙂).'),
      err,
      cat && !isOther && h('button', { type: 'button', class: 'danger-btn', onclick: () => deleteCategory(cat) }, 'Удалить категорию'),
      isOther && h('p', { class: 'hint' }, 'Эту категорию нельзя удалить: сюда переносятся операции из удалённых категорий.'),
    ],
    onSave: async () => {
      const title = name.value.trim();
      if (!title) {
        err.textContent = 'Введи название';
        name.focus();
        return false;
      }
      const maxOrder = Math.max(0, ...state.categories.map((c) => c.order ?? 0));
      const item = { ...(cat ?? { id: uid(), type, order: maxOrder + 1 }), name: title, emoji: firstGrapheme(emoji.value) || '🏷️' };
      await persist([{ store: 'categories', put: item }]);
      render();
      return true;
    },
  });
  if (!cat) emoji.focus();
}

async function deleteCategory(cat) {
  const other = L.OTHER_CATEGORY[cat.type];
  const txs = state.transactions.filter((t) => t.categoryId === cat.id).map((t) => ({ ...t, categoryId: other }));
  const rules = state.recurring.filter((r) => r.categoryId === cat.id).map((r) => ({ ...r, categoryId: other }));
  const presets = state.presets.filter((p) => p.categoryId === cat.id).map((p) => ({ ...p, categoryId: other }));
  const moved = txs.length ? ` ${txs.length} ${L.plural(txs.length, TX_FORMS)} перейдут в «${catById(other).name}».` : '';
  if (!confirm(`Удалить категорию «${cat.name}»?${moved}`)) return;
  await persist([
    ...txs.map((t) => ({ store: 'transactions', put: t })),
    ...rules.map((r) => ({ store: 'recurring', put: r })),
    ...presets.map((p) => ({ store: 'presets', put: p })),
    { store: 'categories', delete: cat },
  ]);
  if (state.filterCategory === cat.id) state.filterCategory = null;
  closeSheet();
  render();
  toast('Категория удалена');
}

// ---------- Резервные копии и экспорт ----------

// На айфоне надёжнее всего отдать файл через меню «Поделиться»:
// оттуда его можно сохранить в «Файлы», iCloud Drive или отправить себе.
async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return true;
}

async function exportBackup() {
  const json = JSON.stringify(L.makeBackup(state), null, 1);
  const file = new File([json], `rashody-backup-${L.todayISO()}.json`, { type: 'application/json' });
  if (!(await shareOrDownload(file))) return;
  state.lastBackup = Date.now();
  await db.setMeta('lastBackup', state.lastBackup);
  render();
  toast('Копия готова — сохрани её в «Файлы» или iCloud');
}

async function exportCSV() {
  const file = new File([L.toCSV(state.transactions, state.categories)], `rashody-${L.todayISO()}.csv`, { type: 'text/csv' });
  await shareOrDownload(file);
}

async function importBackup(file) {
  let data;
  try {
    data = L.parseBackup(await file.text());
  } catch (err) {
    alert(err.message);
    return;
  }
  const cur = state.transactions.length;
  const next = data.transactions.length;
  const everywhere = sync.config ? ' Замена разойдётся и на другие устройства.' : '';
  if (!confirm(`Заменить текущие данные (${cur} ${L.plural(cur, TX_FORMS)}) данными из копии (${next} ${L.plural(next, TX_FORMS)})?${everywhere} Текущие данные пропадут.`)) return;
  data.categories = L.withRequiredCategories(data.categories);
  // Копия должна победить при синхронизации: её записи — «свежие»,
  // а всё, чего в ней нет, удаляется «надгробиями»
  const now = Date.now();
  const replaced = Object.fromEntries(L.SYNC_STORES.map((name) => {
    const incoming = data[name].map((r) => ({ ...r, updatedAt: now }));
    const keep = new Set(incoming.map((r) => r.id));
    const gone = [...state[name].map((r) => r.id), ...state.tombstones[name]].filter((id) => !keep.has(id));
    return [name, [...incoming, ...gone.map((id) => ({ id, deleted: true, updatedAt: now }))]];
  }));
  await db.replaceAll(replaced);
  await loadState();
  state.filterCategory = null;
  markSyncDirty();
  await applyRecurring();
  render();
  toast('Данные восстановлены из копии');
}

async function clearAll() {
  if (sync.config) {
    if (!confirm('Удалить все данные с этого устройства? Синхронизация здесь отключится, а данные в GitHub-репозитории и на других устройствах останутся.')) return;
  } else {
    if (!confirm('Удалить все операции, категории и регулярные платежи? Сначала лучше сохранить резервную копию.')) return;
    if (!confirm('Точно удалить? Вернуть можно будет только из резервной копии.')) return;
  }
  await disconnectSync();
  await db.clearAll();
  if (lock.record) await db.setMeta('lock', lock.record); // PIN — настройка устройства, не данные
  Object.assign(state, {
    transactions: [],
    recurring: [],
    debts: [],
    presets: [],
    categories: L.defaultCategories(),
    tombstones: Object.fromEntries(L.SYNC_STORES.map((s) => [s, new Set()])),
    filterCategory: null,
    lastBackup: null,
    backupSnooze: null,
  });
  await db.bulk(state.categories.map((c) => ({ store: 'categories', put: c })));
  render();
  toast('Все данные удалены');
}

// ---------- Синхронизация ----------

// Подменить адрес API можно только на localhost — для тестов с имитацией GitHub
const API_OVERRIDE = ['localhost', '127.0.0.1'].includes(location.hostname) ? new URLSearchParams(location.search).get('api') : null;
const SYNC_LABEL = { off: 'Синхронизация выключена', syncing: 'Идёт синхронизация', ok: 'Синхронизировано', error: 'Ошибка синхронизации' };
const FATAL_ON_CONNECT = new Set(['auth', 'forbidden', 'not-found', 'public', 'http', 'rate', undefined]);

const sync = {
  config: null, // { repo, token }
  etag: null,
  sha: null,
  dirty: false,
  seq: 0, // счётчик локальных правок — чтобы не потерять правку, сделанную во время синхронизации
  status: 'off',
  error: null,
  errorCode: null,
  lastAt: null,
  running: null,
  again: false,
  timer: null,
  errorToasted: false,
};

const syncClient = (config) => createGitHubClient({ repo: config.repo, token: config.token, api: API_OVERRIDE ?? undefined });

function saveSyncState() {
  return db.setMeta('syncState', { etag: sync.etag, sha: sync.sha, dirty: sync.dirty, lastAt: sync.lastAt }).catch(() => {});
}

function markSyncDirty() {
  if (!sync.config) return;
  sync.dirty = true;
  sync.seq += 1;
  saveSyncState();
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => runSync(), 1500);
}

// Точка на вкладке «Настройки»: синяя — идёт синхронизация, красная — ошибка
function updateSyncBadge() {
  const dot = $('#syncDot');
  const visible = Boolean(sync.config) && (sync.status === 'syncing' || sync.status === 'error');
  dot.hidden = !visible;
  dot.className = `sync-dot is-${sync.status}`;
  const tab = $('.tab[data-tab="settings"]');
  if (visible) tab.setAttribute('aria-label', `Настройки: ${SYNC_LABEL[sync.status].toLowerCase()}`);
  else tab.removeAttribute('aria-label');
}

function setSyncStatus(status) {
  sync.status = status;
  updateSyncBadge();
  if (state.tab === 'settings' && !sheet.open) renderSettings();
}

// Один запуск за раз; просьбы во время работы склеиваются в один повтор. → { ok, error }
function runSync() {
  if (!sync.config) return Promise.resolve({ ok: false });
  if (sync.running) {
    sync.again = true;
    return sync.running;
  }
  sync.running = (async () => {
    const seq = sync.seq;
    setSyncStatus('syncing');
    try {
      const res = await syncOnce({
        client: syncClient(sync.config),
        local: localData,
        etag: sync.etag,
        sha: sync.sha,
        dirty: sync.dirty,
        deviceName: L.deviceName(navigator.userAgent),
      });
      Object.assign(sync, { etag: res.etag, sha: res.sha, lastAt: Date.now(), error: null, errorCode: null, errorToasted: false });
      if (sync.seq === seq) sync.dirty = false;
      await saveSyncState();
      if (res.pulled) {
        await loadState();
        await applyRecurring();
        if (sheet.open) renderWhenSheetCloses = true;
        else render();
        if (document.visibilityState === 'visible') toast('Подтянуты изменения с другого устройства');
      }
      setSyncStatus('ok');
      return { ok: true };
    } catch (err) {
      console.warn('Синхронизация:', err);
      Object.assign(sync, { error: err?.message ?? String(err), errorCode: err?.code });
      if (err?.code === 'conflict') sync.etag = null;
      setSyncStatus('error');
      if (!sync.errorToasted && err?.code !== 'network') {
        sync.errorToasted = true;
        toast(`Синхронизация: ${sync.error}`);
      }
      return { ok: false, error: err };
    }
  })().finally(() => {
    sync.running = null;
    if (sync.again) {
      sync.again = false;
      runSync();
    }
  });
  return sync.running;
}

// Проверяет доступ, делает первую синхронизацию; при ошибке ничего не сохраняет
async function connectSync(config) {
  await syncClient(config).checkRepo();
  clearTimeout(sync.timer);
  Object.assign(sync, { config, etag: null, sha: null, dirty: true, error: null, errorCode: null, errorToasted: true });
  const result = await runSync();
  if (!result.ok && FATAL_ON_CONNECT.has(result.error?.code)) {
    Object.assign(sync, { config: null, status: 'off' });
    updateSyncBadge();
    throw result.error;
  }
  sync.errorToasted = false;
  await db.setMeta('syncConfig', config);
}

async function disconnectSync() {
  clearTimeout(sync.timer);
  const inFlight = sync.running;
  sync.config = null; // повтор после текущего запуска уже не случится
  // Дождаться текущего запуска, иначе он допишет данные после очистки
  if (inFlight) await inFlight;
  Object.assign(sync, { config: null, etag: null, sha: null, dirty: false, status: 'off', error: null, errorCode: null, lastAt: null });
  await db.setMeta('syncConfig', null);
  await saveSyncState();
  updateSyncBadge();
}

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => {
        scripts.delete(src);
        reject(new Error('Не удалось загрузить сканер — нужен интернет.'));
      };
      document.head.append(el);
    }));
  }
  return scripts.get(src);
}

let stopScanner = () => {};

// Сканирует QR камерой прямо в приложении (iOS не умеет передать
// результат из «Камеры» в приложение с экрана «Домой» — у них разные хранилища)
async function scanQR(box) {
  stopScanner();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Камера здесь недоступна — вставь ключ вручную.');
  await loadScript('./vendor/jsQR.js');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    throw new Error('Нет доступа к камере — разреши его или вставь ключ вручную.');
  }
  const video = h('video', { playsinline: true, autoplay: true, 'aria-label': 'Камера' });
  video.muted = true;
  video.srcObject = stream;
  box.hidden = false;
  mount(box, video, h('button', { type: 'button', class: 'chip', onclick: () => stopScanner() }, 'Остановить'));
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return new Promise((resolve) => {
    let raf = 0;
    const finish = (value) => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      box.hidden = true;
      box.replaceChildren();
      stopScanner = () => {};
      resolve(value);
    };
    stopScanner = () => finish(null);
    const tick = () => {
      if (video.readyState >= 2 && video.videoWidth) {
        const scale = Math.min(1, 720 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
        if (code?.data) return finish(code.data);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  });
}

async function qrSvg(text) {
  const { default: qrcode } = await import('../vendor/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const pad = 4; // «тихая зона» вокруг кода, без неё камеры читают хуже
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  }
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('viewBox', `0 0 ${n + pad * 2} ${n + pad * 2}`);
  svgEl.setAttribute('shape-rendering', 'crispEdges');
  svgEl.setAttribute('role', 'img');
  svgEl.setAttribute('aria-label', 'QR-код с ключом подключения');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#fff');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svgEl.append(bg, path);
  return svgEl;
}

function formatWhen(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return L.toISODate(d) === L.todayISO() ? `в ${time}` : `${d.toLocaleDateString('ru-RU')} в ${time}`;
}

function syncStatusText() {
  if (sync.status === 'syncing') return '⏳ Синхронизация…';
  if (sync.status === 'error') return `⚠️ ${sync.error}`;
  if (sync.dirty && !navigator.onLine) return '📴 Нет интернета — изменения отправятся позже';
  if (sync.lastAt) return `✅ Синхронизировано ${formatWhen(sync.lastAt)}`;
  return '⏳ Ждёт первой синхронизации';
}

function openSyncSetup(prefillRepo) {
  const user = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : '';
  const plain = { autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' };
  const key = h('input', { class: 'input mono', placeholder: 'treker1|…', 'aria-label': 'Ключ подключения', ...plain });
  const repo = h('input', { class: 'input', placeholder: 'владелец/репозиторий', value: prefillRepo ?? (user ? `${user}/treker-data` : ''), ...plain });
  const token = h('input', { class: 'input mono', type: 'password', placeholder: 'github_pat_…', ...plain });
  const msg = h('p', { class: 'form-error', role: 'alert' });
  const say = (text, kind = 'error') => {
    msg.className = kind === 'error' ? 'form-error' : 'form-note';
    msg.textContent = text;
    msg.scrollIntoView({ block: 'nearest' });
  };
  const scanBox = h('div', { class: 'scanner', hidden: true });
  const ext = (href, text) => h('a', { class: 'chip', href, target: '_blank', rel: 'noopener' }, text);
  let form;

  openSheet({
    title: 'Синхронизация',
    body: [
      h('p', { class: 'hint' }, 'Данные будут лежать в твоём приватном репозитории на GitHub. Каждое устройство само забирает оттуда чужие изменения и отправляет свои. Работает и без интернета — догонит, когда связь появится.'),
      field('Уже настроено на другом устройстве? Отсканируй или вставь ключ',
        key,
        h('div', { class: 'banner-actions' },
          h('button', {
            type: 'button',
            class: 'chip',
            onclick: async () => {
              say('');
              try {
                const text = await scanQR(scanBox);
                if (!text) return;
                key.value = text;
                if (L.parseSyncKey(text)) form.requestSubmit();
                else say('Это не ключ подключения трекера.');
              } catch (err) {
                say(err.message);
              }
            },
          }, '📷 Сканировать QR'),
          navigator.clipboard?.readText && h('button', {
            type: 'button',
            class: 'chip',
            onclick: async () => {
              try {
                key.value = (await navigator.clipboard.readText()).trim();
              } catch {
                key.focus();
              }
            },
          }, '📋 Вставить'))),
      scanBox,
      h('div', { class: 'divider' }, 'или настрой с нуля — удобнее с компьютера'),
      h('ol', { class: 'steps' },
        h('li', null,
          h('p', null, 'Создай ', h('b', null, 'приватный'), ' репозиторий, например treker-data: выбери Private и поставь галочку Add a README file.'),
          ext('https://github.com/new', 'Создать репозиторий ↗')),
        h('li', null,
          h('p', null, 'Создай токен (fine-grained): Repository access → Only select repositories → этот репозиторий; в разрешениях репозитория Contents → Read and write; срок — максимальный. Скопируй токен.'),
          ext('https://github.com/settings/personal-access-tokens/new', 'Создать токен ↗')),
        h('li', null, h('p', null, 'Вставь репозиторий и токен ниже и нажми «Готово». Уже внесённые на этом устройстве данные тоже уедут в репозиторий.'))),
      field('Репозиторий', repo),
      field('Токен', token),
      msg,
    ],
    onSave: async () => {
      let config;
      if (key.value.trim()) {
        config = L.parseSyncKey(key.value);
        if (!config) {
          say('Ключ не распознан — скопируй его целиком.');
          return false;
        }
      } else {
        config = { repo: L.normalizeRepo(repo.value), token: token.value.trim() };
        if (!L.isRepo(config.repo)) {
          say('Укажи репозиторий в виде владелец/название.');
          return false;
        }
        if (!L.isToken(config.token)) {
          say('Токен выглядит неправильно — скопируй его целиком (обычно начинается с github_pat_).');
          return false;
        }
      }
      say('⏳ Проверяю доступ и синхронизирую…', 'note');
      try {
        await connectSync(config);
      } catch (err) {
        say(err?.message ?? String(err));
        return false;
      }
      render();
      toast(sync.status === 'ok' ? 'Синхронизация включена ✅' : 'Синхронизация включена — догонит, когда появится интернет');
      return true;
    },
  });
  form = sheet.querySelector('form');
}

async function openPairSheet() {
  const key = L.makeSyncKey(sync.config);
  const qrBox = h('div', { class: 'qr-box' });
  openSheet({
    title: 'Подключить устройство',
    body: [
      h('ol', { class: 'steps' },
        h('li', null, h('p', null, 'На другом устройстве открой трекер (на айфоне — с иконки на экране «Домой»).')),
        h('li', null, h('p', null, 'Настройки → «Включить синхронизацию» → «Сканировать QR» и наведи камеру на этот код. Или скопируй ключ и вставь его там.'))),
      qrBox,
      h('div', { class: 'btn-stack' },
        h('button', {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(key);
              toast('Ключ скопирован');
            } catch {
              prompt('Скопируй ключ:', key);
            }
          },
        }, '📋 Скопировать ключ')),
      h('p', { class: 'hint' }, '⚠️ Ключ = доступ к твоим данным. Не публикуй его. Если он утёк — удали токен на GitHub (Settings → Developer settings → Personal access tokens) и создай новый.'),
    ],
    onSave: () => true,
  });
  try {
    qrBox.append(await qrSvg(key));
  } catch {
    qrBox.append(h('p', { class: 'hint' }, 'Не удалось нарисовать QR-код — скопируй ключ.'));
  }
}

function syncSection() {
  if (!sync.config) {
    return h('div', { class: 'card pad' },
      h('p', { class: 'hint' }, 'Одни и те же данные на телефоне и компьютере. Хранятся в твоём приватном репозитории на GitHub — бесплатно и без сервера.'),
      h('div', { class: 'btn-stack' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => openSyncSetup() }, '☁️ Включить синхронизацию')));
  }
  const needsToken = ['auth', 'forbidden', 'not-found'].includes(sync.errorCode);
  return h('div', { class: 'card pad' },
    h('p', { class: 'sync-status' }, syncStatusText()),
    h('p', { class: 'hint' }, 'Репозиторий: ', h('a', { href: `https://github.com/${sync.config.repo}`, target: '_blank', rel: 'noopener' }, sync.config.repo)),
    h('div', { class: 'btn-stack' },
      needsToken && h('button', { type: 'button', class: 'btn primary', onclick: () => openSyncSetup(sync.config.repo) }, '🔑 Ввести новый токен'),
      h('button', { type: 'button', class: 'btn', disabled: sync.status === 'syncing', onclick: () => runSync() }, '🔄 Синхронизировать сейчас'),
      h('button', { type: 'button', class: 'btn', onclick: openPairSheet }, '📲 Подключить другое устройство'),
      h('button', {
        type: 'button',
        class: 'btn subtle',
        onclick: async () => {
          if (!confirm('Отключить синхронизацию на этом устройстве? Данные и здесь, и в GitHub останутся.')) return;
          await disconnectSync();
          render();
          toast('Синхронизация отключена');
        },
      }, 'Отключить на этом устройстве')));
}

// ---------- Блокировка PIN-кодом ----------
// PIN и Face ID — настройки конкретного устройства, в синхронизацию не попадают.

const IOS_PASSWORDS_TIP = 'Проверь: Настройки → Основные → Автозаполнение и пароли → включи «Пароли» (нужен вход в iCloud), затем полностью закрой и снова открой трекер.';
const AUTOLOCK_OPTIONS = [[0, 'Сразу'], [60_000, '1 мин'], [300_000, '5 мин'], [900_000, '15 мин']];
const IDLE_LOCK_MS = 5 * 60_000; // бездействие при открытом приложении (актуально для компа)

const lock = {
  record: null, // { salt, hash, iterations, autoLockMs, credentialId }
  locked: false,
  pin: '',
  checking: false,
  failures: 0,
  lockedUntil: 0,
  hiddenAt: null,
  lastActivity: Date.now(),
  bioAvailable: false, // ответ системы — только подсказка, на iOS бывает ложным «нет»
  webauthn: Lock.webauthnSupported(),
  bioError: '',
  message: '',
  shake: false,
  timer: null,
};
const lockEl = $('#lock');
const bioName = Lock.biometricName();
const isApple = isIOS || /Macintosh/.test(navigator.userAgent);
const canUseBio = () => Boolean(lock.record?.credentialId) && lock.webauthn;
// На устройствах Apple переключатель показываем, даже если система ответила «нет»:
// с iOS 26.2 это часто значит «не настроено приложение Пароли», а не «нет Face ID»
const showBioToggle = () => lock.webauthn && (lock.bioAvailable || isApple);

async function saveLockRecord(record) {
  lock.record = record;
  await db.setMeta('lock', record);
}

function saveAttempts() {
  return db.setMeta('lockAttempts', { failures: lock.failures, lockedUntil: lock.lockedUntil }).catch(() => {});
}

function showLock() {
  if (!lock.record) return;
  lock.locked = true;
  lock.pin = '';
  lock.message = '';
  renderLock();
  if (!lockEl.open) lockEl.showModal();
}

function unlock() {
  lock.locked = false;
  lock.pin = '';
  lock.lastActivity = Date.now();
  clearTimeout(lock.timer);
  if (lockEl.open) lockEl.close();
  lockEl.replaceChildren();
}

function renderLock() {
  clearTimeout(lock.timer);
  const wait = lock.lockedUntil - Date.now();
  if (wait > 0) lock.timer = setTimeout(renderLock, Math.min(wait, 1000));
  const blocked = wait > 0 || lock.checking;
  const key = (d) => h('button', { type: 'button', class: 'pin-key', 'data-key': d, disabled: blocked, onclick: () => pressDigit(d) }, d);
  const focusedKey = lockEl.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const faceIcon = svgIcon('M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1.5M15 9v1.5M12 9v4h-1M9 16c1.7 1.3 4.3 1.3 6 0');
  // autofocus на контейнере: иначе браузер ставит фокус (и обводку) на кнопку «1»
  mount(lockEl, h('div', { class: 'lock-screen', tabindex: '-1', autofocus: true },
    h('img', { class: 'lock-logo', src: 'icons/icon.svg', alt: '' }),
    h('h2', { id: 'lockTitle' }, 'Введи PIN-код'),
    h('div', { class: `pin-dots${lock.shake ? ' shake' : ''}`, 'aria-label': `Введено цифр: ${lock.pin.length} из ${Lock.PIN_LENGTH}` },
      Array.from({ length: Lock.PIN_LENGTH }, (_, i) => h('span', { class: i < lock.pin.length ? 'on' : '' }))),
    h('p', { class: 'lock-msg', role: 'alert' }, wait > 0 ? `Слишком много попыток. Подожди ${Lock.formatWait(wait)}` : lock.message),
    h('div', { class: 'pin-pad' },
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(key),
      canUseBio()
        ? h('button', { type: 'button', class: 'pin-key fn', 'aria-label': `Войти по ${bioName}`, onclick: unlockWithBiometric }, faceIcon)
        : h('span'),
      key('0'),
      h('button', { type: 'button', class: 'pin-key fn', 'data-key': 'back', 'aria-label': 'Стереть цифру', disabled: blocked, onclick: backspace }, '⌫')),
    canUseBio() && h('button', { type: 'button', class: 'btn primary lock-bio', onclick: unlockWithBiometric }, `Войти по ${bioName}`),
    h('button', { type: 'button', class: 'link-btn lock-forgot', onclick: forgotPin }, 'Забыли PIN?')));
  lock.shake = false;
  // Перерисовка не должна сбивать фокус тем, кто вводит с клавиатуры
  if (focusedKey) lockEl.querySelector(`[data-key="${focusedKey}"]`)?.focus();
}

function svgIcon(d) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  el.append(path);
  return el;
}

function pressDigit(d) {
  if (lock.checking || lock.lockedUntil > Date.now() || lock.pin.length >= Lock.PIN_LENGTH) return;
  lock.pin += d;
  lock.message = '';
  renderLock();
  if (lock.pin.length === Lock.PIN_LENGTH) submitPin();
}

function backspace() {
  lock.pin = lock.pin.slice(0, -1);
  renderLock();
}

async function submitPin() {
  lock.checking = true;
  renderLock();
  const ok = await Lock.checkPin(lock.pin, lock.record);
  lock.checking = false;
  lock.pin = '';
  if (ok) {
    lock.failures = 0;
    lock.lockedUntil = 0;
    saveAttempts();
    unlock();
    return;
  }
  lock.failures += 1;
  lock.lockedUntil = Date.now() + Lock.lockoutMs(lock.failures);
  await saveAttempts();
  lock.message = 'Неверный PIN';
  lock.shake = true;
  renderLock();
}

async function unlockWithBiometric() {
  try {
    if (await Lock.verifyBiometric(lock.record.credentialId)) {
      unlock();
      return;
    }
    lock.message = `${bioName} не подтвердил — введи PIN`;
  } catch {
    lock.message = `${bioName} не сработал — введи PIN`;
  }
  renderLock();
}

// Забытый PIN не обойти: только стереть данные этого устройства.
// Иначе «сброс» открывал бы данные любому, кто взял телефон.
async function forgotPin() {
  const text = sync.config
    ? 'Сбросить PIN? Все данные на ЭТОМ устройстве удалятся, синхронизация на нём отключится. В GitHub данные останутся: подключи устройство заново ключом с другого устройства — и они вернутся.'
    : 'Сбросить PIN? ВСЕ данные на этом устройстве удалятся безвозвратно. Вернуть их можно только из файла резервной копии.';
  if (!confirm(text)) return;
  if (!confirm('Точно? Это нельзя отменить.')) return;
  await disconnectSync();
  await db.clearAll();
  location.reload();
}

// Нельзя закрыть Escape'ом; если браузер всё же закрыл окно — открываем снова
lockEl.addEventListener('cancel', (e) => e.preventDefault());
lockEl.addEventListener('close', () => {
  if (lock.locked) lockEl.showModal();
});
// Слушаем весь документ: после перерисовки фокус может оказаться на body.
// Отменённый keydown Escape не даёт браузеру закрыть окно блокировки.
document.addEventListener('keydown', (e) => {
  if (!lock.locked) return;
  if (/^\d$/.test(e.key)) pressDigit(e.key);
  else if (e.key === 'Backspace') backspace();
  else if (e.key !== 'Escape') return;
  e.preventDefault();
});

function bindLock() {
  const touch = () => { lock.lastActivity = Date.now(); };
  document.addEventListener('pointerdown', touch, { capture: true, passive: true });
  document.addEventListener('keydown', touch, { capture: true, passive: true });
  // Свернули — прячем содержимое (чтобы суммы не попали в превью переключателя приложений),
  // вернулись позже порога — блокируем
  document.addEventListener('visibilitychange', () => {
    if (!lock.record) return;
    if (document.visibilityState === 'hidden') {
      lock.hiddenAt = Date.now();
      document.documentElement.classList.add('privacy');
      return;
    }
    if (!lock.locked && lock.hiddenAt !== null && Date.now() - lock.hiddenAt >= (lock.record.autoLockMs ?? 60_000)) showLock();
    lock.hiddenAt = null;
    document.documentElement.classList.remove('privacy');
  });
  setInterval(() => {
    const idle = Math.max(lock.record?.autoLockMs ?? 0, IDLE_LOCK_MS);
    if (lock.record && !lock.locked && document.visibilityState === 'visible' && Date.now() - lock.lastActivity > idle) showLock();
  }, 15_000);
}

function pinInput(label) {
  return h('input', {
    class: 'input pin-input',
    type: 'password',
    inputmode: 'numeric',
    pattern: '[0-9]*',
    maxlength: Lock.PIN_LENGTH,
    autocomplete: 'off',
    'aria-label': label,
  });
}

// mode: 'set' — первый PIN, 'change' — сменить, 'off' — выключить
function openPinSheet(mode) {
  const current = mode !== 'set' ? pinInput('Текущий PIN') : null;
  const next = mode !== 'off' ? pinInput('Новый PIN') : null;
  const repeat = mode !== 'off' ? pinInput('Повтори новый PIN') : null;
  const err = h('p', { class: 'form-error', role: 'alert' });
  const titles = { set: 'PIN-код на вход', change: 'Сменить PIN-код', off: 'Выключить PIN-код' };

  openSheet({
    title: titles[mode],
    body: [
      mode === 'set' && h('p', { class: 'hint' }, `Приложение спросит PIN при открытии и после сворачивания. PIN — ${Lock.PIN_LENGTH} цифры, у каждого устройства свой. Не используй PIN от банковской карты.`),
      current && field('Текущий PIN', current),
      next && field(`Новый PIN (${Lock.PIN_LENGTH} цифры)`, next),
      repeat && field('Повтори новый PIN', repeat),
      err,
      mode === 'set' && h('p', { class: 'hint' }, 'Если забудешь PIN, придётся стереть данные этого устройства. С синхронизацией они вернутся из GitHub, без неё — только из файла резервной копии.'),
    ],
    onSave: async () => {
      err.textContent = '';
      if (current) {
        const wait = lock.lockedUntil - Date.now();
        if (wait > 0) {
          err.textContent = `Слишком много попыток. Подожди ${Lock.formatWait(wait)}`;
          return false;
        }
        if (!(await Lock.checkPin(current.value, lock.record))) {
          lock.failures += 1;
          lock.lockedUntil = Date.now() + Lock.lockoutMs(lock.failures);
          saveAttempts();
          err.textContent = 'Текущий PIN неверный';
          current.value = '';
          current.focus();
          return false;
        }
        lock.failures = 0;
        lock.lockedUntil = 0;
        saveAttempts();
      }
      if (mode === 'off') {
        await saveLockRecord(null);
        render();
        toast('PIN-код выключен');
        return true;
      }
      if (!Lock.isValidPin(next.value)) {
        err.textContent = `Нужно ровно ${Lock.PIN_LENGTH} цифры`;
        next.focus();
        return false;
      }
      if (Lock.isWeakPin(next.value)) {
        err.textContent = 'Слишком простой PIN — такие угадывают с первой попытки';
        next.value = '';
        repeat.value = '';
        next.focus();
        return false;
      }
      if (next.value !== repeat.value) {
        err.textContent = 'PIN-коды не совпадают';
        repeat.value = '';
        repeat.focus();
        return false;
      }
      const pinRecord = await Lock.createPinRecord(next.value);
      await saveLockRecord({ autoLockMs: 60_000, credentialId: null, ...lock.record, ...pinRecord });
      render();
      toast(mode === 'set' && showBioToggle() ? `PIN-код установлен. Ниже можно включить вход по ${bioName}` : 'PIN-код сохранён');
      return true;
    },
  });
  (current ?? next).focus();
}

async function toggleBiometric(input) {
  if (!input.checked) {
    await saveLockRecord({ ...lock.record, credentialId: null });
    toast(`Вход по ${bioName} выключен`);
    return;
  }
  try {
    const credentialId = await Lock.registerBiometric(); // без await до вызова — Safari нужен жест
    lock.bioError = '';
    await saveLockRecord({ ...lock.record, credentialId });
    toast(`Вход по ${bioName} включён`);
  } catch (err) {
    console.warn(err);
    input.checked = false;
    lock.bioError = `Не получилось включить ${bioName}: ${Lock.describeBiometricError(err)}.`;
  }
  if (!sheet.open) renderSettings();
}

// Что сказать под переключателем Face ID, если что-то не так
function bioHint() {
  if (lock.bioError) {
    return [h('p', { class: 'form-error left' }, lock.bioError), isIOS && h('p', { class: 'hint tip' }, IOS_PASSWORDS_TIP)];
  }
  if (!lock.record?.credentialId && !lock.bioAvailable) {
    return h('p', { class: 'hint' }, isIOS
      ? `iOS отвечает, что вход по Face ID для сайтов сейчас не настроен. ${IOS_PASSWORDS_TIP} Можно попробовать включить и так.`
      : `Система отвечает, что ${bioName} для сайтов не настроен. Можно попробовать включить и так.`);
  }
  return null;
}

function securitySection() {
  if (!lock.record) {
    return h('div', { class: 'card pad' },
      h('p', { class: 'hint' }, `PIN-код на вход${showBioToggle() ? ` и ${bioName}` : ''}: приложение спросит его при открытии и после сворачивания.`),
      h('div', { class: 'btn-stack' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => openPinSheet('set') }, '🔒 Поставить PIN-код')));
  }
  const bioSwitch = showBioToggle() && h('input', {
    type: 'checkbox',
    class: 'switch',
    checked: Boolean(lock.record.credentialId),
    'aria-label': `Входить по ${bioName}`,
    onchange: (e) => toggleBiometric(e.target),
  });
  return h('div', { class: 'card pad' },
    h('p', { class: 'sync-status' }, '🔒 Вход по PIN-коду включён'),
    bioSwitch && h('label', { class: 'toggle-row inset' }, h('span', null, `Входить по ${bioName}`), bioSwitch),
    bioSwitch && bioHint(),
    field('Блокировать после сворачивания',
      segmented(AUTOLOCK_OPTIONS, lock.record.autoLockMs ?? 60_000, async (ms) => {
        await saveLockRecord({ ...lock.record, autoLockMs: ms });
      }, 'Когда блокировать')),
    h('div', { class: 'btn-stack' },
      h('button', { type: 'button', class: 'btn', onclick: showLock }, '🔐 Заблокировать сейчас'),
      h('button', { type: 'button', class: 'btn', onclick: () => openPinSheet('change') }, 'Сменить PIN-код'),
      h('button', { type: 'button', class: 'btn subtle', onclick: () => openPinSheet('off') }, 'Выключить PIN-код')));
}

// ---------- Быстрые кнопки ----------
// Частые траты в один тап. Одна сумма — запись сразу (с «Отменить»),
// несколько — выбор суммы. Кнопки синхронизируются, как и остальные данные.

// Кнопки по умолчанию. Фиксированные id: второе устройство создаст те же
// записи, и при синхронизации дублей не будет; время 0 — любая правка сильнее.
async function seedPresets() {
  if (await db.getMeta('presetsSeeded')) return;
  const known = (store, id) => state[store].some((r) => r.id === id) || state.tombstones[store].has(id);
  const ops = [];
  if (!known('categories', 'exp-tobacco')) {
    ops.push({ store: 'categories', put: { id: 'exp-tobacco', type: 'expense', name: 'Табак', emoji: '🚬', order: 50 } });
  }
  const transport = state.categories.some((c) => c.id === 'exp-transport') ? 'exp-transport' : L.OTHER_CATEGORY.expense;
  const seeds = [
    { id: 'preset-iqos', emoji: '🚬', label: 'Стики', type: 'expense', categoryId: 'exp-tobacco', amounts: [23000], note: 'Стики IQOS', order: 1 },
    { id: 'preset-troika', emoji: '🚇', label: 'Тройка', type: 'expense', categoryId: transport, amounts: [20000, 30000, 40000, 50000], note: 'Пополнение Тройки', order: 2 },
  ];
  for (const p of seeds) if (!known('presets', p.id)) ops.push({ store: 'presets', put: p });
  if (ops.length) await persist(ops, { stamp: false });
  await db.setMeta('presetsSeeded', true);
}

const presetIcon = (p) => p.emoji || catById(p.categoryId).emoji;

function quickRow() {
  return h('div', { class: 'quick-row', role: 'group', 'aria-label': 'Быстрые кнопки' },
    L.sortPresets(state.presets).map((p) => h('button', {
      type: 'button',
      class: 'quick-btn',
      'aria-label': p.amounts.length === 1 ? `${p.label}: записать ${L.formatMoney(p.amounts[0])}` : `${p.label}: выбрать сумму`,
      onclick: () => usePreset(p),
    },
      h('span', { 'aria-hidden': 'true' }, presetIcon(p)),
      h('span', null, p.label),
      p.amounts.length === 1 && h('span', { class: 'quick-sum' }, L.formatMoney(p.amounts[0])))),
    h('button', { type: 'button', class: 'quick-btn add', 'aria-label': 'Новая быстрая кнопка', onclick: () => openPresetSheet() }, '＋'));
}

let quickLockAt = 0;
async function quickAdd(p, amount) {
  const now = Date.now();
  if (now - quickLockAt < 800) return; // случайный двойной тап
  quickLockAt = now;
  const item = { id: uid(), createdAt: now, type: p.type, amount, categoryId: p.categoryId, date: L.todayISO(), note: p.note || p.label };
  await persist([{ store: 'transactions', put: item }]);
  state.month = L.monthKey(item.date);
  render();
  toast(`${presetIcon(p)} ${p.label}: ${L.formatMoney(amount)} записано`, {
    label: 'Отменить',
    run: async () => {
      await persist([{ store: 'transactions', delete: item }]);
      render();
    },
  });
}

function usePreset(p) {
  if (p.amounts.length === 1) {
    quickAdd(p, p.amounts[0]);
    return;
  }
  openSheet({
    title: `${presetIcon(p)} ${p.label}`,
    body: [
      h('p', { class: 'hint' }, 'Выбери сумму — операция запишется сразу.'),
      h('div', { class: 'amount-grid' }, p.amounts.map((a) => h('button', {
        type: 'button',
        class: 'amount-choice',
        onclick: () => {
          closeSheet();
          quickAdd(p, a);
        },
      }, L.formatMoney(a)))),
      h('button', { type: 'button', class: 'btn', onclick: () => openTxSheet(null, p) }, 'Другая сумма'),
    ],
    onSave: () => true,
  });
}

function openPresetSheet(preset = null) {
  const draft = { type: preset?.type ?? 'expense', categoryId: preset?.categoryId ?? null };
  const plain = { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' };
  const emoji = h('input', { class: 'input emoji-input', maxlength: 16, placeholder: '☕', 'aria-label': 'Значок', value: preset?.emoji ?? '' });
  const label = h('input', { class: 'input', maxlength: 24, placeholder: 'Кофе', 'aria-label': 'Название', value: preset?.label ?? '' });
  const amounts = h('input', { class: 'input', placeholder: '250  или  200, 300, 400', 'aria-label': 'Суммы', value: preset ? L.formatAmounts(preset.amounts) : '', ...plain });
  const note = h('input', { class: 'input', maxlength: 120, placeholder: 'Необязательно — иначе название кнопки', value: preset?.note ?? '' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const picker = categoryPicker(draft.type, draft.categoryId, (id) => {
    draft.categoryId = id;
    err.textContent = '';
  });

  openSheet({
    title: preset ? 'Быстрая кнопка' : 'Новая быстрая кнопка',
    body: [
      segmented([['expense', 'Расход'], ['income', 'Доход']], draft.type, (t) => {
        draft.type = t;
        draft.categoryId = null;
        picker.setType(t);
      }, 'Тип операции'),
      field('Значок и название', h('div', { class: 'date-row' }, emoji, label)),
      field('Сумма', amounts),
      h('p', { class: 'hint tip' }, 'Одна сумма — запись в один тап. Несколько через запятую с пробелом (до 8) — выбор суммы при нажатии.'),
      err,
      field('Категория', picker.el),
      field('Комментарий к операции', note),
      preset && h('button', { type: 'button', class: 'danger-btn', onclick: () => deletePreset(preset) }, 'Удалить кнопку'),
    ],
    onSave: async () => {
      const title = label.value.trim();
      const list = L.parseAmounts(amounts.value);
      if (!title) {
        err.textContent = 'Введи название';
        label.focus();
        return false;
      }
      if (!list) {
        err.textContent = 'Суммы не распознаны: например «230» или «200, 300, 400, 500»';
        amounts.focus();
        return false;
      }
      if (!draft.categoryId) {
        err.textContent = 'Выбери категорию';
        return false;
      }
      const maxOrder = Math.max(0, ...state.presets.map((p) => p.order ?? 0));
      const item = {
        ...(preset ?? { id: uid(), order: maxOrder + 1, createdAt: Date.now() }),
        emoji: firstGrapheme(emoji.value),
        label: title,
        type: draft.type,
        categoryId: draft.categoryId,
        amounts: list,
        note: note.value.trim(),
      };
      await persist([{ store: 'presets', put: item }]);
      render();
      toast(preset ? 'Кнопка сохранена' : 'Кнопка добавлена на «Операции»');
      return true;
    },
  });
  if (!preset) label.focus();
}

async function deletePreset(preset) {
  await persist([{ store: 'presets', delete: preset }]);
  closeSheet();
  render();
  toast('Кнопка удалена', {
    label: 'Вернуть',
    run: async () => {
      await persist([{ store: 'presets', put: preset }]);
      render();
    },
  });
}

function presetsSection() {
  return h('div', { class: 'card list' },
    L.sortPresets(state.presets).map((p) => h('button', { type: 'button', class: 'row', onclick: () => openPresetSheet(p) },
      h('span', { class: 'row-icon', 'aria-hidden': 'true' }, presetIcon(p)),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, p.label),
        h('span', { class: 'row-sub' }, `${p.amounts.map((a) => L.formatMoney(a)).join(' / ')} · ${catById(p.categoryId).name}`)),
      h('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'))),
    h('button', { type: 'button', class: 'row accent', onclick: () => openPresetSheet() },
      h('span', { class: 'row-icon', 'aria-hidden': 'true' }, '＋'),
      h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Новая быстрая кнопка'))));
}

// ---------- Сводка для ИИ ----------

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    previewText(text); // нет доступа к буферу — покажем текст, чтобы скопировать руками
  }
}

async function shareText(text) {
  try {
    await navigator.share({ text });
  } catch (err) {
    if (err?.name !== 'AbortError') copyText(text, 'Сводка скопирована');
  }
}

function previewText(text) {
  const area = h('textarea', { class: 'input mono ai-text', readonly: true, 'aria-label': 'Сводка для ИИ', rows: 18 });
  area.value = text;
  openSheet({
    title: 'Сводка для ИИ',
    body: [
      h('p', { class: 'hint' }, 'Именно этот текст уйдёт в чат с ИИ.'),
      area,
      h('div', { class: 'btn-stack' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => copyText(text, 'Сводка скопирована — вставь её в чат с ИИ') }, '📋 Скопировать')),
    ],
    onSave: () => true,
  });
}

function aiCard() {
  const notesOn = () => localGet('aiNotes') === '1';
  const build = () => L.aiSummary(state, { month: state.month, today: L.todayISO(), includeNotes: notesOn() });
  return h('section', { class: 'card pad' },
    h('h2', { class: 'section-title' }, '🤖 Разбор трат с ИИ'),
    h('p', { class: 'hint' }, `Скопирует сводку за ${L.monthTitle(state.month).toLowerCase()} (плюс два прошлых месяца для сравнения) вместе с готовым вопросом. Вставь в любой бесплатный чат: ChatGPT, Claude, DeepSeek, GigaChat, Алиса.`),
    h('label', { class: 'toggle-row inset' },
      h('span', null, 'Добавлять комментарии к тратам'),
      h('input', { type: 'checkbox', class: 'switch', checked: notesOn(), 'aria-label': 'Добавлять комментарии к тратам', onchange: (e) => localSet('aiNotes', e.target.checked ? '1' : '0') })),
    h('p', { class: 'hint tip' }, 'Без комментариев уходят только суммы по категориям. Имена из долгов не уходят никогда.'),
    h('div', { class: 'btn-stack' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => copyText(build(), 'Сводка скопирована — вставь её в чат с ИИ') }, '📋 Скопировать для ИИ'),
      navigator.share && h('button', { type: 'button', class: 'btn', onclick: () => shareText(build()) }, '📤 Отправить в приложение'),
      h('button', { type: 'button', class: 'btn subtle', onclick: () => previewText(build()) }, 'Посмотреть, что уйдёт')));
}

// ---------- Экран «Операции» ----------

function installCard({ dismissible }) {
  if (!isIOS || isStandalone) return null;
  if (dismissible && localGet('installHintHidden')) return null;
  return h('section', { class: 'card banner' },
    h('strong', null, '📲 Установи на экран «Домой»'),
    h('p', { class: 'hint' }, 'В Safari нажми «Поделиться» (квадрат со стрелкой вверх) → «На экран „Домой“». Важно: данные в Safari и в установленном приложении хранятся отдельно — пользуйся только иконкой.'),
    dismissible && h('div', { class: 'banner-actions' },
      h('button', { type: 'button', class: 'chip', onclick: () => { localSet('installHintHidden', '1'); render(); } }, 'Понятно')));
}

function backupCard() {
  const now = Date.now();
  const stale = !state.lastBackup || now - state.lastBackup > BACKUP_EVERY_MS;
  const snoozed = state.backupSnooze && now - state.backupSnooze < SNOOZE_MS;
  if (sync.config || state.transactions.length < 10 || !stale || snoozed) return null;
  return h('section', { class: 'card banner' },
    h('strong', null, '💾 Пора сделать резервную копию'),
    h('p', { class: 'hint' }, state.lastBackup
      ? `Последняя копия — ${new Date(state.lastBackup).toLocaleDateString('ru-RU')}. Данные хранятся только на этом телефоне.`
      : 'Данные хранятся только на этом телефоне. Если удалить приложение, они пропадут.'),
    h('div', { class: 'banner-actions' },
      h('button', { type: 'button', class: 'chip on', onclick: exportBackup }, 'Сохранить копию'),
      h('button', {
        type: 'button',
        class: 'chip',
        onclick: async () => {
          state.backupSnooze = now;
          await db.setMeta('backupSnooze', now);
          render();
        },
      }, 'Позже')));
}

function txRow(t) {
  const c = catById(t.categoryId);
  const sub = [t.recurringId && '🔁', t.note].filter(Boolean).join(' ');
  return h('button', { type: 'button', class: 'row', onclick: () => openTxSheet(t) },
    h('span', { class: 'row-icon', 'aria-hidden': 'true' }, c.emoji),
    h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, c.name), sub && h('span', { class: 'row-sub' }, sub)),
    h('span', { class: `row-amount${t.type === 'income' ? ' pos' : ''}` }, signedMoney(t)));
}

function renderList() {
  const today = L.todayISO();
  const monthTx = L.inMonth(state.transactions, state.month);
  const s = L.summarize(monthTx);
  let list = monthTx;
  let filterRow = null;
  if (state.filterCategory) {
    const c = catById(state.filterCategory);
    list = monthTx.filter((t) => t.categoryId === c.id);
    filterRow = h('div', { class: 'filter-row' },
      h('button', { type: 'button', class: 'chip on', 'aria-label': `Сбросить фильтр «${c.name}»`, onclick: () => { state.filterCategory = null; render(); } },
        `${c.emoji} ${c.name}  ✕`),
      h('span', { class: 'hint' }, `${list.length} ${L.plural(list.length, TX_FORMS)} · ${L.formatMoney(L.summarize(list)[c.type])}`));
  }

  mount($('#view-list'),
    installCard({ dismissible: true }),
    backupCard(),
    h('section', { class: 'card summary' },
      h('div', null, h('div', { class: 'label' }, 'Расходы за месяц'), h('div', { class: 'hero' }, L.formatMoney(s.expense))),
      h('div', { class: 'summary-side' },
        h('div', null, h('div', { class: 'label' }, 'Доходы'), h('div', { class: 'side-value' }, L.formatMoney(s.income))),
        h('div', null, h('div', { class: 'label' }, 'Баланс'),
          h('div', { class: `side-value${s.balance < 0 ? ' neg' : ''}` }, L.formatMoney(s.balance, { sign: true }))))),
    quickRow(),
    filterRow,
    list.length
      ? L.groupByDate(list).map((g) => h('section', { class: 'day' },
        h('header', { class: 'day-head' },
          h('span', null, L.dayTitle(g.date, today)),
          h('span', null, [g.expense && L.formatMoney(-g.expense), g.income && L.formatMoney(g.income, { sign: true })].filter(Boolean).join(' · '))),
        h('div', { class: 'card list' }, g.items.map(txRow))))
      : h('div', { class: 'empty' },
        h('div', { class: 'empty-emoji', 'aria-hidden': 'true' }, state.filterCategory ? '🔍' : '🧾'),
        h('p', null, state.filterCategory ? 'В этой категории за месяц ничего нет.' : `За ${L.monthTitle(state.month).toLowerCase()} операций пока нет.`),
        !state.filterCategory && h('p', { class: 'hint' }, 'Нажми «+», чтобы добавить расход или доход.')),
  );
}

// ---------- Экран «Статистика» ----------

function deltaNote(cur, prev, upIsGood, cmp) {
  const p = L.percentChange(cur, prev);
  if (p === null) return null;
  const m = Number(cmp.prevKey.slice(5)) - 1;
  const period = cmp.partialDay ? `к 1–${cmp.partialDay} ${L.MONTHS_SHORT[m]}` : `к ${L.MONTHS_DAT[m]}`;
  const tone = p === 0 ? '' : (p > 0) === upIsGood ? ' good' : ' bad';
  const arrow = p > 0 ? '▲ ' : p < 0 ? '▼ ' : '';
  return h('div', { class: `delta${tone}` }, `${arrow}${L.formatPercent(Math.abs(p))} ${period}`);
}

function tile(label, value, extra, valueClass = '') {
  const size = value.length > 14 ? ' xlong' : value.length > 11 ? ' long' : '';
  return h('div', { class: 'card tile' }, h('div', { class: 'label' }, label), h('div', { class: `tile-value${size}${valueClass}` }, value), extra);
}

function renderStats() {
  const today = L.todayISO();
  const type = state.statsType;
  const monthTx = L.inMonth(state.transactions, state.month);
  const cmp = L.comparePeriods(state.transactions, state.month, today);
  const { cur } = cmp;
  const avg = Math.round(cur.expense / L.daysForAverage(state.month, today));
  const cats = L.byCategory(monthTx, type);
  const total = type === 'income' ? cur.income : cur.expense;
  const [y, m] = state.month.split('-').map(Number);
  const dayHost = h('div', { class: 'chart' });
  const monthHost = h('div', { class: 'chart' });
  const months = L.byMonth(state.transactions, state.month, 6);
  const typeWord = type === 'income' ? 'Доходы' : 'Расходы';

  mount($('#view-stats'),
    h('div', { class: 'tiles' },
      tile('Расходы', L.formatMoney(cur.expense), deltaNote(cur.expense, cmp.prev.expense, false, cmp)),
      tile('Доходы', L.formatMoney(cur.income), deltaNote(cur.income, cmp.prev.income, true, cmp)),
      tile('Баланс', L.formatMoney(cur.balance, { sign: true }), null, cur.balance < 0 ? ' neg' : ''),
      tile('Расходы в день', L.formatMoney(avg), h('div', { class: 'delta' }, 'в среднем'))),
    segmented([['expense', 'Расходы'], ['income', 'Доходы']], type, (t) => { state.statsType = t; render(); }, 'Что показывать'),
    h('section', { class: 'card pad' },
      h('h2', { class: 'section-title' }, `${typeWord} по категориям`),
      cats.length
        ? cats.map((e) => {
          const c = catById(e.categoryId);
          const share = total ? e.total / total : 0;
          return h('button', {
            type: 'button',
            class: 'cat-stat',
            onclick: () => {
              state.filterCategory = c.id;
              state.tab = 'list';
              render();
              window.scrollTo(0, 0);
            },
          },
            h('span', { class: 'row-icon', 'aria-hidden': 'true' }, c.emoji),
            h('span', { class: 'cat-stat-main' },
              h('span', { class: 'cat-stat-top' }, h('span', { class: 'row-title' }, c.name), h('span', { class: 'cat-stat-value' }, L.formatMoney(e.total))),
              h('span', { class: 'meter', style: `--bar:${SERIES_COLOR[type]}` }, h('span', { class: 'meter-fill', style: `width:${Math.max(share * 100, 1)}%` })),
              h('span', { class: 'row-sub' }, `${L.formatPercent(share)} · ${e.count} ${L.plural(e.count, TX_FORMS)}`)));
        })
        : h('p', { class: 'hint' }, `${typeWord} за этот месяц пока нет.`)),
    h('section', { class: 'card pad' },
      h('h2', { class: 'section-title' }, `${typeWord} по дням`),
      dayHost),
    h('section', { class: 'card pad' },
      h('h2', { class: 'section-title' }, 'Последние 6 месяцев'),
      h('div', { class: 'legend' },
        h('span', { class: 'legend-item' }, h('span', { class: 'swatch', style: `background:${SERIES_COLOR.expense}` }), 'Расходы'),
        h('span', { class: 'legend-item' }, h('span', { class: 'swatch', style: `background:${SERIES_COLOR.income}` }), 'Доходы')),
      monthHost,
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Месяц'), h('th', null, 'Расходы'), h('th', null, 'Доходы'), h('th', null, 'Баланс'))),
        h('tbody', null, [...months].reverse().map((r) => {
          const bal = r.income - r.expense;
          const mi = Number(r.month.slice(5)) - 1;
          return h('tr', null,
            h('td', null, `${L.MONTHS_SHORT[mi]} ${r.month.slice(2, 4)}`),
            h('td', null, L.formatMoney(r.expense)),
            h('td', null, L.formatMoney(r.income)),
            h('td', { class: bal < 0 ? 'neg' : '' }, L.formatMoney(bal, { sign: true })));
        })))),
    aiCard(),
  );

  // Графики рисуются после вставки в DOM — им нужна реальная ширина
  const days = L.byDay(state.transactions, state.month, type);
  columnChart(dayHost, {
    labels: days.map((_, i) => ([1, 5, 10, 15, 20, 25].includes(i + 1) || i === days.length - 1 ? String(i + 1) : '')),
    series: [{ name: typeWord, color: SERIES_COLOR[type], values: days }],
    tipTitle: (i) => `${i + 1} ${L.MONTHS_GEN[m - 1]} ${y}`,
    format: (v) => L.formatMoney(v),
    height: 160,
  });
  columnChart(monthHost, {
    labels: months.map((r) => L.MONTHS_SHORT[Number(r.month.slice(5)) - 1]),
    series: [
      { name: 'Расходы', color: SERIES_COLOR.expense, values: months.map((r) => r.expense) },
      { name: 'Доходы', color: SERIES_COLOR.income, values: months.map((r) => r.income) },
    ],
    tipTitle: (i) => L.monthTitle(months[i].month),
    format: (v) => L.formatMoney(v),
  });
}

// ---------- Экран «Регулярные» ----------

function renderRecurring() {
  const today = L.todayISO();
  const rules = state.recurring
    .map((r) => ({ r, next: r.active ? L.nextOccurrence(r, today) : null }))
    .sort((a, b) => b.r.active - a.r.active || (a.next ?? '9').localeCompare(b.next ?? '9'));
  const active = state.recurring.filter((r) => r.active);
  const perMonth = (type) => active.filter((r) => r.type === type).reduce((sum, r) => sum + L.monthlyEquivalent(r), 0);
  const hasYearly = active.some((r) => r.period === 'yearly');
  const expense = perMonth('expense');
  const income = perMonth('income');

  mount($('#view-recurring'),
    h('section', { class: 'card summary' },
      h('div', null,
        h('div', { class: 'label' }, `Регулярные расходы в месяц${hasYearly ? ' (годовые поделены на 12)' : ''}`),
        h('div', { class: 'hero' }, `${hasYearly ? '≈ ' : ''}${L.formatMoney(expense)}`)),
      income > 0 && h('div', { class: 'summary-side' },
        h('div', null, h('div', { class: 'label' }, 'Регулярные доходы'), h('div', { class: 'side-value' }, L.formatMoney(income))))),
    h('p', { class: 'hint pad-x' }, 'Подписки, аренда, зарплата — записываются в операции сами в нужный день, как только откроешь приложение.'),
    rules.length
      ? h('div', { class: 'card list' }, rules.map(({ r, next }) => {
        const c = catById(r.categoryId);
        return h('button', { type: 'button', class: `row${r.active ? '' : ' paused'}`, onclick: () => openRuleSheet(r) },
          h('span', { class: 'row-icon', 'aria-hidden': 'true' }, c.emoji),
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title' }, r.note || c.name),
            h('span', { class: 'row-sub' }, `${r.active ? (next ? `след. ${L.shortDate(next)}` : '—') : 'на паузе'} · ${r.period === 'yearly' ? 'раз в год' : 'раз в месяц'}`)),
          h('span', { class: `row-amount${r.type === 'income' ? ' pos' : ''}` }, signedMoney(r)));
      }))
      : h('div', { class: 'empty' },
        h('div', { class: 'empty-emoji', 'aria-hidden': 'true' }, '🔁'),
        h('p', null, 'Регулярных платежей пока нет.'),
        h('p', { class: 'hint' }, 'Нажми «+», чтобы добавить подписку или аренду.')),
  );
}

// ---------- Долги ----------
// Долг — не расход: дать в долг не значит потратить, поэтому в операции он не попадает.

const DEBT_LABEL = { lent: 'Мне должны', owe: 'Я должен' };
const shortDay = (iso) => `${Number(iso.slice(8, 10))} ${L.MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]}`;
const debtSign = (d, kop) => L.formatMoney(d.direction === 'lent' ? kop : -kop, { sign: true });

function debtRow(d, today) {
  const remaining = L.debtRemaining(d);
  const closed = remaining === 0;
  const overdue = L.isDebtOverdue(d, today);
  // Самое важное — первым: строка обрезается справа
  const bits = [
    closed ? 'погашен' : d.dueDate ? `${overdue ? '⏰ просрочен с' : 'до'} ${shortDay(d.dueDate)}` : `с ${shortDay(d.date)}`,
    !closed && remaining !== d.amount && `осталось из ${L.formatMoney(d.amount)}`,
    d.note,
  ].filter(Boolean);
  return h('button', { type: 'button', class: `row${closed ? ' paused' : ''}`, onclick: () => openDebtSheet(d) },
    h('span', { class: 'row-icon', 'aria-hidden': 'true' }, d.direction === 'lent' ? '📤' : '📥'),
    h('span', { class: 'row-main' },
      h('span', { class: 'row-title' }, d.person),
      h('span', { class: `row-sub${overdue ? ' neg' : ''}` }, bits.join(' · '))),
    h('span', { class: `row-amount ${d.direction === 'lent' ? 'pos' : 'neg'}` }, debtSign(d, closed ? d.amount : remaining)));
}

function renderDebts() {
  const today = L.todayISO();
  const open = state.debts.filter((d) => !L.isDebtClosed(d));
  const closed = state.debts.filter((d) => L.isDebtClosed(d));
  const s = L.summarizeDebts(state.debts);
  const shown = state.debtFilter === 'closed'
    ? [...closed].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    : L.sortDebts(open, today);
  const groups = [['lent', 'Мне должны'], ['owe', 'Я должен']]
    .map(([dir, title]) => [title, shown.filter((d) => d.direction === dir)])
    .filter(([, list]) => list.length);
  const groupSum = (list) => list.reduce((sum, d) => sum + (state.debtFilter === 'closed' ? d.amount : L.debtRemaining(d)), 0);

  mount($('#view-debts'),
    h('section', { class: 'card summary' },
      h('div', { class: 'summary-side debts-summary' },
        h('div', null, h('div', { class: 'label' }, 'Мне должны'), h('div', { class: 'side-value pos' }, L.formatMoney(s.lent))),
        h('div', null, h('div', { class: 'label' }, 'Я должен'), h('div', { class: 'side-value neg' }, L.formatMoney(s.owe)))),
      (s.lent || s.owe) ? h('p', { class: 'hint' }, `Итого ${s.net >= 0 ? 'в плюсе' : 'в минусе'}: ${L.formatMoney(s.net, { sign: true })}`) : null),
    segmented([['open', `Активные${open.length ? ` · ${open.length}` : ''}`], ['closed', 'Погашенные']], state.debtFilter, (f) => {
      state.debtFilter = f;
      render();
    }, 'Какие долги показать'),
    groups.length
      ? groups.map(([title, list]) => h('section', { class: 'day' },
        h('header', { class: 'day-head' }, h('span', null, title), h('span', null, L.formatMoney(groupSum(list)))),
        h('div', { class: 'card list' }, list.map((d) => debtRow(d, today)))))
      : h('div', { class: 'empty' },
        h('div', { class: 'empty-emoji', 'aria-hidden': 'true' }, state.debtFilter === 'closed' ? '🗂️' : '🤝'),
        h('p', null, state.debtFilter === 'closed' ? 'Погашенных долгов пока нет.' : 'Активных долгов нет.'),
        state.debtFilter === 'open' && h('p', { class: 'hint' }, 'Нажми «+», чтобы записать, кто кому должен.')),
  );
}

// Красная точка на вкладке, если есть просроченные долги
function updateDebtDot() {
  const today = L.todayISO();
  const overdue = state.debts.filter((d) => L.isDebtOverdue(d, today)).length;
  $('#debtDot').hidden = overdue === 0;
  const tab = $('.tab[data-tab="debts"]');
  if (overdue) tab.setAttribute('aria-label', `Долги: просрочено ${overdue}`);
  else tab.removeAttribute('aria-label');
}

async function remindDebt(d) {
  const text = `Привет! Напоминаю про ${L.formatMoney(L.debtRemaining(d))}${d.note ? ` (${d.note})` : ''} от ${L.shortDate(d.date)}. Спасибо!`;
  try {
    if (navigator.share) {
      await navigator.share({ text });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast('Текст напоминания скопирован');
  } catch (err) {
    if (err?.name !== 'AbortError') prompt('Скопируй напоминание:', text);
  }
}

function openDebtSheet(debt = null) {
  const today = L.todayISO();
  const draft = {
    direction: debt?.direction ?? 'lent',
    payments: [...(debt?.payments ?? [])],
    removed: new Set(debt?.removedPayments ?? []),
  };
  const amount = amountInput(debt?.amount);
  const person = h('input', { class: 'input', maxlength: 60, list: 'debtPeople', autocomplete: 'off', placeholder: 'Имя', value: debt?.person ?? '', 'aria-label': 'Кто' });
  const people = h('datalist', { id: 'debtPeople' }, L.debtPeople(state.debts).map((name) => h('option', { value: name })));
  const note = h('input', { class: 'input', maxlength: 120, enterkeyhint: 'done', placeholder: 'За что: такси, ужин, до зарплаты…', value: debt?.note ?? '' });
  const date = dateInput(debt?.date ?? today);
  const due = dateInput(debt?.dueDate ?? '');
  const err = h('p', { class: 'form-error', role: 'alert' });
  const paymentsBox = h('div', { class: 'payments' });
  const payAmount = h('input', { class: 'input', inputmode: 'decimal', autocomplete: 'off', placeholder: 'Сумма возврата', 'aria-label': 'Сумма возврата' });

  // Черновик: возвраты сохраняются вместе с остальными полями по «Готово»
  const current = () => ({ amount: L.parseAmount(amount.input.value) ?? debt?.amount ?? 0, payments: draft.payments, removedPayments: [...draft.removed] });
  const drawPayments = () => {
    const live = L.livePayments(current());
    const left = L.debtRemaining(current());
    payAmount.placeholder = left ? `Осталось ${L.formatMoney(left)}` : 'Долг погашен';
    mount(paymentsBox,
      h('p', { class: 'hint' }, `Возвращено ${L.formatMoney(L.debtPaid(current()))} из ${L.formatMoney(current().amount)}${left ? '' : ' — погашен ✅'}`),
      live.length > 0 && h('div', { class: 'card list' }, live.map((p) => h('div', { class: 'row static' },
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, L.formatMoney(p.amount)), h('span', { class: 'row-sub' }, L.shortDate(p.date))),
        h('button', {
          type: 'button',
          class: 'chip',
          'aria-label': `Удалить возврат ${L.formatMoney(p.amount)}`,
          onclick: () => {
            draft.removed.add(p.id);
            drawPayments();
          },
        }, '✕')))));
  };
  const addPayment = (kop) => {
    const left = L.debtRemaining(current());
    if (!kop) {
      err.textContent = 'Введи сумму возврата';
      return false;
    }
    if (kop > left) {
      err.textContent = `Это больше остатка долга (${L.formatMoney(left)})`;
      return false;
    }
    draft.payments.push({ id: uid(), amount: kop, date: today });
    err.textContent = '';
    payAmount.value = '';
    drawPayments();
    return true;
  };
  if (debt) drawPayments();

  openSheet({
    title: debt ? 'Долг' : 'Новый долг',
    body: [
      segmented([['lent', 'Мне должны'], ['owe', 'Я должен']], draft.direction, (dir) => { draft.direction = dir; }, 'Кто кому должен'),
      amount.el,
      err,
      field('Кто', person, people),
      field('Комментарий', note),
      field('Когда', date),
      field('Вернуть до (необязательно)', h('div', { class: 'date-row' }, due,
        h('button', { type: 'button', class: 'chip', onclick: () => { due.value = ''; } }, 'Без срока'))),
      debt && h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Возвраты'),
        paymentsBox,
        h('div', { class: 'date-row' }, payAmount,
          h('button', { type: 'button', class: 'chip', onclick: () => addPayment(L.parseAmount(payAmount.value)) }, 'Записать')),
        h('div', { class: 'btn-stack' },
          !L.isDebtClosed(debt) && h('button', {
            type: 'button',
            class: 'btn primary',
            onclick: () => {
              if (addPayment(L.debtRemaining(current()))) sheet.querySelector('form').requestSubmit();
            },
          }, '✅ Погашен полностью'),
          debt.direction === 'lent' && !L.isDebtClosed(debt) && h('button', { type: 'button', class: 'btn', onclick: () => remindDebt(debt) }, '📨 Напомнить'))),
      debt && h('button', { type: 'button', class: 'danger-btn', onclick: () => deleteDebt(debt) }, 'Удалить долг'),
      !debt && h('p', { class: 'hint' }, 'Долг не попадает в расходы и доходы — он учитывается только здесь. Частичные возвраты можно записать, открыв долг.'),
    ],
    onSave: async () => {
      const kop = L.parseAmount(amount.input.value);
      if (!kop) {
        err.textContent = 'Введи сумму больше нуля';
        amount.input.focus();
        return false;
      }
      const name = person.value.trim();
      if (!name) {
        err.textContent = 'Укажи, кто';
        person.focus();
        return false;
      }
      if (!L.isISODate(date.value)) {
        err.textContent = 'Укажи дату';
        return false;
      }
      if (due.value && due.value < date.value) {
        err.textContent = 'Срок возврата раньше даты долга';
        return false;
      }
      const item = {
        ...(debt ?? { id: uid(), createdAt: Date.now() }),
        direction: draft.direction,
        amount: kop,
        person: name,
        note: note.value.trim(),
        date: date.value,
        dueDate: due.value || null,
        payments: draft.payments,
        removedPayments: [...draft.removed],
      };
      await persist([{ store: 'debts', put: item }]);
      render();
      const closedNow = L.isDebtClosed(item) && !(debt && L.isDebtClosed(debt));
      toast(closedNow ? `Долг: ${item.person} — погашен 🎉` : debt ? 'Сохранено' : `Записано: ${DEBT_LABEL[item.direction].toLowerCase()} ${L.formatMoney(kop)}`);
      return true;
    },
  });
  if (!debt) amount.input.focus();
}

async function deleteDebt(debt) {
  await persist([{ store: 'debts', delete: debt }]);
  closeSheet();
  render();
  toast('Долг удалён', {
    label: 'Вернуть',
    run: async () => {
      await persist([{ store: 'debts', put: debt }]);
      render();
    },
  });
}

// ---------- Экран «Настройки» ----------

function renderSettings() {
  const type = state.catType;
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) await importBackup(file);
    },
  });
  const count = state.transactions.length;
  const persisted = h('span', null);
  navigator.storage?.persisted?.().then((ok) => {
    persisted.textContent = ok ? ' Хранилище защищено от автоочистки.' : '';
  }).catch(() => {});

  mount($('#view-settings'),
    installCard({ dismissible: false }),

    h('h2', { class: 'section-head' }, 'Защита'),
    securitySection(),

    h('h2', { class: 'section-head' }, 'Синхронизация'),
    syncSection(),

    h('h2', { class: 'section-head' }, 'Быстрые кнопки'),
    presetsSection(),

    h('h2', { class: 'section-head' }, 'Категории'),
    segmented([['expense', 'Расходы'], ['income', 'Доходы']], type, (t) => { state.catType = t; render(); }, 'Тип категорий'),
    h('div', { class: 'card list gap-top' },
      catsOfType(type).map((c) => h('button', { type: 'button', class: 'row', onclick: () => openCategorySheet(c, type) },
        h('span', { class: 'row-icon', 'aria-hidden': 'true' }, c.emoji),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, c.name)),
        h('span', { class: 'chevron', 'aria-hidden': 'true' }, '›'))),
      h('button', { type: 'button', class: 'row accent', onclick: () => openCategorySheet(null, type) },
        h('span', { class: 'row-icon', 'aria-hidden': 'true' }, '＋'),
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, 'Новая категория')))),

    h('h2', { class: 'section-head' }, 'Данные'),
    h('div', { class: 'card pad' },
      h('p', { class: 'hint' },
        sync.config
          ? `На этом устройстве и в GitHub: ${count} ${L.plural(count, TX_FORMS)}. `
          : `Всё хранится только на этом устройстве: ${count} ${L.plural(count, TX_FORMS)}. `,
        state.lastBackup ? `Последняя копия: ${new Date(state.lastBackup).toLocaleDateString('ru-RU')}.` : 'Резервных копий ещё не было.',
        persisted),
      h('div', { class: 'btn-stack' },
        h('button', { type: 'button', class: 'btn primary', onclick: exportBackup }, '💾 Сохранить резервную копию'),
        h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, '📂 Восстановить из копии'),
        h('button', { type: 'button', class: 'btn', onclick: exportCSV, disabled: !count }, '📊 Выгрузить в CSV (Excel, Numbers)')),
      fileInput),

    h('h2', { class: 'section-head' }, 'Опасная зона'),
    h('button', { type: 'button', class: 'danger-btn full', onclick: clearAll }, 'Удалить все данные'),

    h('p', { class: 'hint footer' }, `Трекер расходов · версия ${IS_DEV ? 'dev' : APP_BUILD}`),
  );
}

// ---------- Общий рендер и навигация ----------

const VIEWS = { list: renderList, stats: renderStats, recurring: renderRecurring, debts: renderDebts, settings: renderSettings };

function render() {
  const { tab } = state;
  for (const name of Object.keys(VIEWS)) $(`#view-${name}`).hidden = name !== tab;
  document.querySelectorAll('.tab').forEach((b) => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#title').textContent = TITLES[tab];
  $('#monthSwitch').hidden = !(tab === 'list' || tab === 'stats');
  const monthLabel = $('#monthLabel');
  const [y, m] = state.month.split('-').map(Number);
  mount(monthLabel,
    h('span', { class: 'm-long' }, L.monthTitle(state.month)),
    h('span', { class: 'm-short' }, `${L.MONTHS_SHORT[m - 1]} ${y}`));
  monthLabel.classList.toggle('not-current', state.month !== L.monthKey(L.todayISO()));
  $('#addBtn').hidden = tab === 'settings';
  updateDebtDot();
  VIEWS[tab]();
}

function bindStatic() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    if (state.tab === b.dataset.tab) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    state.tab = b.dataset.tab;
    render();
    window.scrollTo(0, 0);
  }));
  document.querySelectorAll('[data-month]').forEach((b) => b.addEventListener('click', () => {
    state.month = L.shiftMonth(state.month, Number(b.dataset.month));
    render();
  }));
  $('#monthLabel').addEventListener('click', () => {
    state.month = L.monthKey(L.todayISO());
    render();
  });
  $('#addBtn').addEventListener('click', () => {
    if (state.tab === 'recurring') openRuleSheet();
    else if (state.tab === 'debts') openDebtSheet();
    else openTxSheet();
  });

  // Вернулись в приложение (например, на следующий день) — дописываем платежи
  // и забираем изменения с других устройств; уходим — отправляем несохранённое
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') {
      if (sync.dirty) runSync();
      return;
    }
    const added = await applyRecurring();
    if (added) {
      render();
      toast(`Записаны регулярные платежи: ${added}`);
    }
    runSync();
  });
  window.addEventListener('online', () => runSync());
  setInterval(() => document.visibilityState === 'visible' && runSync(), 60_000);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.tab === 'stats' && render(), 150);
  });
}

function registerServiceWorker() {
  // В dev-сборке кэш не нужен: иначе правки не видны без ручной очистки
  if (!('serviceWorker' in navigator) || IS_DEV) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // первая установка — перезагружать незачем
    if (sheet.open) reloadWhenSheetCloses = true;
    else location.reload();
  });
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker не зарегистрирован', err));
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* не поддерживается — живём без этого */
  }
}

async function init() {
  bindStatic();
  bindLock();
  try {
    // Сначала блокировка — чтобы данные не мелькнули до экрана PIN
    const [lockRecord, attempts] = await Promise.all([db.getMeta('lock'), db.getMeta('lockAttempts')]);
    if (lockRecord) {
      lock.record = lockRecord;
      Object.assign(lock, { failures: attempts?.failures ?? 0, lockedUntil: attempts?.lockedUntil ?? 0 });
      showLock();
    }
    Lock.biometricAvailable().then((ok) => {
      lock.bioAvailable = ok;
      if (lock.locked) renderLock();
      else if (state.tab === 'settings' && !sheet.open) renderSettings();
    });
    const [lastBackup, backupSnooze, syncConfig, syncState] = await Promise.all([
      db.getMeta('lastBackup'),
      db.getMeta('backupSnooze'),
      db.getMeta('syncConfig'),
      db.getMeta('syncState'),
    ]);
    await loadState();
    Object.assign(state, { lastBackup: lastBackup ?? null, backupSnooze: backupSnooze ?? null });
    // При запуске читаем файл целиком (etag сброшен), дальше — условными запросами
    if (syncConfig) Object.assign(sync, syncState ?? {}, { config: syncConfig, etag: null, status: 'ok' });
    if (!state.categories.length) {
      state.categories = L.defaultCategories();
      await db.bulk(state.categories.map((c) => ({ store: 'categories', put: c })));
    }
    await seedPresets();
    const added = await applyRecurring();
    render();
    updateSyncBadge();
    if (added) toast(`Записаны регулярные платежи: ${added}`);
    runSync();
  } catch (err) {
    console.error(err);
    mount($('#view-list'), h('div', { class: 'card banner' },
      h('strong', null, 'Не удалось открыть хранилище'),
      h('p', { class: 'hint' }, 'Возможно, включён приватный режим Safari или закончилось место. ', String(err?.message ?? err))));
  }
  registerServiceWorker();
  requestPersistentStorage();
}

init();
