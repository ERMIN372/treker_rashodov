import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../app/js/logic.js';

// Intl в ru-RU разделяет разряды неразрывным пробелом — приводим к обычному
const plain = (s) => s.replace(/[  ]/g, ' ');
const tx = (date, amount, type = 'expense', categoryId = 'exp-food', extra = {}) => ({ id: `${date}-${amount}-${type}`, date, amount, type, categoryId, ...extra });

test('parseAmount: рубли с копейками, запятая и точка', () => {
  assert.equal(L.parseAmount('350'), 35000);
  assert.equal(L.parseAmount('1 234,56'), 123456);
  assert.equal(L.parseAmount('0,29'), 29);
  assert.equal(L.parseAmount('12.5'), 1250);
  assert.equal(L.parseAmount(',5'), 50);
  assert.equal(L.parseAmount('100,'), 10000);
  assert.equal(L.parseAmount('499 ₽'), 49900);
});

test('parseAmount: отбрасывает мусор, ноль и лишние знаки', () => {
  for (const bad of ['', ' ', '0', '0,00', 'abc', '1,234', '1.2.3', '-5', '12,345', '1e5', null, undefined, '9999999999']) {
    assert.equal(L.parseAmount(bad), null, String(bad));
  }
});

test('amountToInput — обратное преобразование для формы', () => {
  assert.equal(L.amountToInput(35000), '350');
  assert.equal(L.amountToInput(123456), '1234,56');
  assert.equal(L.amountToInput(1250), '12,50');
  assert.equal(L.parseAmount(L.amountToInput(123456)), 123456);
});

test('formatMoney', () => {
  assert.equal(plain(L.formatMoney(123456)), '1 234,56 ₽');
  assert.equal(plain(L.formatMoney(100000)), '1 000 ₽');
  assert.equal(plain(L.formatMoney(-5000)), '−50 ₽');
  assert.equal(plain(L.formatMoney(5000, { sign: true })), '+50 ₽');
  assert.equal(plain(L.formatMoney(0, { sign: true })), '0 ₽');
});

test('formatPercent и plural', () => {
  assert.equal(L.formatPercent(0.123), '12%');
  assert.equal(L.formatPercent(0.004), '<1%');
  assert.equal(L.formatPercent(0), '0%');
  const forms = ['операция', 'операции', 'операций'];
  const cases = { 1: 'операция', 2: 'операции', 4: 'операции', 5: 'операций', 11: 'операций', 12: 'операций', 21: 'операция', 22: 'операции', 111: 'операций', 0: 'операций' };
  for (const [n, want] of Object.entries(cases)) assert.equal(L.plural(Number(n), forms), want, n);
});

test('niceTicks: круглые деления, последнее не меньше максимума', () => {
  assert.deepEqual(L.niceTicks(0), [0]);
  assert.deepEqual(L.niceTicks(9500), [0, 2500, 5000, 7500, 10000]);
  assert.deepEqual(L.niceTicks(37), [0, 10, 20, 30, 40]);
  assert.deepEqual(L.niceTicks(40), [0, 10, 20, 30, 40]);
  for (const max of [1, 3.3, 123, 98765, 1_234_567]) {
    const t = L.niceTicks(max);
    assert.ok(t.at(-1) >= max, `max ${max}`);
    assert.ok(t.length <= 6, `ticks ${t}`);
  }
});

