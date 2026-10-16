/* Cut Log — free calorie & protein tracker.
   Data is saved on the phone first (works offline), then synced to Firebase when signed in. */
'use strict';

const KEY = 'cutlog.v1';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';
const OFF = 'https://world.openfoodfacts.org';
const RING_C = 2 * Math.PI * 52;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const shift = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const r1 = n => Math.round(n * 10) / 10;
const fmtQty = q => (Math.round(q * 100) / 100).toString();
const icon = id => `<svg><use href="#${id}"/></svg>`;
function loadScript(src) {
  return new Promise((ok, fail) => {
    if ([...document.scripts].some(s => s.src === src)) return ok();
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s);
  });
}

/* ---------- state ---------- */
function seed() {
  return {
    v: 1,
    targets: { calLo: 2100, calHi: 2400, protein: 180, goal: 198 },
    meals: STARTER_MEALS.map(m => ({ id: uid(), ...m })),
    foods: [], recent: [], log: {}, weights: {},
    stamps: { meta: 0, days: {} },   // last-change time per synced document
    dirty: [],                       // documents waiting to upload: 'meta' or 'd:YYYY-MM-DD'
  };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.v === 1) {
      const st = Object.assign(seed(), s);
      st.stamps = Object.assign({ meta: 0, days: {} }, s.stamps || {});
      st.dirty = Array.isArray(s.dirty) ? s.dirty : [];
      return st;
    }
  } catch (e) { /* fall through */ }
  return seed();
}
let S = load();
function applyTheme() {
  const c = S.theme || 'cobalt';
  if (c === 'cobalt') document.documentElement.removeAttribute('data-accent'); else document.documentElement.setAttribute('data-accent', c);
  document.querySelectorAll('#swatches .swatch').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === c));
}
applyTheme();
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('Could not save. Phone storage may be full.'); }
}
function markDirty(key) { if (!S.dirty.includes(key)) S.dirty.push(key); }
function touchDay(d) { S.stamps.days[d] = Date.now(); markDirty('d:' + d); persist(); scheduleFlush(); }
function touchMeta() { S.stamps.meta = Date.now(); markDirty('meta'); persist(); scheduleFlush(); }
function touchAll() {
  const now = Date.now();
  S.stamps.meta = now; markDirty('meta');
  new Set([...Object.keys(S.log), ...Object.keys(S.weights)]).forEach(d => { S.stamps.days[d] = now; markDirty('d:' + d); });
  persist(); scheduleFlush();
}
let day = todayIso();

/* ---------- nutrition math ---------- */
function unitsFor(f) {
  const u = [];
  if (f.kcalServ != null || f.servingG) u.push({ key: 'serving', label: 'serving', long: f.servingLabel ? `serving (${f.servingLabel})` : 'serving', g: f.servingG || null });
  if (f.piece) u.push({ key: 'piece', label: f.pieceLabel || 'piece', g: f.piece });
  if (f.kcal100 != null) {
    u.push({ key: 'g', label: 'grams', g: 1 });
    u.push({ key: 'tbsp', label: 'tbsp', long: 'tablespoon', g: 15 });
    u.push({ key: 'tsp', label: 'tsp', long: 'teaspoon', g: 5 });
    if (f.cup) u.push({ key: 'cup', label: 'cup', g: f.cup });
    u.push({ key: 'oz', label: 'oz (weight)', long: 'ounce by weight, 28 g', g: 28.35 });
  }
  return u;
}
function calc(f, qty, unitKey) {
  const u = unitsFor(f).find(x => x.key === unitKey);
  if (!u || !(qty > 0)) return { kcal: 0, pro: 0 };
  if (u.key === 'serving' && f.kcalServ != null) return { kcal: qty * f.kcalServ, pro: qty * (f.proServ || 0) };
  const g = qty * u.g;
  return { kcal: g * f.kcal100 / 100, pro: g * (f.pro100 || 0) / 100 };
}
function unitWord(f, unitKey, qty) {
  const u = unitsFor(f).find(x => x.key === unitKey);
  if (!u) return '';
  const short = { g: 'g', tbsp: 'tbsp', tsp: 'tsp', oz: 'oz', cup: qty === 1 ? 'cup' : 'cups', serving: qty === 1 ? 'serving' : 'servings' }[u.key];
  if (short) return short;
  if (qty === 1 || /s$/.test(u.label)) return u.label;
  return /o$/.test(u.label) ? u.label + 'es' : u.label + 's';
}
function perLine(f) {
  if (f.kcal100 != null) {
    let s = `${Math.round(f.kcal100)} kcal · ${r1(f.pro100 || 0)}g protein per 100 g`;
    if (f.servingG) s += ` · serving ${f.servingLabel || f.servingG + ' g'}`;
    return s;
  }
  if (f.kcalServ != null) return `${Math.round(f.kcalServ)} kcal · ${r1(f.proServ || 0)}g protein per serving`;
  return '';
}
function stepFor(unit) { return unit === 'g' ? 10 : unit === 'piece' ? 1 : 0.5; }

