// Столбчатая диаграмма на SVG без библиотек.
// Столбец не толще 24px, скругление 4px только сверху, 2px зазор между соседями,
// волосяная сетка, одна ось Y. Значение — по тапу/наведению/фокусу.
import { formatCompact, niceTicks } from './logic.js';

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function div(className, ...children) {
  const el = document.createElement('div');
  el.className = className;
  el.append(...children);
  return el;
}

// Столбец с закруглённым верхом и прямым основанием
function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

/**
 * @param {HTMLElement} host контейнер (position: relative), уже в DOM
 * @param {object} o
 * @param {string[]} o.labels подписи по X (пустая строка — без подписи)
 * @param {{name: string, color: string, values: number[]}[]} o.series значения в копейках
 * @param {(i: number) => string} o.tipTitle заголовок подсказки
 * @param {(kop: number) => string} o.format формат значения
 */
export function columnChart(host, { labels, series, tipTitle, format, height = 180 }) {
  host._abort?.abort();
  const abort = new AbortController();
  host._abort = abort;
  host.replaceChildren();

  const width = Math.max(host.clientWidth, 240);
  const pad = { top: 12, right: 4, bottom: 24, left: 46 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseY = pad.top + plotH;
  const ticks = niceTicks(Math.max(0, ...series.flatMap((s) => s.values)) / 100);
  const top = ticks.at(-1) || 1;
  const yOf = (kop) => baseY - (kop / 100 / top) * plotH;

  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'chart-svg' });

  for (const t of ticks) {
    const y = Math.round(yOf(t * 100)) + 0.5;
    root.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, class: t === 0 ? 'axis' : 'grid' }));
    const label = svg('text', { x: pad.left - 8, y, class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
    label.textContent = t === 0 ? '0' : formatCompact(t);
    root.append(label);
  }

  const n = labels.length;
  const band = plotW / n;
  const gap = 2;
  const s = series.length;
  const barW = Math.max(2, Math.min(24, (band - gap * 2 - gap * (s - 1)) / s));
  const groupW = s * barW + (s - 1) * gap;
  const groups = [];

  for (let i = 0; i < n; i++) {
    const g = svg('g', { class: 'bar-group' });
    const x0 = pad.left + band * i + (band - groupW) / 2;
    series.forEach((ser, j) => {
      const v = ser.values[i];
      if (v <= 0) return;
      const y = Math.min(yOf(v), baseY - 2); // крошечные суммы всё равно видны
      g.append(svg('path', { d: barPath(x0 + j * (barW + gap), y, barW, baseY - y, 4), fill: ser.color }));
    });
    const hit = svg('rect', { x: pad.left + band * i, y: pad.top, width: band, height: plotH + pad.bottom, class: 'hit', tabindex: 0 });
    hit.setAttribute('aria-label', `${tipTitle(i)}: ${series.map((ser) => `${ser.name} ${format(ser.values[i])}`).join(', ')}`);
    hit.addEventListener('focus', () => show(i));
    hit.addEventListener('blur', hide);
    g.append(hit);
    root.append(g);
    groups.push(g);

    if (labels[i]) {
      const label = svg('text', { x: pad.left + band * (i + 0.5), y: height - 6, class: 'tick', 'text-anchor': 'middle' });
      label.textContent = labels[i];
      root.append(label);
    }
  }

  const tip = div('chart-tip');
  tip.hidden = true;
  host.append(root, tip);

  let active = -1;
  function show(i) {
    if (active === i) return;
    active = i;
    groups.forEach((g, k) => g.classList.toggle('is-active', k === i));
    root.classList.add('has-active');
    const rows = series.map((ser) => {
      const key = document.createElement('span');
      key.className = 'tip-key';
      key.style.background = ser.color;
      const value = document.createElement('strong');
      value.textContent = format(ser.values[i]);
      const name = document.createElement('span');
      name.textContent = ser.name;
      return div('tip-row', key, value, name);
    });
    const title = div('tip-title');
    title.textContent = tipTitle(i);
    tip.replaceChildren(title, ...rows);
    tip.hidden = false;
    const tallest = Math.min(...series.map((ser) => yOf(ser.values[i])));
    const cx = pad.left + band * (i + 0.5);
    const left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, tallest - tip.offsetHeight - 8)}px`;
  }
  function hide() {
    active = -1;
    tip.hidden = true;
    root.classList.remove('has-active');
    groups.forEach((g) => g.classList.remove('is-active'));
  }
  function pick(e) {
    const i = Math.floor((e.clientX - root.getBoundingClientRect().left - pad.left) / band);
    if (i >= 0 && i < n) show(i);
  }

  root.addEventListener('pointerdown', pick, { signal: abort.signal });
  root.addEventListener('pointermove', pick, { signal: abort.signal });
  root.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hide(), { signal: abort.signal });
  document.addEventListener('pointerdown', (e) => !host.contains(e.target) && hide(), { signal: abort.signal });
}