test('даты: shiftMonth, addDays, dayTitle', () => {
  assert.equal(L.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(L.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(L.shiftMonth('2026-09', -6), '2026-03');
  assert.equal(L.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(L.addDays('2024-12-31', 1), '2025-01-01');
  assert.equal(L.monthTitle('2026-09'), 'Сентябрь 2026');
  assert.equal(L.dayTitle('2026-09-24', '2026-09-24'), 'Сегодня');
  assert.equal(L.dayTitle('2026-09-23', '2026-09-24'), 'Вчера');
  assert.equal(L.dayTitle('2026-09-01', '2026-09-24'), '1 сентября, вт');
  assert.equal(L.dayTitle('2025-12-31', '2026-09-24'), '31 декабря 2025, ср');
});

test('toISODate берёт локальную дату, а не UTC', () => {
  assert.equal(L.toISODate(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
  assert.equal(L.toISODate(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
});

test('summarize, byCategory, byDay, byMonth', () => {
  const txs = [
    tx('2026-09-01', 10000),
    tx('2026-09-01', 5000, 'expense', 'exp-cafe'),
    tx('2026-09-15', 2500),
    tx('2026-09-10', 100000, 'income', 'inc-salary'),
    tx('2026-08-31', 7000),
  ];
  const sep = L.inMonth(txs, '2026-09');
  assert.equal(sep.length, 4);
  assert.deepEqual(L.summarize(sep), { expense: 17500, income: 100000, balance: 82500 });
  assert.deepEqual(L.byCategory(sep, 'expense'), [
    { categoryId: 'exp-food', total: 12500, count: 2 },
    { categoryId: 'exp-cafe', total: 5000, count: 1 },
  ]);
  const days = L.byDay(txs, '2026-09', 'expense');
  assert.equal(days.length, 30);
  assert.equal(days[0], 15000);
  assert.equal(days[14], 2500);
  assert.equal(days.reduce((a, b) => a + b), 17500);
  assert.deepEqual(L.byMonth(txs, '2026-09', 3), [
    { month: '2026-07', expense: 0, income: 0 },
    { month: '2026-08', expense: 7000, income: 0 },
    { month: '2026-09', expense: 17500, income: 100000 },
  ]);
});

test('groupByDate: свежие дни сверху, итоги по дню', () => {
  const groups = L.groupByDate([
    tx('2026-09-01', 100, 'expense', 'a', { createdAt: 1 }),
    tx('2026-09-03', 300, 'expense', 'a', { createdAt: 3 }),
    tx('2026-09-01', 200, 'income', 'b', { createdAt: 2 }),
  ]);
  assert.deepEqual(groups.map((g) => g.date), ['2026-09-03', '2026-09-01']);
  assert.equal(groups[1].items[0].createdAt, 2);
  assert.equal(groups[1].expense, 100);
  assert.equal(groups[1].income, 200);
});

test('comparePeriods: текущий месяц сравнивается с тем же отрезком прошлого', () => {
  const txs = [tx('2026-08-05', 1000), tx('2026-08-20', 9000), tx('2026-09-03', 1500)];
  const cur = L.comparePeriods(txs, '2026-09', '2026-09-10');
  assert.equal(cur.partialDay, 10);
  assert.equal(cur.prev.expense, 1000);
  assert.equal(cur.cur.expense, 1500);
  assert.equal(L.percentChange(cur.cur.expense, cur.prev.expense), 0.5);
  const past = L.comparePeriods(txs, '2026-09', '2026-10-02');
  assert.equal(past.partialDay, null);
  assert.equal(past.prev.expense, 10000);
  assert.equal(L.percentChange(5, 0), null);
});

test('daysForAverage', () => {
  assert.equal(L.daysForAverage('2026-09', '2026-09-24'), 24);
  assert.equal(L.daysForAverage('2026-02', '2026-09-24'), 28);
});

test('nthOccurrence: 31-е число переезжает на конец короткого месяца', () => {
  assert.equal(L.nthOccurrence('2026-01-31', 'monthly', 1), '2026-02-28');
  assert.equal(L.nthOccurrence('2026-01-31', 'monthly', 2), '2026-03-31');
  assert.equal(L.nthOccurrence('2024-01-31', 'monthly', 1), '2024-02-29');
  assert.equal(L.nthOccurrence('2026-11-15', 'monthly', 3), '2027-02-15');
  assert.equal(L.nthOccurrence('2024-02-29', 'yearly', 1), '2025-02-28');
  assert.equal(L.nthOccurrence('2024-02-29', 'yearly', 4), '2028-02-29');
});

test('dueOccurrences: догоняет пропущенное и не дублирует', () => {
  const rule = { startDate: '2026-07-15', period: 'monthly', lastDate: null };
  assert.deepEqual(L.dueOccurrences(rule, '2026-09-24'), ['2026-07-15', '2026-08-15', '2026-09-15']);
  assert.deepEqual(L.dueOccurrences({ ...rule, lastDate: '2026-08-15' }, '2026-09-24'), ['2026-09-15']);
  assert.deepEqual(L.dueOccurrences({ ...rule, lastDate: '2026-09-15' }, '2026-09-24'), []);
  assert.deepEqual(L.dueOccurrences(rule, '2026-07-15'), ['2026-07-15']);
  assert.deepEqual(L.dueOccurrences(rule, '2026-07-14'), []);
  assert.deepEqual(L.dueOccurrences({ ...rule, period: 'yearly' }, '2028-07-15'), ['2026-07-15', '2027-07-15', '2028-07-15']);
});

test('nextOccurrence и описание периода', () => {
  const rule = { startDate: '2026-01-31', period: 'monthly', lastDate: '2026-08-31' };
  assert.equal(L.nextOccurrence(rule, '2026-09-24'), '2026-09-30');
  assert.equal(L.nextOccurrence({ ...rule, lastDate: null, startDate: '2026-12-01' }, '2026-09-24'), '2026-12-01');
  assert.equal(L.periodTitle(rule), 'каждый месяц, 31-го');
  assert.equal(L.periodTitle({ startDate: '2026-03-08', period: 'yearly' }), 'каждый год, 8 марта');
  assert.equal(L.monthlyEquivalent({ amount: 120000, period: 'yearly' }), 10000);
});

test('категории: «Другое» последней и восстанавливается при импорте', () => {
  const cats = L.defaultCategories();
  const extra = { id: 'x', type: 'expense', name: 'Кот', emoji: '🐈', order: 99 };
  const sorted = L.sortCategories([...cats, extra]).filter((c) => c.type === 'expense');
  assert.equal(sorted.at(-1).id, 'exp-other');
  assert.equal(sorted.at(-2).id, 'x');
  const fixed = L.withRequiredCategories([extra]);
  assert.ok(fixed.some((c) => c.id === 'exp-other'));
  assert.ok(fixed.some((c) => c.id === 'inc-other'));
});

test('toCSV: формат для русского Excel и защита от формул', () => {
  const csv = L.toCSV(
    [tx('2026-09-02', 123456, 'expense', 'exp-food', { note: '=HYPERLINK("x")' }), tx('2026-09-01', 5000, 'income', 'inc-salary', { note: 'аванс; часть' })],
    L.defaultCategories(),
  );
  assert.ok(csv.startsWith('﻿Дата;Тип;Категория;Сумма;Комментарий\r\n'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[1], '2026-09-01;Доход;Зарплата;50,00;"аванс; часть"');
  assert.equal(lines[2], `2026-09-02;Расход;Продукты;-1234,56;"'=HYPERLINK(""x"")"`);
});

test('резервная копия: туда и обратно, битые файлы отклоняются', () => {
  const data = {
    transactions: [tx('2026-09-01', 100)],
    categories: L.defaultCategories(),
    recurring: [{ id: 'r1', type: 'expense', amount: 29900, categoryId: 'exp-subs', startDate: '2026-01-05', period: 'monthly', lastDate: null, active: true }],
  };
  const restored = L.parseBackup(JSON.stringify(L.makeBackup(data, new Date('2026-09-24T10:00:00Z'))));
  assert.deepEqual(restored, { ...data, debts: [], presets: [] }, 'старые копии без долгов и кнопок читаются');

  assert.throws(() => L.parseBackup('не json'), /JSON/);
  assert.throws(() => L.parseBackup('{"a":1}'), /не резервная копия/);
  const broken = L.makeBackup({ ...data, transactions: [{ ...data.transactions[0], amount: -5 }] });
  assert.throws(() => L.parseBackup(JSON.stringify(broken)), /операция №1/);
});

test('быстрые кнопки: разбор сумм', () => {
  assert.deepEqual(L.parseAmounts('200, 300, 400, 500'), [20000, 30000, 40000, 50000]);
  assert.deepEqual(L.parseAmounts('230'), [23000]);
  assert.deepEqual(L.parseAmounts('99,90'), [9990], 'запятая без пробела — копейки');
  assert.deepEqual(L.parseAmounts('200 / 300; 400'), [20000, 30000, 40000]);
  for (const bad of ['', 'abc', '200, 0', '1,2,3', '1, 2, 3, 4, 5, 6, 7, 8, 9']) assert.equal(L.parseAmounts(bad), null, bad);
  assert.equal(L.formatAmounts([20000, 9990]), '200, 99,90');
  assert.deepEqual(L.sortPresets([{ label: 'Б', order: 2 }, { label: 'А', order: 2 }, { label: 'В', order: 1 }]).map((p) => p.label), ['В', 'А', 'Б']);
});

test('сводка для ИИ: промпт, сравнение месяцев, приватность', () => {
  const cats = [...L.defaultCategories(), { id: 'exp-tobacco', type: 'expense', name: 'Табак', emoji: '🚬', order: 50 }];
  const tx = (id, date, amount, categoryId, note = '', type = 'expense') => ({ id, date, amount, categoryId, note, type });
  const transactions = [
    tx('a1', '2026-08-05', 100000, 'exp-food', 'Ашан'),
    tx('a2', '2026-08-10', 300000, 'inc-salary', 'зп', 'income'),
    tx('s1', '2026-09-02', 23000, 'exp-tobacco', 'Стики IQOS'),
    tx('s2', '2026-09-05', 23000, 'exp-tobacco', 'Стики IQOS'),
    tx('s3', '2026-09-09', 23000, 'exp-tobacco', 'Стики IQOS'),
    tx('f1', '2026-09-10', 150000, 'exp-food', 'Ашан'),
    tx('c1', '2026-09-12', 540000, 'exp-clothes', 'Секретная покупка'),
  ];
  const debts = [{ id: 'd', direction: 'lent', person: 'Лёха Иванов', amount: 150000, date: '2026-09-01', payments: [] }];
  const recurring = [{ id: 'r', type: 'expense', amount: 29900, categoryId: 'exp-subs', note: 'Spotify', startDate: '2026-01-15', period: 'monthly', active: true }];
  const data = { transactions, categories: cats, recurring, debts };

  const text = L.aiSummary(data, { month: '2026-09', today: '2026-09-25' });
  assert.ok(text.startsWith(L.AI_PROMPT), 'сначала промпт');
  assert.match(text, /сентябрь 2026 \(данные по 25 число — месяц ещё идёт\)/);
  assert.match(text, /Продукты: 1 000 ₽ \/ 1 500 ₽ \(\+50% к прошлому\)/, 'сравнение с прошлым месяцем в процентах');
  assert.ok(!text.includes('Июль'), 'пустой июль не засоряет сводку');
  assert.ok(!/\d+ сентября, Табак: 230/.test(text), 'частые мелкие не дублируются в крупнейших');
  assert.match(text, /\d+ сентября, Одежда: 5 400 ₽/, 'крупная разовая трата в списке');
  assert.match(text, /Табак: 3 раз, в среднем 230 ₽, всего 690 ₽/, 'частые траты');
  assert.match(text, /мне должны 1 500 ₽/);
  assert.match(text, /Подписки: 299 ₽ в месяц/);
  for (const secret of ['Лёха', 'Иванов', 'Секретная', 'Spotify', 'Ашан']) assert.ok(!text.includes(secret), `без комментариев и имён: ${secret}`);

  const withNotes = L.aiSummary(data, { month: '2026-09', today: '2026-09-25', includeNotes: true });
  assert.ok(withNotes.includes('Секретная покупка') && withNotes.includes('Spotify'), 'с разрешения комментарии есть');
  assert.ok(!withNotes.includes('Лёха'), 'имена из долгов не уходят никогда');

  const empty = L.aiSummary({ transactions: [], categories: cats }, { month: '2026-09', today: '2026-09-25' });
  assert.match(empty, /расходы 0 ₽/);
});

test('резервная копия: быстрые кнопки сохраняются и проверяются', () => {
  const preset = { id: 'p', label: 'Стики', emoji: '🚬', type: 'expense', categoryId: 'exp-tobacco', amounts: [23000], order: 1 };
  const data = { transactions: [], categories: L.defaultCategories(), recurring: [], debts: [], presets: [preset] };
  assert.deepEqual(L.parseBackup(JSON.stringify(L.makeBackup(data))).presets, [preset]);
  const bad = L.makeBackup({ ...data, presets: [{ ...preset, amounts: [] }] });
  assert.throws(() => L.parseBackup(JSON.stringify(bad)), /быстрая кнопка №1/);
});