/* ---------- rendering ---------- */
function entriesFor(d) { return S.log[d] || []; }
function setArc(el, frac) { el.style.strokeDasharray = RING_C; el.style.strokeDashoffset = RING_C * (1 - Math.max(0, Math.min(1, frac))); }
function renderDay() {
  const t = todayIso();
  $('dayLabel').textContent = day === t ? 'Today' : day === shift(t, -1) ? 'Yesterday'
    : parseIso(day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  $('next').disabled = day >= t;
}
function renderTotals() {
  const T = S.targets, es = entriesFor(day);
  const cal = Math.round(es.reduce((a, e) => a + e.kcal, 0));
  const pro = Math.round(es.reduce((a, e) => a + e.pro, 0));
  $('calNum').textContent = cal.toLocaleString();
  setArc($('calArc'), cal / T.calHi);
  $('calRing').classList.toggle('over', cal > T.calHi);
  const tick = $('calTick'), tl = 1.2;   // short mark where the range starts
  tick.style.strokeDasharray = `${tl} ${RING_C}`; tick.style.strokeDashoffset = -(RING_C * T.calLo / T.calHi) + tl / 2;
  $('calSub').textContent = `of ${T.calLo.toLocaleString()}–${T.calHi.toLocaleString()}`;
  $('proNum').textContent = pro;
  setArc($('proArc'), pro / T.protein);
  $('proSub').textContent = pro >= T.protein ? `${T.protein}g target hit` : `${T.protein - pro}g to go`;
  const st = $('status'); st.className = 'status';
  if (!es.length) st.textContent = 'Scan, snap or search what you eat and the rings fill up.';
  else if (cal < T.calLo) st.textContent = `${(T.calLo - cal).toLocaleString()} kcal under your cut range. Room for a high-protein snack before your cutoff.`;
  else if (cal <= T.calHi) { st.className = 'status ok'; st.textContent = 'In your cut range for today.'; }
  else { st.className = 'status hi'; st.textContent = `${(cal - T.calHi).toLocaleString()} kcal over your cut range. One day like this is fine; the weekly trend decides.`; }
}
function renderRows() {
  const es = entriesFor(day), r = $('rows');
  $('count').textContent = es.length ? `${es.length} item${es.length > 1 ? 's' : ''}` : '';
  if (!es.length) { r.innerHTML = '<p class="empty">Nothing logged for this day yet.</p>'; return; }
  r.innerHTML = es.map(e => {
    const time = e.at ? new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
    const sub = [e.detail, time].filter(Boolean).join(' · ');
    return `<div class="row" data-id="${esc(e.id)}"><span class="n">${esc(e.name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="c">${Math.round(e.kcal)}<small>kcal</small></span><span class="pill">${Math.round(e.pro)}g</span>
      <button class="x" data-del="${esc(e.id)}" aria-label="Remove ${esc(e.name)}">${icon('i-x')}</button></div>`;
  }).join('');
}
function weightsArr() { return Object.entries(S.weights).map(([date, lb]) => ({ date, lb: +lb })).sort((a, b) => a.date < b.date ? -1 : 1); }
function avgBetween(arr, from, to) {
  const v = arr.filter(w => w.date >= from && w.date <= to).map(w => w.lb);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function renderWeights() {
  const t = todayIso(), arr = weightsArr();
  if (document.activeElement !== $('wIn')) $('wIn').value = S.weights[t] ?? '';
  const a = avgBetween(arr, shift(t, -6), t), b = avgBetween(arr, shift(t, -13), shift(t, -7));
  $('avg7').textContent = a ? a.toFixed(1) : '–';
  const d = $('delta'); d.className = 'v';
  if (a && b) { const x = a - b; d.textContent = (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1); d.classList.add(x <= 0 ? 'down' : 'up'); } else d.textContent = '–';
  $('goalK').textContent = `To ${S.targets.goal}`;
  $('toGoal').textContent = a ? Math.max(0, a - S.targets.goal).toFixed(1) : '–';
  const pts = arr.filter(w => w.date >= shift(t, -27));
  const ch = $('chart');
  if (pts.length < 2) {
    ch.innerHTML = '';
    $('wHint').textContent = pts.length ? 'One weigh-in so far. The trend line appears after your second.'
      : 'Weigh after the bathroom, before food or water. The weekly average is the number that matters.';
    return;
  }
  $('wHint').textContent = 'Last 4 weeks. Dots are daily weigh-ins; the line is your 7-day average.';
  const W = 520, H = 160, L = 34, R = 12, T = 12, B = 24;
  const t0 = parseIso(shift(t, -27)).getTime(), t1 = parseIso(t).getTime();
  const lbs = pts.map(p => p.lb);
  const lo = Math.floor(Math.min(...lbs) - 1), hi = Math.ceil(Math.max(...lbs) + 1);
  const X = s => L + (parseIso(s).getTime() - t0) / (t1 - t0) * (W - L - R);
  const Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const av = pts.map(p => [X(p.date), Y(avgBetween(arr, shift(p.date, -6), p.date))]);
  const line = av.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const area = `${av[0][0].toFixed(1)},${H - B} ${line} ${av[av.length - 1][0].toFixed(1)},${H - B}`;
  const last = av[av.length - 1];
  const txt = 'font-size="11" fill="var(--muted)" font-family="Barlow, system-ui, sans-serif"';
  ch.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over the last four weeks">
    <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" ${txt}>${v}</text>`).join('')}
    <text x="${L}" y="${H - 6}" ${txt}>${parseIso(shift(t, -27)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" ${txt}>Today</text>
    <polygon points="${area}" fill="url(#wg)"/>
    ${pts.map(p => `<circle cx="${X(p.date)}" cy="${Y(p.lb)}" r="3" fill="var(--muted)" opacity=".5"/>`).join('')}
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}
function renderSettings() {
  const T = S.targets;
  $('tLo').value = T.calLo; $('tHi').value = T.calHi; $('tPro').value = T.protein; $('tGoal').value = T.goal;
  $('foodList').innerHTML = S.foods.length ? S.foods.map(f => `<div class="mrow"><span>${esc(f.name)}${f.brand ? ' · ' + esc(f.brand) : ''}</span>
      <button class="x" data-del-food="${esc(f.id)}" aria-label="Delete ${esc(f.name)}">${icon('i-x')}</button></div>`).join('')
    : '<p class="empty">Foods you scan or read from a label are saved here for next time.</p>';
}
function renderAll() { renderDay(); renderTotals(); renderRows(); renderWeights(); renderSettings(); renderSync(); if (typeof tab !== 'undefined' && tab === 'trends') renderTrends(); }

/* ---------- log actions ---------- */
function addEntry(name, kcal, pro, detail, src) {
  const e = { id: uid(), name, kcal: r1(kcal), pro: r1(pro), detail: detail || '', at: Date.now() };
  if (src) { e.food = src.food; e.qty = src.qty; e.unit = src.unit; }
  (S.log[day] ||= []).push(e);
  touchDay(day); renderTotals(); renderRows();
}
function removeEntry(id) {
  const list = entriesFor(day), i = list.findIndex(x => x.id === id); if (i < 0) return;
  const [gone] = list.splice(i, 1), d = day;
  if (!list.length) delete S.log[d];
  touchDay(d); renderTotals(); renderRows();
  toast(`Removed ${gone.name}`, { label: 'Undo', fn: () => { (S.log[d] ||= []).splice(i, 0, gone); touchDay(d); renderTotals(); renderRows(); } });
}
const NOT_SAVED = ['built-in', 'meal', 'entry'];
function rememberFood(f) {
  if (!NOT_SAVED.includes(f.source)) {
    const i = S.foods.findIndex(x => x.id === f.id);
    if (i >= 0) S.foods[i] = f; else S.foods.unshift(f);
  }
}
function pushRecent(f, qty, unit) {
  if (NOT_SAVED.includes(f.source) && f.source !== 'built-in') return;
  S.recent = [{ food: f, qty, unit }, ...S.recent.filter(r => r.food.id !== f.id)].slice(0, 12);
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, action) {
  const t = $('toast'); t.textContent = ''; t.hidden = false;
  const m = document.createElement('span'); m.className = 'toast-msg'; m.textContent = msg; t.appendChild(m);
  if (action) {
    const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { t.hidden = true; clearTimeout(toastTimer); action.fn(); };
    t.appendChild(b);
  }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, action ? 5000 : 2600);
}
/* When building a meal, food flows hand their result back here instead of logging it */
let pick = null, draft = null;

/* ---------- sheet ---------- */
let onSheetClose = null;
function openSheet(title, html, cleanup) {
  if (onSheetClose) { try { onSheetClose(); } catch (e) {} }
  $('sheetTitle').textContent = title;
  $('sheetBody').innerHTML = html;
  $('sheetBody').scrollTop = 0;
  $('sheet').hidden = false; $('scrim').hidden = false;
  document.body.style.overflow = 'hidden';
  onSheetClose = cleanup || null;
}
function closeSheet() {
  pick = null; draft = null;
  if (onSheetClose) { try { onSheetClose(); } catch (e) {} onSheetClose = null; }
  $('sheet').hidden = true; $('scrim').hidden = true;
  document.body.style.overflow = '';
}
$('sheetClose').onclick = closeSheet;
$('scrim').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

/* ---------- amount step (shared by every flow) ---------- */
function openAmount(f, preset, opts = {}) {
  const units = unitsFor(f);
  if (!units.length) { toast('This food has no calorie data. Try the label photo instead.'); return; }
  let unit = preset?.unit && units.some(u => u.key === preset.unit) ? preset.unit
    : (units.find(u => u.key === 'piece') || units.find(u => u.key === 'serving') || units[0]).key;
  const startQty = preset?.qty ?? (unit === 'g' ? 100 : 1);
  const dayName = $('dayLabel').textContent;
  const editing = opts.editId, picking = pick;
  const cta = picking ? picking.label : editing ? 'Save changes' : `Add to ${dayName === 'Today' ? 'today' : dayName}`;
  openSheet(editing ? 'Edit entry' : 'How much?', `
    <div class="food-head"><strong>${esc(f.name)}</strong><span>${esc([f.brand, perLine(f)].filter(Boolean).join(' · '))}</span></div>
    <div class="stepper">
      <button id="aMinus" aria-label="Less">−</button>
      <input id="aQty" type="number" inputmode="decimal" step="any" min="0" value="${startQty}" aria-label="Amount">
      <button id="aPlus" aria-label="More">+</button>
    </div>
    <div class="chips" id="aUnits" role="group" aria-label="Unit">${units.map(u => `<button class="chip" data-u="${u.key}" aria-pressed="${u.key === unit}" title="${esc(u.long || u.label)}">${esc(u.key === 'serving' && f.servingLabel ? 'serving · ' + f.servingLabel : u.label)}</button>`).join('')}</div>
    <div class="result"><div><span class="num" id="aK">0</span><small>kcal</small></div><div class="pro"><span class="num" id="aP">0g</span><small>protein</small></div></div>
    <p class="hint" id="aNote" hidden>Spoon sizes are approximate: about 15 g per tablespoon and 5 g per teaspoon. A heaping spoon is closer to 25 g.</p>
    <button class="btn" id="aAdd">${esc(cta)}</button>
    ${NOT_SAVED.includes(f.source) ? '' : '<button class="btn ghost" id="aFix">Numbers look wrong? Fix them</button>'}
    ${editing ? '<button class="btn danger" id="aDel">Remove from log</button>' : ''}`);
  const upd = () => {
    const v = calc(f, parseFloat($('aQty').value), unit);
    $('aK').textContent = Math.round(v.kcal); $('aP').textContent = Math.round(v.pro) + 'g';
    $('aNote').hidden = !['tbsp', 'tsp'].includes(unit);
  };
  const bump = dir => { const q = parseFloat($('aQty').value) || 0; $('aQty').value = fmtQty(Math.max(0, q + dir * stepFor(unit))); upd(); };
  $('aMinus').onclick = () => bump(-1); $('aPlus').onclick = () => bump(1);
  $('aQty').oninput = upd;
  $('aUnits').onclick = e => {
    const b = e.target.closest('[data-u]'); if (!b) return;
    unit = b.dataset.u;
    [...$('aUnits').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.u === unit));
    if (unit === 'g' && parseFloat($('aQty').value) < 10) $('aQty').value = 100;
    if (unit !== 'g' && parseFloat($('aQty').value) >= 10) $('aQty').value = 1;
    upd();
  };
  upd();
  if ($('aDel')) $('aDel').onclick = () => { closeSheet(); removeEntry(editing); };
  if ($('aFix')) $('aFix').onclick = () => {
    const g = f.servingG || null;
    const per = f.kcalServ != null ? { kcal: f.kcalServ, pro: f.proServ }
      : g ? { kcal: f.kcal100 * g / 100, pro: (f.pro100 || 0) * g / 100 } : { kcal: f.kcal100, pro: f.pro100 };
    openSheet('Fix the numbers', `<p class="hint">Enter what the label says for one serving. The app will use your numbers for this food from now on.</p><div id="labelOut"></div>`);
    labelForm($('labelOut'), { kcal: Math.round(per.kcal), pro: r1(per.pro || 0), servingG: g || (f.kcalServ == null ? 100 : null) }, '', f.barcode || null, f.name, f.id);
  };
  $('aAdd').onclick = () => {
    const q = parseFloat($('aQty').value);
    if (!(q > 0)) { toast('Enter how much you had.'); return; }
    const v = calc(f, q, unit), detail = `${fmtQty(q)} ${unitWord(f, unit, q)}`;
    rememberFood(f); pushRecent(f, q, unit); touchMeta(); renderSettings();
    if (picking) { pick = null; picking.onDone(f, q, unit, v); return; }
    if (editing) {
      const e = entriesFor(day).find(x => x.id === editing);
      if (e) Object.assign(e, { kcal: r1(v.kcal), pro: r1(v.pro), detail, food: f, qty: q, unit });
      touchDay(day); renderTotals(); renderRows(); closeSheet(); toast('Entry updated'); return;
    }
    addEntry(f.name, v.kcal, v.pro, detail, { food: f, qty: q, unit });
    closeSheet(); toast(`Added ${Math.round(v.kcal)} kcal · ${Math.round(v.pro)}g protein`);
  };
}

/* ---------- barcode ---------- */
function offToFood(p, code) {
  const n = p.nutriments || {};
  let k = n['energy-kcal_100g'];
  if (k == null && n['energy_100g'] != null) k = n['energy_100g'] / 4.184;
  const f = { id: 'p' + code, barcode: code, name: p.product_name || p.product_name_en || p.product_name_fr || 'Unnamed product',
    brand: (p.brands || '').split(',')[0].trim(), source: 'scan' };
  if (k != null) { f.kcal100 = +k; f.pro100 = +(n['proteins_100g'] || 0); }
  const sq = parseFloat(p.serving_quantity);
  if (sq > 0) { f.servingG = sq; f.servingLabel = p.serving_size || sq + ' g'; }
  if (f.kcal100 == null && n['energy-kcal_serving'] != null) { f.kcalServ = +n['energy-kcal_serving']; f.proServ = +(n['proteins_serving'] || 0); }
  return (f.kcal100 != null || f.kcalServ != null) ? f : null;
}
async function lookupBarcode(code) {
  code = String(code).replace(/\D/g, '');
  const saved = S.foods.find(f => f.barcode && (f.barcode === code || f.barcode === '0' + code || '0' + f.barcode === code));
  if (saved) return { food: saved };
  const tries = code.length === 12 ? [code, '0' + code] : [code];
  for (const c of tries) {
    try {
      const res = await fetch(`${OFF}/api/v2/product/${c}.json?fields=product_name,product_name_en,product_name_fr,brands,nutriments,serving_quantity,serving_size`);
      if (!res.ok) continue;
      const j = await res.json();
      if (j.status === 1 && j.product) {
        const f = offToFood(j.product, code);
        return f ? { food: f } : { found: true, name: j.product.product_name };
      }
    } catch (e) { return { offline: true }; }
  }
  return {};
}
const ZXW = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2.2.4/dist/iife/reader/index.js';
const BC_OPTS = { formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E'], tryHarder: true, maxNumberOfSymbols: 1 };
const scan = { stream: null, timer: null, stop: true, track: null };
function stopScan() {
  scan.stop = true; clearTimeout(scan.timer);
  if (scan.stream) { scan.stream.getTracks().forEach(t => t.stop()); scan.stream = null; scan.track = null; }
}
async function decodeBarcode(input) {
  const r = await ZXingWASM.readBarcodes(input, BC_OPTS);
  const ok = r.find(b => b.isValid && b.text);
  return ok ? ok.text : null;
}
async function handleCode(code) {
  stopScan();
  if (navigator.vibrate) navigator.vibrate(50);
  $('sheetBody').innerHTML = `<div class="loading"><div class="spinner"></div>Looking up ${esc(code)}…</div>`;
  const r = await lookupBarcode(code);
  if (r.food) { openAmount(r.food, S.recent.find(x => x.food.id === r.food.id)); return; }
  const why = r.offline ? "Couldn't reach the food database. Check your connection."
    : r.found ? `Found "${esc(r.name)}" but it has no nutrition data yet.`
    : "This barcode isn't in the free database yet.";
  $('sheetBody').innerHTML = `<p>${why}</p><p class="hint">Snap the nutrition label instead. The app will save it under this barcode, so next time the scan works instantly.</p>
    <button class="btn" id="toLabel">Snap the label</button>`;
  $('toLabel').onclick = () => openLabel(code);
}
function openScan() {
  openSheet('Scan barcode', `
    <div class="video-wrap"><video id="scanVideo" playsinline muted autoplay></video><div class="aim"></div><div class="laser"></div>
      <button class="torch" id="torch" hidden aria-label="Flashlight">Light</button></div>
    <p class="hint" id="scanHint">Starting camera…</p>
    <button class="btn ghost" id="snapCode">Take a photo of the barcode instead</button>
    <div class="wrow"><input id="codeIn" inputmode="numeric" placeholder="Or type the barcode number" aria-label="Barcode number"><button class="btn" id="codeGo">Look up</button></div>`,
    stopScan);
  $('codeGo').onclick = () => { const c = $('codeIn').value.replace(/\D/g, ''); if (c.length >= 8) handleCode(c); else toast('Barcodes are 8 to 13 digits.'); };
  $('snapCode').onclick = () => pickPhoto(async file => {
    try {
      await loadScript(ZXW);
      const t = await decodeBarcode(file);
      if (t) handleCode(t); else toast("Couldn't find a barcode in that photo. Fill the frame with it and try again.");
    } catch (e) { toast("The scanner didn't load. Check your connection, or type the number."); }
  });
  startLiveScan();
}
async function startLiveScan() {
  const hint = $('scanHint'), v = $('scanVideo');
  scan.stop = false;
  try { await loadScript(ZXW); } catch (e) { hint.textContent = "The scanner didn't load. Check your connection, or type the number."; return; }
  if (!navigator.mediaDevices?.getUserMedia) { hint.textContent = "Live camera isn't available here. Use the photo button or type the number."; return; }
  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) { hint.textContent = 'Camera access was blocked. Allow the camera for this app, or use the photo button.'; return; }
  if (scan.stop || !$('scanVideo')) { stopScan(); return; }
  v.srcObject = scan.stream;
  try { await v.play(); } catch (e) {}
  scan.track = scan.stream.getVideoTracks()[0];
  try {
    const caps = scan.track.getCapabilities ? scan.track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) await scan.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    if (caps.torch) {
      let on = false; $('torch').hidden = false;
      $('torch').onclick = async () => { on = !on; try { await scan.track.applyConstraints({ advanced: [{ torch: on }] }); $('torch').classList.toggle('on', on); } catch (e) {} };
    }
  } catch (e) {}
  hint.textContent = 'Line the barcode up inside the box, about a hand-length away.';
  const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
  const hits = {};
  const tick = async () => {
    if (scan.stop) return;
    const vw = v.videoWidth, vh = v.videoHeight, cw = v.clientWidth, ch = v.clientHeight;
    if (v.readyState >= 2 && vw && cw) {
      // read only the strip inside the on-screen box (video is cropped to fill its frame)
      const s = Math.max(cw / vw, ch / vh), visW = cw / s, visH = ch / s;
      const sw = visW * 0.9, sh = visH * 0.5, sx = (vw - sw) / 2, sy = (vh - sh) / 2;
      const k = Math.min(1, 1280 / sw);
      c.width = Math.round(sw * k); c.height = Math.round(sh * k);
      x.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
      try {
        const t = await decodeBarcode(x.getImageData(0, 0, c.width, c.height));
        if (t) { hits[t] = (hits[t] || 0) + 1; if (hits[t] >= 2) { handleCode(t); return; } }   // two matching reads = no misreads
      } catch (e) {}
    }
    scan.timer = setTimeout(tick, 40);
  };
  tick();
}

/* ---------- photo input ---------- */
let photoCb = null;
function pickPhoto(cb) { photoCb = cb; $('photoIn').value = ''; $('photoIn').click(); }
$('photoIn').onchange = () => { const f = $('photoIn').files[0]; if (f && photoCb) photoCb(f); };

/* ---------- label photo (on-device text reading) ---------- */
async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, c.width, c.height);
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data;
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) { const g = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114; d[i] = g; if (g < min) min = g; if (g > max) max = g; }
  const span = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] - min) / span * 255; d[i] = d[i + 1] = d[i + 2] = g; }
  x.putImageData(im, 0, 0);
  return c;
}
function parseLabel(text) {
  const lines = text.replace(/[|]/g, ' ').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const num = s => parseFloat(String(s).replace(',', '.'));
  let kcal = null, pro = null, servingG = null, servingText = '';
  for (const l of lines) {
    const low = l.toLowerCase().replace(/(\d)o\b/g, '$10').replace(/\bo(\d)/g, '0$1');
    if (kcal == null && /calor/.test(low) && !/from fat/.test(low)) {
      const m = low.slice(low.indexOf('calor')).match(/(\d{1,4})\b(?!\s?%)/);
      if (m) kcal = num(m[1]);
    }
    if (pro == null && /prot/.test(low)) {
      const after = low.slice(low.indexOf('prot'));
      const m = after.match(/(\d{1,3}(?:[.,]\d)?)\s*g/) || after.match(/(\d{1,3}(?:[.,]\d)?)/);
      if (m) pro = num(m[1]);
    }
    if (servingG == null && /(per|pour|serving|portion|size)/.test(low)) {
      const m = low.match(/\(?\s*(\d{1,4}(?:[.,]\d)?)\s*(g|ml|mℓ)\b/);
      if (m) { servingG = num(m[1]); servingText = l.replace(/\s+/g, ' ').slice(0, 60); }
    }
  }
  if (servingG == null) { const m = text.match(/\(\s*(\d{1,4})\s*(g|ml)\s*\)/i); if (m) { servingG = num(m[1]); servingText = m[0]; } }
  return { kcal, pro, servingG, servingText };
}
function openLabel(barcode) {
  openSheet('Snap the label', `
    <p class="hint">Take a clear, straight-on photo of the Nutrition Facts table in good light. The reading happens on your phone and takes a few seconds. The first time, it downloads a small reader.</p>
    <button class="btn" id="takeLabel">Take photo</button>
    <button class="btn ghost" id="typeLabel">Type the numbers instead</button>
    <div id="labelOut"></div>`);
  $('takeLabel').onclick = () => pickPhoto(file => runOcr(file, barcode));
  $('typeLabel').onclick = () => { $('labelOut').innerHTML = ''; labelForm($('labelOut'), {}, '', barcode); };
}
async function runOcr(file, barcode) {
  const out = $('labelOut');
  out.innerHTML = '<div class="loading"><div class="spinner"></div><span id="ocrMsg">Preparing photo…</span></div>';
  let text = '';
  try {
    if (!window.Tesseract) { $('ocrMsg').textContent = 'Loading reader…'; await loadScript(TESSERACT_URL); }
    const img = await prepImage(file);
    $('ocrMsg').textContent = 'Reading label…';
    const worker = await Tesseract.createWorker('eng');
    const r = await worker.recognize(img);
    await worker.terminate();
    text = r.data.text || '';
    out.innerHTML = '';
  } catch (e) {
    out.innerHTML = "<p class=\"err\">Couldn't read the photo. Type the numbers from the label below.</p>";
  }
  labelForm(out, parseLabel(text), text, barcode);
}
function labelForm(out, p, text, barcode, name, keepId) {
  out.insertAdjacentHTML('beforeend', `
    ${text ? '<p class="hint">Check these against the label and fix anything that looks off.</p>' : ''}
    <label>Food name<input id="lName" value="${esc(name || '')}" placeholder="e.g. Greek yogurt 0%"></label>
    <div class="grid2">
      <label>Calories per serving<input id="lK" type="number" inputmode="decimal" value="${p.kcal ?? ''}"></label>
      <label>Protein per serving (g)<input id="lP" type="number" inputmode="decimal" value="${p.pro ?? ''}"></label>
    </div>
    <label>Serving size (g or ml)<input id="lG" type="number" inputmode="decimal" value="${p.servingG ?? ''}" placeholder="Optional, e.g. 175"></label>
    <p class="field-note">The number in brackets on the label. Adding it lets you log by spoon or gram.</p>
    <button class="btn" id="lSave">Next: how much did you have?</button>
    ${text ? `<details><summary>What the reader saw</summary><div class="ocr">${esc(text)}</div></details>` : ''}`);
  $('lSave').onclick = () => {
    const nm = $('lName').value.trim(), k = parseFloat($('lK').value), pr = parseFloat($('lP').value) || 0, g = parseFloat($('lG').value);
    if (!nm) { toast('Give the food a name.'); return; }
    if (!(k >= 0)) { toast('Enter the calories per serving.'); return; }
    const f = { id: keepId || (barcode ? 'p' + barcode : 'c' + uid()), name: nm, source: 'label', kcalServ: k, proServ: pr };
    if (barcode) f.barcode = barcode;
    if (g > 0) { f.servingG = g; f.servingLabel = g + ' g'; f.kcal100 = k / g * 100; f.pro100 = pr / g * 100; }
    rememberFood(f); touchMeta(); renderSettings();
    openAmount(f, { qty: 1, unit: 'serving' });
  };
}

/* ---------- search ---------- */
function listHtml(items) {
  return items.map((it, i) => `<button class="item" data-i="${i}"><span class="nm">${esc(it.f.name)}${it.f.brand ? `<small>${esc(it.f.brand)}</small>` : ''}</span>
    <span class="meta">${esc(it.meta || (it.f.kcal100 != null ? Math.round(it.f.kcal100) + ' kcal/100g' : Math.round(it.f.kcalServ) + ' kcal/serv'))}</span></button>`).join('');
}
function openSearch() {
  openSheet(pick ? 'Add an ingredient' : 'Search foods', `
    ${pick ? '<button class="btn ghost" id="pickScan">Scan a barcode instead</button>' : ''}
    <input id="q" type="search" placeholder="Sweet potato, eggs, yogurt…" aria-label="Search foods" autocomplete="off">
    <div class="list" id="results"></div>
    <button class="btn ghost" id="online" hidden>Search packaged foods online</button>
    <button class="btn ghost" id="custom">Enter a food by hand</button>`);
  let items = [];
  if ($('pickScan')) $('pickScan').onclick = openScan;
  const show = () => {
    const q = $('q').value.trim().toLowerCase();
    if (!q) {
      items = S.recent.map(r => ({ f: r.food, preset: r, meta: `last: ${fmtQty(r.qty)} ${unitWord(r.food, r.unit, r.qty)}` }));
      if (items.length) $('results').innerHTML = '<h3>Recent</h3>' + listHtml(items);
      else { items = BUILTIN_FOODS.slice(0, 10).map(f => ({ f })); $('results').innerHTML = '<h3>Common foods</h3>' + listHtml(items); }
      $('online').hidden = true;
    } else {
      const words = q.split(/\s+/);
      const match = f => words.every(w => (f.name + ' ' + (f.brand || '')).toLowerCase().includes(w));
      items = [...S.foods.filter(match), ...BUILTIN_FOODS.filter(match)].slice(0, 30).map(f => ({ f }));
      $('results').innerHTML = items.length ? listHtml(items) : '<p class="empty">No match in your foods. Try searching online.</p>';
      $('online').hidden = false;
    }
  };
  $('results').onclick = e => { const b = e.target.closest('[data-i]'); if (b) { const it = items[+b.dataset.i]; openAmount(it.f, it.preset); } };
  $('q').oninput = show; show();
  $('online').onclick = async () => {
    const q = $('q').value.trim(); if (!q) return;
    $('results').innerHTML = '<div class="loading"><div class="spinner"></div>Searching Open Food Facts…</div>';
    try {
      const url = `${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,brands,nutriments,serving_quantity,serving_size`;
      const j = await (await fetch(url)).json();
      items = (j.products || []).map(p => offToFood(p, p.code)).filter(Boolean).map(f => ({ f }));
      $('results').innerHTML = items.length ? listHtml(items) : '<p class="empty">Nothing found online. Try fewer words or a brand name.</p>';
    } catch (e) { $('results').innerHTML = "<p class=\"empty\">Couldn't reach the food database. Check your connection.</p>"; }
  };
  $('custom').onclick = () => { const typed = $('q').value.trim(); openSheet('Enter a food', '<div id="labelOut"></div>'); labelForm($('labelOut'), {}, '', null, typed); };
}

/* ---------- meals ---------- */
function mealFood(m) { return { id: 'meal-' + m.id, name: m.name, source: 'meal', kcalServ: m.kcal, proServ: m.pro }; }
function entryFood(e) { return e.food || { id: 'entry-' + e.id, name: e.name, source: 'entry', kcalServ: e.kcal, proServ: e.pro }; }
function openMeals() {
  openSheet('My meals', `
    <div class="list" id="mealList">${S.meals.length ? S.meals.map((m, i) => `<div class="meal-row">
        <button class="item" data-m="${i}"><span class="nm">${esc(m.name)}<small>${m.items?.length ? `${m.items.length} ingredient${m.items.length > 1 ? 's' : ''}${m.servings > 1 ? ` · makes ${m.servings}` : ''}` : 'quick meal'}</small></span>
        <span class="meta">${m.kcal} kcal · ${m.pro}g</span></button>
        <button class="edit" data-edit="${i}" aria-label="Edit ${esc(m.name)}">Edit</button></div>`).join('') : '<p class="empty">No saved meals yet. Build one from the foods you cook with.</p>'}</div>
    <p class="hint">Tap a meal to log one serving. You can change the amount afterwards by tapping it in your log.</p>
    <button class="btn" id="newMeal">Build a new meal</button>`);
  $('mealList').onclick = e => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { const m = S.meals[+ed.dataset.edit]; openMealEditor(JSON.parse(JSON.stringify({ ...m, items: m.items || [] }))); return; }
    const b = e.target.closest('[data-m]'); if (!b) return;
    const m = S.meals[+b.dataset.m];
    addEntry(m.name, m.kcal, m.pro, '1 serving', { food: mealFood(m), qty: 1, unit: 'serving' });
    closeSheet(); toast(`Added ${m.kcal} kcal · ${m.pro}g protein`);
  };
  $('newMeal').onclick = () => openMealEditor({ id: null, name: '', servings: 1, items: [], kcal: '', pro: '' });
}
function mealTotals(d) {
  const t = d.items.reduce((a, it) => { const v = calc(it.food, it.qty, it.unit); return { kcal: a.kcal + v.kcal, pro: a.pro + v.pro }; }, { kcal: 0, pro: 0 });
  const n = Math.max(1, +d.servings || 1);
  return { kcal: t.kcal / n, pro: t.pro / n, totalK: t.kcal };
}
function openMealEditor(d) {
  draft = d;
  const hasItems = d.items.length > 0, t = mealTotals(d);
  const es = entriesFor(day);
  openSheet(d.id ? 'Edit meal' : 'Build a meal', `
    <label>Meal name<input id="mName" value="${esc(d.name)}" placeholder="e.g. Chicken sweet potato bowl"></label>
    <h3>Ingredients</h3>
    <div class="list" id="ingList">${hasItems ? d.items.map((it, i) => `<div class="meal-row">
        <button class="item" data-ing="${i}"><span class="nm">${esc(it.food.name)}<small>${fmtQty(it.qty)} ${esc(unitWord(it.food, it.unit, it.qty))}</small></span>
        <span class="meta">${Math.round(calc(it.food, it.qty, it.unit).kcal)} kcal</span></button>
        <button class="x" data-rm="${i}" aria-label="Remove ${esc(it.food.name)}">${icon('i-x')}</button></div>`).join('') : '<p class="empty">Add what goes into it, like 200 g ground chicken and 2 sweet potatoes.</p>'}</div>
    <button class="btn ghost" id="addIng">+ Add ingredient</button>
    ${es.length && !hasItems ? `<button class="btn ghost" id="fromDay">Use everything logged ${day === todayIso() ? 'today' : 'this day'}</button>` : ''}
    <label>Makes how many servings?<input id="mServ" type="number" inputmode="decimal" min="1" step="1" value="${d.servings || 1}"></label>
    ${hasItems ? `<div class="result"><div><span class="num" id="mK">${Math.round(t.kcal)}</span><small>kcal / serving</small></div><div class="pro"><span class="num" id="mP">${Math.round(t.pro)}g</span><small>protein / serving</small></div></div>`
      : `<p class="hint">No ingredients? Type the totals for one serving instead.</p>
         <div class="grid2"><label>Calories<input id="mKin" type="number" inputmode="numeric" value="${d.kcal ?? ''}"></label><label>Protein (g)<input id="mPin" type="number" inputmode="numeric" value="${d.pro ?? ''}"></label></div>`}
    <button class="btn" id="mSave">Save meal</button>
    ${d.id ? '<button class="btn danger" id="mDelete">Delete meal</button>' : ''}`);
  const keep = () => { d.name = $('mName').value; d.servings = Math.max(1, parseFloat($('mServ').value) || 1); if ($('mKin')) { d.kcal = $('mKin').value; d.pro = $('mPin').value; } };
  const back = () => openMealEditor(d);
  $('mServ').oninput = () => { keep(); if (hasItems) { const t2 = mealTotals(d); $('mK').textContent = Math.round(t2.kcal); $('mP').textContent = Math.round(t2.pro) + 'g'; } };
  $('addIng').onclick = () => {
    keep();
    pick = { label: 'Add to meal', onDone: (f, q, u) => { draft = d; d.items.push({ food: f, qty: q, unit: u }); back(); } };
    openSearch();
  };
  $('ingList').onclick = e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { keep(); d.items.splice(+rm.dataset.rm, 1); back(); return; }
    const b = e.target.closest('[data-ing]'); if (!b) return;
    keep(); const i = +b.dataset.ing, it = d.items[i];
    pick = { label: 'Update ingredient', onDone: (f, q, u) => { draft = d; d.items[i] = { food: f, qty: q, unit: u }; back(); } };
    openAmount(it.food, { qty: it.qty, unit: it.unit });
  };
  if ($('fromDay')) $('fromDay').onclick = () => {
    keep();
    es.forEach(e => d.items.push({ food: entryFood(e), qty: e.food ? e.qty : 1, unit: e.food ? e.unit : 'serving' }));
    back();
  };
  $('mSave').onclick = () => {
    keep();
    const name = d.name.trim(); if (!name) { toast('Give the meal a name.'); return; }
    let kcal, pro;
    if (d.items.length) { const t2 = mealTotals(d); kcal = Math.round(t2.kcal); pro = Math.round(t2.pro); }
    else { kcal = Math.round(parseFloat(d.kcal)); pro = Math.round(parseFloat(d.pro) || 0); if (!(kcal >= 0)) { toast('Add ingredients or type the calories.'); return; } }
    const m = { id: d.id || uid(), name, servings: d.servings || 1, items: d.items, kcal, pro };
    const i = S.meals.findIndex(x => x.id === m.id);
    if (i >= 0) S.meals[i] = m; else S.meals.push(m);
    touchMeta(); openMeals(); toast('Meal saved');
  };
  if ($('mDelete')) $('mDelete').onclick = () => {
    const i = S.meals.findIndex(x => x.id === d.id); if (i < 0) return;
    const [gone] = S.meals.splice(i, 1); touchMeta(); openMeals();
    toast(`Deleted ${gone.name}`, { label: 'Undo', fn: () => { S.meals.splice(i, 0, gone); touchMeta(); if (!$('sheet').hidden && $('sheetTitle').textContent === 'My meals') openMeals(); } });
  };
}

