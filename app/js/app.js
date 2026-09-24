import { db } from './db.js';
import * as L from './logic.js';
import { columnChart } from './charts.js';

// При деплое метка заменяется на короткий хэш коммита (см. .github/workflows/pages.yml).
// Сравнивать с самой меткой нельзя — sed заменит и её, поэтому проверяем префикс.
const APP_BUILD = '__BUILD__';
const IS_DEV = APP_BUILD.startsWith('__');

const SERIES_COLOR = { expense: 'var(--s-expense)', income: 'var(--s-income)' };
const TYPE_LABEL = { expense: 'Расход', income: 'Доход' };
const TITLES = { list: 'Операции', stats: 'Статистика', recurring: 'Регулярные', settings: 'Настройки' };
const TX_FORMS = ['операция', 'операции', 'операций'];
const BACKUP_EVERY_MS = 30 * 24 * 3600 * 1000;
const SNOOZE_MS = 7 * 24 * 3600 * 1000;

const state = {
  transactions: [],
  categories: [],
  recurring: [],
  month: L.monthKey(L.todayISO()),
  tab: 'list',
  statsType: 'expense',
  catType: 'expense',
  filterCategory: null,
  lastBackup: null,
  backupSnooze: null,
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
  sheet.showModal();
}

function closeSheet() {
  if (sheet.open) sheet.close();
}

sheet.addEventListener('click', (e) => e.target === sheet && closeSheet());
sheet.addEventListener('close', () => {
  sheet.replaceChildren();
  if (reloadWhenSheetCloses) location.reload();
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

function openTxSheet(tx = null) {
  const today = L.todayISO();
  const draft = { type: tx?.type ?? 'expense', categoryId: tx?.categoryId ?? null };
  const amount = amountInput(tx?.amount);
  const err = h('p', { class: 'form-error', role: 'alert' });
  const picker = categoryPicker(draft.type, draft.categoryId, (id) => {
    draft.categoryId = id;
    err.textContent = '';
  });
  const date = dateInput(tx?.date ?? defaultDate());
  const note = h('input', { class: 'input', maxlength: 120, enterkeyhint: 'done', placeholder: 'Необязательно', value: tx?.note ?? '' });
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
      await db.put('transactions', item);
      upsert(state.transactions, item);
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
  await db.delete('transactions', tx.id);
  removeById(state.transactions, tx.id);
  closeSheet();
  render();
  toast('Операция удалена', {
    label: 'Вернуть',
    run: async () => {
      await db.put('transactions', tx);
      upsert(state.transactions, tx);
      render();
    },
  });
}

// ---------- Регулярные платежи ----------

// Записывает все наступившие платежи. id операции детерминирован
// (правило + дата), поэтому повторный запуск не создаст дублей.
let recurringRun = null;
function applyRecurring() {
  recurringRun ??= (async () => {
    const today = L.todayISO();
    const newTx = [];
    const updated = [];
    for (const r of state.recurring) {
      if (!r.active) continue;
      const dates = L.dueOccurrences(r, today);
      if (!dates.length) continue;
      for (const date of dates) {
        newTx.push({ id: `rec-${r.id}-${date}`, type: r.type, amount: r.amount, categoryId: r.categoryId, date, note: r.note ?? '', recurringId: r.id, createdAt: Date.now() });
      }
      updated.push({ ...r, lastDate: dates.at(-1) });
    }
    if (!updated.length) return 0;
    await db.bulk([...newTx.map((t) => ({ store: 'transactions', put: t })), ...updated.map((r) => ({ store: 'recurring', put: r }))]);
    newTx.forEach((t) => upsert(state.transactions, t));
    updated.forEach((r) => upsert(state.recurring, r));
    return newTx.length;
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
      await db.put('recurring', item);
      upsert(state.recurring, item);
      const added = await applyRecurring();
      render();
      toast(added ? `Сохранено, записано платежей: ${added}` : 'Сохранено');
      return true;
    },
  });
  if (!rule) amount.input.focus();
}

async function deleteRule(rule) {
  await db.delete('recurring', rule.id);
  removeById(state.recurring, rule.id);
  closeSheet();
  render();
  toast('Удалено. Уже записанные операции остались', {
    label: 'Вернуть',
    run: async () => {
      await db.put('recurring', rule);
      upsert(state.recurring, rule);
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
      await db.put('categories', item);
      upsert(state.categories, item);
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
  const moved = txs.length ? ` ${txs.length} ${L.plural(txs.length, TX_FORMS)} перейдут в «${catById(other).name}».` : '';
  if (!confirm(`Удалить категорию «${cat.name}»?${moved}`)) return;
  await db.bulk([
    ...txs.map((t) => ({ store: 'transactions', put: t })),
    ...rules.map((r) => ({ store: 'recurring', put: r })),
    { store: 'categories', delete: cat.id },
  ]);
  txs.forEach((t) => upsert(state.transactions, t));
  rules.forEach((r) => upsert(state.recurring, r));
  removeById(state.categories, cat.id);
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
  if (!confirm(`Заменить текущие данные (${cur} ${L.plural(cur, TX_FORMS)}) данными из копии (${next} ${L.plural(next, TX_FORMS)})? Текущие данные пропадут.`)) return;
  data.categories = L.withRequiredCategories(data.categories);
  await db.replaceAll(data);
  Object.assign(state, data, { filterCategory: null });
  await applyRecurring();
  render();
  toast('Данные восстановлены из копии');
}

async function clearAll() {
  if (!confirm('Удалить все операции, категории и регулярные платежи? Сначала лучше сохранить резервную копию.')) return;
  if (!confirm('Точно удалить? Вернуть можно будет только из резервной копии.')) return;
  await db.clearAll();
  Object.assign(state, { transactions: [], recurring: [], categories: L.defaultCategories(), filterCategory: null, lastBackup: null, backupSnooze: null });
  await db.bulk(state.categories.map((c) => ({ store: 'categories', put: c })));
  render();
  toast('Все данные удалены');
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
  if (state.transactions.length < 10 || !stale || snoozed) return null;
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
        `Всё хранится только на этом устройстве: ${count} ${L.plural(count, TX_FORMS)}. `,
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

const VIEWS = { list: renderList, stats: renderStats, recurring: renderRecurring, settings: renderSettings };

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
  monthLabel.textContent = L.monthTitle(state.month);
  monthLabel.classList.toggle('not-current', state.month !== L.monthKey(L.todayISO()));
  $('#addBtn').hidden = tab === 'settings';
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
  $('#addBtn').addEventListener('click', () => (state.tab === 'recurring' ? openRuleSheet() : openTxSheet()));

  // Вернулись в приложение (например, на следующий день) — дописываем платежи
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const added = await applyRecurring();
    if (added) {
      render();
      toast(`Записаны регулярные платежи: ${added}`);
    }
  });

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
  try {
    const [transactions, categories, recurring, lastBackup, backupSnooze] = await Promise.all([
      db.getAll('transactions'),
      db.getAll('categories'),
      db.getAll('recurring'),
      db.getMeta('lastBackup'),
      db.getMeta('backupSnooze'),
    ]);
    Object.assign(state, { transactions, categories, recurring, lastBackup: lastBackup ?? null, backupSnooze: backupSnooze ?? null });
    if (!categories.length) {
      state.categories = L.defaultCategories();
      await db.bulk(state.categories.map((c) => ({ store: 'categories', put: c })));
    }
    const added = await applyRecurring();
    render();
    if (added) toast(`Записаны регулярные платежи: ${added}`);
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
