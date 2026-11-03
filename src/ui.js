// Kleine DOM-Helfer. Text läuft immer über textContent, Songtitel werden nie als HTML gesetzt.
export function h(spec, props = {}, ...kids) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'open') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter(c => c !== null && c !== undefined && c !== false));
  return el;
}

export const btn = (label, onClick, kind = '') => h(`button.btn${kind ? `.${kind}` : ''}`, { type: 'button', onClick }, label);

// Löschen in zwei Schritten statt Browser-Dialog.
export function confirmBtn(label, sure, onConfirm) {
  const b = btn(label, () => {
    if (b.dataset.armed) { onConfirm(); return; }
    b.dataset.armed = '1';
    b.textContent = sure;
    setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 4000);
  }, 'ghost');
  return b;
}

let toastTimer;
export function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

export function download(name, text, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function paged(items, row, size = 100) {
  const list = h('ul.rows');
  const more = btn('', () => show(), 'ghost');
  let at = 0;
  const show = () => {
    list.append(...items.slice(at, at + size).map(row));
    at += size;
    more.hidden = at >= items.length;
    more.textContent = `${Math.min(size, items.length - at)} weitere zeigen`;
  };
  show();
  return h('div', {}, list, more);
}

/* ---------- Rücken-Streifen: jeder Song ein Plattenrücken, Höhe nach Länge ---------- */
const hash = s => { let x = 7; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function spine(items, { height = 44, colorOf, label }) {
  const c = h('canvas.spine', { role: 'img', 'aria-label': label, height });
  c.style.height = `${height}px`; // per CSSOM, die CSP sperrt style-Attribute
  const draw = () => {
    const width = c.clientWidth;
    if (!width) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const n = items.length;
    if (!n) return;
    const bar = Math.min(12, Math.max(1, Math.floor(width / n)));
    const gap = bar >= 4 ? 1 : 0;
    const count = Math.min(n, Math.floor(width / bar));
    for (let x = 0; x < count; x++) {
      const it = items[Math.floor((x * n) / count)];
      const mins = Math.min(1, (it.durationMs || 210000) / 420000);
      const tall = Math.round(height * (0.62 + 0.38 * mins));
      g.fillStyle = colorOf(it);
      g.fillRect(x * bar, height - tall, bar - gap, tall);
    }
  };
  new ResizeObserver(draw).observe(c);
  c.redraw = draw;
  return c;
}

const SLEEVES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'];
export const sleeveColor = t => css(SLEEVES[hash(t.artists[0] || t.title) % SLEEVES.length]);
const STATE = { pending: '--st-pending', sure: '--st-sure', unsure: '--st-unsure', missing: '--st-missing', skipped: '--st-pending', written: '--st-written' };
export const stateColor = item => css(STATE[item.state]);