/* =================== CLOUD SYNC (Firebase) =================== */
const Sync = { ready: false, auth: null, db: null, user: null, unsub: [], state: 'local', flushing: false, timer: null };
function setSync(state) { Sync.state = state; renderSync(); }
function renderSync() {
  const b = $('syncBtn'); if (!b) return;
  const map = {
    local: ['', 'This phone'], loading: ['busy', 'Connecting…'], signedout: ['bad', 'Sign in to sync'],
    syncing: ['busy', 'Saving…'], synced: ['ok', 'Synced'], offline: ['bad', 'Offline'], error: ['bad', 'Sync paused'],
  };
  const [cls, txt] = map[Sync.state] || map.local;
  b.className = 'sync ' + cls; $('syncText').textContent = txt;
}
function dayDoc(d) { return { entries: S.log[d] || [], weight: S.weights[d] ?? null, updatedAt: S.stamps.days[d] || Date.now() }; }
function metaDoc() { return { targets: S.targets, meals: S.meals, foods: S.foods, recent: S.recent, theme: S.theme || 'cobalt', updatedAt: S.stamps.meta || Date.now() }; }
function applyDay(id, data) {
  if (data.entries && data.entries.length) S.log[id] = data.entries; else delete S.log[id];
  if (data.weight != null) S.weights[id] = data.weight; else delete S.weights[id];
  S.stamps.days[id] = data.updatedAt || 0;
  S.dirty = S.dirty.filter(k => k !== 'd:' + id);
}
function applyMeta(data) {
  ['targets', 'meals', 'foods', 'recent', 'theme'].forEach(k => { if (data[k] !== undefined) S[k] = data[k]; });
  applyTheme();
  S.stamps.meta = data.updatedAt || 0;
  S.dirty = S.dirty.filter(k => k !== 'meta');
}
/* Merge one remote document: newer side wins. Returns true when local data changed. */
function mergeRemote(kind, id, data) {
  const local = kind === 'meta' ? S.stamps.meta : (S.stamps.days[id] || 0);
  const remote = data?.updatedAt || 0;
  if (remote > local) { kind === 'meta' ? applyMeta(data) : applyDay(id, data); return true; }
  if (local > remote) markDirty(kind === 'meta' ? 'meta' : 'd:' + id);
  return false;
}
function scheduleFlush() {
  if (!Sync.user) return;
  clearTimeout(Sync.timer); Sync.timer = setTimeout(flush, 700);
}
async function flush() {
  if (!Sync.user || Sync.flushing || !S.dirty.length) { if (Sync.user && !S.dirty.length && Sync.state !== 'offline') setSync('synced'); return; }
  if (!navigator.onLine) { setSync('offline'); return; }
  Sync.flushing = true; setSync('syncing');
  const keys = S.dirty.slice(0, 400);
  const sent = {};
  const base = Sync.db.collection('users').doc(Sync.user.uid);
  const batch = Sync.db.batch();
  keys.forEach(k => {
    if (k === 'meta') { const m = metaDoc(); sent[k] = m.updatedAt; batch.set(base.collection('meta').doc('main'), m); }
    else { const d = k.slice(2), doc = dayDoc(d); sent[k] = doc.updatedAt; batch.set(base.collection('days').doc(d), doc); }
  });
  try {
    await batch.commit();
    // clear only what didn't change again while uploading
    S.dirty = S.dirty.filter(k => !(k in sent) || sent[k] !== (k === 'meta' ? S.stamps.meta : S.stamps.days[k.slice(2)]));
    persist();
    Sync.flushing = false;
    if (S.dirty.length) flush(); else setSync('synced');
  } catch (e) {
    Sync.flushing = false; setSync(navigator.onLine ? 'error' : 'offline');
    clearTimeout(Sync.timer); Sync.timer = setTimeout(flush, 15000);
  }
}
function startUser(user) {
  Sync.user = user; setSync('syncing');
  const base = Sync.db.collection('users').doc(user.uid);
  let gotMeta = false, gotDays = false;
  const firstDone = () => {
    if (!(gotMeta && gotDays)) return;
    // anything only on this phone gets uploaded
    Object.keys(S.stamps.days).forEach(d => { if (!seenDays.has(d)) markDirty('d:' + d); });
    new Set([...Object.keys(S.log), ...Object.keys(S.weights)]).forEach(d => { if (!seenDays.has(d)) { S.stamps.days[d] ||= Date.now(); markDirty('d:' + d); } });
    if (!seenMeta) { S.stamps.meta ||= Date.now(); markDirty('meta'); }
    persist(); renderAll(); flush();
  };
  const seenDays = new Set(); let seenMeta = false;
  Sync.unsub.push(base.collection('meta').doc('main').onSnapshot(snap => {
    if (snap.metadata.hasPendingWrites) return;
    if (snap.exists) { seenMeta = true; if (mergeRemote('meta', 'main', snap.data())) { persist(); renderAll(); } }
    if (!gotMeta) { gotMeta = true; firstDone(); }
  }, () => setSync('error')));
  Sync.unsub.push(base.collection('days').onSnapshot(qs => {
    let changed = false;
    qs.docChanges().forEach(c => {
      if (c.type === 'removed' || c.doc.metadata.hasPendingWrites) return;
      seenDays.add(c.doc.id);
      if (mergeRemote('day', c.doc.id, c.doc.data())) changed = true;
    });
    if (changed) { persist(); renderAll(); }
    if (!gotDays) { gotDays = true; firstDone(); }
  }, () => setSync('error')));
}
function stopUser() { Sync.unsub.forEach(u => { try { u(); } catch (e) {} }); Sync.unsub = []; Sync.user = null; }
async function initSync() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey) { setSync('local'); return; }
  setSync('loading');
  try {
    await loadScript(FB + 'firebase-app-compat.js');
    await Promise.all([loadScript(FB + 'firebase-auth-compat.js'), loadScript(FB + 'firebase-firestore-compat.js')]);
    firebase.initializeApp(cfg);
    Sync.auth = firebase.auth(); Sync.db = firebase.firestore(); Sync.ready = true;
    Sync.auth.onAuthStateChanged(u => {
      stopUser();
      if (u) startUser(u); else setSync('signedout');
      if (!$('sheet').hidden && $('sheetTitle').textContent === 'Cloud sync') openAccount();
    });
  } catch (e) {
    setSync('offline');   // scripts couldn't load (no connection); the app still works on this phone
  }
}
window.addEventListener('online', () => { if (Sync.user) flush(); else if (window.FIREBASE_CONFIG?.apiKey && !Sync.ready) initSync(); });
window.addEventListener('offline', () => { if (Sync.user) setSync('offline'); });

function authError(e) {
  const c = e?.code || '';
  if (/invalid-credential|wrong-password|user-not-found/.test(c)) return "That email and password don't match. Check them, or tap \"Forgot password\".";
  if (/email-already-in-use/.test(c)) return 'An account with this email already exists. Tap "Sign in" instead.';
  if (/weak-password/.test(c)) return 'Use a password with at least 6 characters.';
  if (/invalid-email/.test(c)) return "That email address doesn't look right.";
  if (/network/.test(c)) return 'No connection. Try again when you are online.';
  if (/too-many-requests/.test(c)) return 'Too many tries. Wait a few minutes and try again.';
  if (/operation-not-allowed/.test(c)) return 'Email sign-in is turned off in your Firebase project. Turn on Email/Password under Authentication → Sign-in method.';
  return 'Something went wrong: ' + (e?.message || c);
}
function openAccount() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey) {
    openSheet('Cloud sync', `<div class="acct"><strong>Not set up yet</strong><span class="hint">Everything is saved on this phone. To back it up to the cloud and sync with your laptop, add your Firebase settings to <b>firebase-config.js</b> (see the setup guide).</span></div>`);
    return;
  }
  if (!Sync.ready) {
    openSheet('Cloud sync', `<div class="acct"><strong>Can't reach the sync service</strong><span class="hint">You might be offline. Your entries are safe on this phone and will sync once you're connected.</span></div>
      <button class="btn" id="retry">Try again</button>`);
    $('retry').onclick = () => { closeSheet(); initSync(); };
    return;
  }
  if (Sync.user) {
    openSheet('Cloud sync', `<div class="acct"><span class="hint">Signed in as</span><strong>${esc(Sync.user.email)}</strong>
      <span class="hint">${S.dirty.length ? `${S.dirty.length} change${S.dirty.length > 1 ? 's' : ''} waiting to upload.` : 'Everything is backed up.'}</span></div>
      <button class="btn" id="syncNow">Sync now</button>
      <button class="btn ghost" id="signOut">Sign out</button>
      <p class="hint">Signing out keeps your data on this phone. Sign in on your laptop with the same email to see everything there too.</p>`);
    $('syncNow').onclick = () => { flush(); toast('Syncing'); };
    $('signOut').onclick = () => Sync.auth.signOut();
    return;
  }
  openSheet('Cloud sync', `
    <p class="hint">Sign in to back up your log and keep it in sync across your phone and laptop.</p>
    <label>Email<input id="aEmail" type="email" autocomplete="email" inputmode="email"></label>
    <label>Password<input id="aPass" type="password" autocomplete="current-password" minlength="6"></label>
    <p class="err" id="aErr" hidden></p>
    <button class="btn" id="aIn">Sign in</button>
    <button class="btn ghost" id="aUp">Create account</button>
    <button class="btn ghost" id="aReset">Forgot password</button>`);
  const err = m => { $('aErr').textContent = m; $('aErr').hidden = !m; };
  const creds = () => [$('aEmail').value.trim(), $('aPass').value];
  const busy = on => ['aIn', 'aUp', 'aReset'].forEach(id => { $(id).disabled = on; });
  $('aIn').onclick = async () => { busy(true); err(''); try { await Sync.auth.signInWithEmailAndPassword(...creds()); closeSheet(); toast('Signed in. Syncing your log.'); } catch (e) { err(authError(e)); } busy(false); };
  $('aUp').onclick = async () => { busy(true); err(''); try { await Sync.auth.createUserWithEmailAndPassword(...creds()); closeSheet(); toast('Account created. Your log is backing up.'); } catch (e) { err(authError(e)); } busy(false); };
  $('aReset').onclick = async () => {
    const em = $('aEmail').value.trim(); if (!em) { err('Type your email first.'); return; }
    try { await Sync.auth.sendPasswordResetEmail(em); err(''); toast('Reset email sent'); } catch (e) { err(authError(e)); }
  };
}

/* =================== TRENDS =================== */
let range = 30, tab = 'today';
function dayTotals(d) {
  const es = S.log[d]; if (!es || !es.length) return null;
  return { kcal: es.reduce((a, e) => a + e.kcal, 0), pro: es.reduce((a, e) => a + e.pro, 0) };
}
function slopePerWeek(pts) {          // least-squares fit of weight vs day
  if (pts.length < 3) return null;
  const xs = pts.map(p => (parseIso(p.date) - parseIso(pts[0].date)) / 864e5), ys = pts.map(p => p.lb);
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  if (den === 0 || xs[n - 1] < 4) return null;   // need at least ~5 days of spread
  return num / den * 7;
}
const TXT = 'font-size="11" fill="var(--muted)" font-family="Barlow, system-ui, sans-serif"';
function niceTicks(lo, hi) { const step = Math.max(1, Math.ceil((hi - lo) / 3)); const t = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) t.push(v); return t; }
function barChart(days, vals, opts) {
  const W = 520, H = 170, L = 40, R = 10, T = 10, B = 24, n = days.length;
  const max = Math.max(opts.hi || opts.line || 0, ...vals.map(v => v || 0)) * 1.08 || 1;
  const Y = v => T + (1 - v / max) * (H - T - B), bw = (W - L - R) / n;
  const ticks = opts.ticks.filter(v => v <= max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label)}">`;
  ticks.forEach(v => { svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" ${TXT}>${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}</text>`; });
  if (opts.lo != null) svg += `<rect x="${L}" width="${W - L - R}" y="${Y(opts.hi)}" height="${Y(opts.lo) - Y(opts.hi)}" fill="var(--protein)" opacity=".12"/>`;
  vals.forEach((v, i) => {
    if (v == null) return;
    const x = L + i * bw + bw * 0.15, w = Math.max(1.5, bw * 0.7);
    const col = opts.colorFor(v);
    svg += `<rect data-day="${days[i]}" x="${x.toFixed(1)}" y="${Y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(H - B - Y(v)).toFixed(1)}" rx="${Math.min(3, w / 2)}" fill="${col}" style="cursor:pointer"/>`;
  });
  if (opts.line != null) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(opts.line)}" y2="${Y(opts.line)}" stroke="var(--protein)" stroke-width="2" stroke-dasharray="5 4"/>`;
  svg += `<text x="${L}" y="${H - 6}" ${TXT}>${parseIso(days[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" ${TXT}>Today</text></svg>`;
  return svg;
}
function weightChart(from, to) {
  const arr = weightsArr(), pts = arr.filter(w => w.date >= from && w.date <= to);
  if (pts.length < 2) return '<p class="empty">Two or more weigh-ins in this range will draw your trend here.</p>';
  const W = 520, H = 180, L = 40, R = 12, T = 12, B = 24;
  const t0 = parseIso(from).getTime(), t1 = parseIso(to).getTime();
  const lbs = pts.map(p => p.lb).concat(S.targets.goal >= Math.min(...pts.map(p => p.lb)) - 3 ? [S.targets.goal] : []);
  const lo = Math.floor(Math.min(...lbs) - 1), hi = Math.ceil(Math.max(...lbs) + 1);
  const X = s => L + (parseIso(s).getTime() - t0) / (t1 - t0) * (W - L - R), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const av = pts.map(p => [X(p.date), Y(avgBetween(arr, shift(p.date, -6), p.date))]);
  const line = av.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight trend"><defs><linearGradient id="twg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`;
  niceTicks(lo, hi).forEach(v => { svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" ${TXT}>${v}</text>`; });
  if (S.targets.goal >= lo && S.targets.goal <= hi) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(S.targets.goal)}" y2="${Y(S.targets.goal)}" stroke="var(--protein)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W - R}" y="${Y(S.targets.goal) - 5}" text-anchor="end" font-size="11" fill="var(--protein)" font-family="Barlow, system-ui, sans-serif">Goal ${S.targets.goal}</text>`;
  svg += `<polygon points="${av[0][0].toFixed(1)},${H - B} ${line} ${av[av.length - 1][0].toFixed(1)},${H - B}" fill="url(#twg)"/>`;
  pts.forEach(p => { svg += `<circle cx="${X(p.date)}" cy="${Y(p.lb)}" r="3" fill="var(--muted)" opacity=".5"/>`; });
  const last = av[av.length - 1];
  svg += `<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0]}" cy="${last[1]}" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
  svg += `<text x="${L}" y="${H - 6}" ${TXT}>${parseIso(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" ${TXT}>Today</text></svg>`;
  return svg;
}
/* Adaptive burn: what you ate vs how your weight moved over the last 4 weeks.
   burn = average intake − (weight change per day × 3,500 kcal per lb) */
const BURN_WINDOW = 28, KCAL_PER_LB = 3500;
function estimateBurn() {
  const to = shift(todayIso(), -1), from = shift(to, -(BURN_WINDOW - 1));   // today isn't finished, so it's left out of intake
  const logged = [];
  for (let i = 0; i < BURN_WINDOW; i++) { const d = shift(from, i), t = dayTotals(d); if (t) logged.push(t.kcal); }
  const wts = weightsArr().filter(w => w.date >= from && w.date <= todayIso());
  const span = wts.length ? (parseIso(wts[wts.length - 1].date) - parseIso(wts[0].date)) / 864e5 : 0;
  const need = { days: 10, weighs: 7, span: 14 };
  const have = { days: logged.length, weighs: wts.length, span: Math.round(span) };
  if (have.days < need.days || have.weighs < need.weighs || have.span < need.span) return { ready: false, need, have };
  const intake = logged.reduce((a, b) => a + b, 0) / logged.length;
  const perWeek = slopePerWeek(wts);
  const burn = intake - (perWeek / 7) * KCAL_PER_LB;
  const conf = have.days >= 21 && have.weighs >= 14 ? 'High' : 'Medium';
  return { ready: true, intake, perWeek, burn, conf, have };
}
const r50 = n => Math.round(n / 50) * 50;
function renderBurn() {
  const e = estimateBurn(), box = $('burnBody'), conf = $('bConf');
  if (!e.ready) {
    conf.textContent = 'Learning'; conf.className = 'conf';
    const bar = (h, n) => `<div class="prog"><i style="width:${Math.min(100, h / n * 100)}%"></i></div>`;
    box.innerHTML = `<p class="hint">After about two weeks of logging food and weighing in, this shows how many calories you actually burn a day, worked out from what you eat and how your weight moves. No watch needed.</p>
      <div class="learn">
        <div><span>Days of food logged</span><b>${e.have.days}/${e.need.days}</b>${bar(e.have.days, e.need.days)}</div>
        <div><span>Morning weigh-ins</span><b>${e.have.weighs}/${e.need.weighs}</b>${bar(e.have.weighs, e.need.weighs)}</div>
        <div><span>Days of weight history</span><b>${e.have.span}/${e.need.span}</b>${bar(e.have.span, e.need.span)}</div>
      </div>`;
    return;
  }
  conf.textContent = e.conf + ' confidence'; conf.className = 'conf ' + (e.conf === 'High' ? 'ok' : '');
  const lo = Math.max(1500, r50(e.burn - 750)), hi = Math.max(lo + 100, r50(e.burn - 500));
  const T = S.targets, same = T.calLo === lo && T.calHi === hi;
  const lossTxt = e.perWeek < -0.05 ? `lost ${Math.abs(e.perWeek).toFixed(1)} lb a week` : e.perWeek > 0.05 ? `gained ${e.perWeek.toFixed(1)} lb a week` : 'held your weight steady';
  box.innerHTML = `
    <div class="burn-n"><span class="num">${r50(e.burn).toLocaleString()}</span><span class="u">kcal a day</span></div>
    <p class="hint">Over the last 4 weeks you ate about ${Math.round(e.intake).toLocaleString()} kcal a day and ${lossTxt}. That works out to this daily burn, including your training.</p>
    <div class="suggest">
      <div><span class="k">For 1–1.5 lb a week</span><span class="v">${lo.toLocaleString()}–${hi.toLocaleString()}<small>kcal</small></span></div>
      <div><span class="k">Your target now</span><span class="v">${T.calLo.toLocaleString()}–${T.calHi.toLocaleString()}<small>kcal</small></span></div>
    </div>
    ${same ? '<p class="hint">Your target already matches. Nothing to change.</p>' : `<button class="btn" id="useBurn">Use ${lo.toLocaleString()}–${hi.toLocaleString()} as my target</button>`}
    <p class="hint">Only as accurate as your logging: days with forgotten snacks make your burn look lower than it is.</p>`;
  if ($('useBurn')) $('useBurn').onclick = () => {
    const old = { ...S.targets };
    S.targets = { ...S.targets, calLo: lo, calHi: hi }; touchMeta(); renderAll();
    toast('Target updated', { label: 'Undo', fn: () => { S.targets = old; touchMeta(); renderAll(); } });
  };
}
function renderTrends() {
  const T = S.targets, to = todayIso(), from = shift(to, -(range - 1));
  const days = Array.from({ length: range }, (_, i) => shift(from, i));
  const arr = weightsArr(), inR = arr.filter(w => w.date >= from && w.date <= to);
  // weight
  const rate = slopePerWeek(inR);
  const now = avgBetween(arr, shift(to, -6), to);
  $('tRate').textContent = rate == null ? '–' : (rate > 0 ? '+' : rate < 0 ? '−' : '') + Math.abs(rate).toFixed(1);
  $('tNow').textContent = now ? now.toFixed(1) : '–';
  $('tChange').textContent = inR.length >= 2 ? ((d => (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1))(avgBetween(arr, shift(to, -6), to) - avgBetween(arr, inR[0].date, shift(inR[0].date, 6)))) : '–';
  $('tGoalK').textContent = `Reach ${T.goal}`;
  const read = $('tRead'); read.className = 'status';
  if (rate == null) { $('tEta').textContent = '–'; read.textContent = `Weigh in most mornings. After about a week, your weekly rate and goal date show up here.`; }
  else {
    const left = now - T.goal;
    if (left <= 0) { $('tEta').textContent = 'Done'; read.className = 'status ok'; read.textContent = `You're at or under ${T.goal}. Time to switch to maintenance and hold your muscle.`; }
    else if (rate < -0.05) {
      const weeks = left / -rate, eta = new Date(); eta.setDate(eta.getDate() + Math.round(weeks * 7));
      $('tEta').textContent = eta.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const r = -rate;
      if (r < 0.5) read.textContent = `Losing ${r.toFixed(1)} lb a week, which is slow. Trimming about 200 kcal a day would move you toward 1 lb a week.`;
      else if (r <= 1.6) { read.className = 'status ok'; read.textContent = `Losing ${r.toFixed(1)} lb a week, right in the 1–1.5 lb pace that protects your strength.`; }
      else { read.className = 'status hi'; read.textContent = `Losing ${r.toFixed(1)} lb a week, faster than 1.5. Watch your bench; adding 200–300 kcal a day would ease the pace.`; }
    } else { $('tEta').textContent = '–'; read.className = 'status hi'; read.textContent = `Your weight is flat or rising over this range. Check that you're logging everything, and aim for the low end of your calorie range.`; }
  }
  renderBurn();
  $('tWeightChart').innerHTML = weightChart(from, to);
  // calories + protein
  const tots = days.map(dayTotals), logged = tots.filter(Boolean);
  const avg = k => logged.length ? logged.reduce((a, t) => a + t[k], 0) / logged.length : null;
  const aK = avg('kcal'), aP = avg('pro');
  $('tCalAvg').textContent = aK ? `avg ${Math.round(aK).toLocaleString()} kcal` : '';
  $('tProAvg').textContent = aP ? `avg ${Math.round(aP)}g` : '';
  const empty = '<p class="empty">Days you log food will show up here.</p>';
  $('tCalChart').innerHTML = logged.length ? barChart(days, tots.map(t => t && t.kcal), {
    lo: T.calLo, hi: T.calHi, ticks: [1000, 2000, 3000, 4000], label: 'Daily calories',
    colorFor: v => v > T.calHi ? 'var(--warn)' : v >= T.calLo ? 'var(--protein)' : 'var(--accent)' }) : empty;
  $('tProChart').innerHTML = logged.length ? barChart(days, tots.map(t => t && t.pro), {
    line: T.protein, ticks: [50, 100, 150, 200, 250], label: 'Daily protein',
    colorFor: v => v >= T.protein ? 'var(--protein)' : 'var(--accent)' }) : empty;
  $('tCalNote').textContent = logged.length ? 'Green band is your cut range. Tap a bar to open that day.' : '';
  $('tProNote').textContent = logged.length ? `Dashed line is your ${T.protein}g target.` : '';
  const inRange = logged.filter(t => t.kcal >= T.calLo && t.kcal <= T.calHi).length, hit = logged.filter(t => t.pro >= T.protein).length;
  $('tDays').textContent = `last ${range} days`;
  $('tInRange').textContent = logged.length ? `${inRange}/${logged.length}` : '–';
  $('tProHit').textContent = logged.length ? `${hit}/${logged.length}` : '–';
  $('tLogged').textContent = `${logged.length}/${range}`;
  $('tWeighed').textContent = inR.length;
}
function showTab(t) {
  tab = t;
  $('viewToday').hidden = t !== 'today'; $('viewTrends').hidden = t !== 'trends';
  document.querySelectorAll('.tabbar button').forEach(b => b.dataset.tab === t ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (t === 'trends') renderTrends();
  window.scrollTo(0, 0);
}
document.querySelector('.tabbar').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };
$('range').onclick = e => {
  const b = e.target.closest('[data-r]'); if (!b) return;
  range = +b.dataset.r; [...$('range').children].forEach(c => c.setAttribute('aria-pressed', c === b)); renderTrends();
};
$('viewTrends').addEventListener('click', e => {
  const r = e.target.closest('rect[data-day]'); if (!r) return;
  day = r.dataset.day; showTab('today'); renderDay(); renderTotals(); renderRows();
});

/* ---------- events ---------- */
$('swatches').onclick = e => {
  const b = e.target.closest('[data-c]'); if (!b) return;
  S.theme = b.dataset.c; applyTheme(); touchMeta(); if (tab === 'trends') renderTrends();
};
document.querySelector('.actions').onclick = e => {
  const b = e.target.closest('[data-open]'); if (!b) return;
  ({ scan: openScan, label: () => openLabel(null), search: openSearch, meals: openMeals })[b.dataset.open]();
};
$('syncBtn').onclick = openAccount;
$('prev').onclick = () => { day = shift(day, -1); renderDay(); renderTotals(); renderRows(); };
$('next').onclick = () => { if (day < todayIso()) { day = shift(day, 1); renderDay(); renderTotals(); renderRows(); } };
$('rows').onclick = e => {
  const x = e.target.closest('[data-del]');
  if (x) { removeEntry(x.dataset.del); return; }
  const r = e.target.closest('.row[data-id]'); if (!r) return;
  const en = entriesFor(day).find(z => z.id === r.dataset.id); if (!en) return;
  openAmount(entryFood(en), en.food ? { qty: en.qty, unit: en.unit } : { qty: 1, unit: 'serving' }, { editId: en.id });
};
$('wSave').onclick = () => {
  const v = parseFloat($('wIn').value);
  if (!(v >= 80 && v <= 500)) { toast('Enter your weight in pounds.'); return; }
  S.weights[todayIso()] = r1(v); touchDay(todayIso()); renderWeights(); $('wIn').blur(); toast('Weigh-in saved');
};
$('tForm').onsubmit = e => {
  e.preventDefault();
  const lo = +$('tLo').value, hi = +$('tHi').value, pr = +$('tPro').value, g = +$('tGoal').value;
  if (!(lo > 0 && hi >= lo && pr > 0 && g > 0)) { toast('Check the targets: the low number must be below the high one.'); return; }
  S.targets = { calLo: lo, calHi: hi, protein: pr, goal: g }; touchMeta(); renderAll(); toast('Targets saved');
};
$('foodList').onclick = e => {
  const b = e.target.closest('[data-del-food]'); if (!b) return;
  S.foods = S.foods.filter(f => f.id !== b.dataset.delFood);
  S.recent = S.recent.filter(r => r.food.id !== b.dataset.delFood); touchMeta(); renderSettings();
};
$('exportBtn').onclick = () => {
  const { dirty, ...data } = S;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `cutlog-backup-${todayIso()}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
};
$('importIn').onchange = async () => {
  const file = $('importIn').files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.v !== 1 || typeof data.log !== 'object') throw new Error('bad');
    if (!confirm('Replace everything in the app with this backup?')) return;
    S = Object.assign(seed(), data); S.dirty = []; touchAll(); renderAll(); toast('Backup restored');
  } catch (e) { toast("That file isn't a Cut Log backup."); }
};
/* If the app was left open past midnight, jump from yesterday to the new day */
let lastToday = todayIso();
function checkNewDay() {
  const t = todayIso();
  if (t !== lastToday) { if (day === lastToday) day = t; lastToday = t; renderAll(); }
}
setInterval(checkNewDay, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkNewDay(); renderAll(); if (Sync.user) flush(); } });

/* app feel: no pinch zoom (iOS ignores the viewport setting) */
['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));

renderAll();
initSync();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
