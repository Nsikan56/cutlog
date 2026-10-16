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
    u.push({ key: 'oz', label: 'oz', g: 28.35 });
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
  return short || (u.label + (qty !== 1 && !/s$/.test(u.label) ? 's' : ''));
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
function stepFor(unit) { return unit === 'g' ? 10 : (unit === 'piece' || unit === 'serving') ? 1 : 0.5; }

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
    return `<div class="row"><span class="n">${esc(e.name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
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
  if (a && b) { const x = a - b; d.textContent = (x > 0 ? '+' : '') + x.toFixed(1); d.classList.add(x <= 0 ? 'down' : 'up'); } else d.textContent = '–';
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
function renderAll() { renderDay(); renderTotals(); renderRows(); renderWeights(); renderSettings(); renderSync(); }

/* ---------- log actions ---------- */
function addEntry(name, kcal, pro, detail) {
  (S.log[day] ||= []).push({ id: uid(), name, kcal: r1(kcal), pro: r1(pro), detail: detail || '', at: Date.now() });
  touchDay(day); renderTotals(); renderRows();
}
function rememberFood(f) {
  if (f.source !== 'built-in') {
    const i = S.foods.findIndex(x => x.id === f.id);
    if (i >= 0) S.foods[i] = f; else S.foods.unshift(f);
  }
}
function pushRecent(f, qty, unit) {
  S.recent = [{ food: f, qty, unit }, ...S.recent.filter(r => r.food.id !== f.id)].slice(0, 12);
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

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
  if (onSheetClose) { try { onSheetClose(); } catch (e) {} onSheetClose = null; }
  $('sheet').hidden = true; $('scrim').hidden = true;
  document.body.style.overflow = '';
}
$('sheetClose').onclick = closeSheet;
$('scrim').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

/* ---------- amount step (shared by every flow) ---------- */
function openAmount(f, preset) {
  const units = unitsFor(f);
  if (!units.length) { toast('This food has no calorie data. Try the label photo instead.'); return; }
  let unit = preset?.unit && units.some(u => u.key === preset.unit) ? preset.unit
    : (units.find(u => u.key === 'piece') || units.find(u => u.key === 'serving') || units[0]).key;
  const startQty = preset?.qty ?? (unit === 'g' ? 100 : 1);
  const dayName = $('dayLabel').textContent;
  openSheet('How much?', `
    <div class="food-head"><strong>${esc(f.name)}</strong><span>${esc([f.brand, perLine(f)].filter(Boolean).join(' · '))}</span></div>
    <div class="stepper">
      <button id="aMinus" aria-label="Less">−</button>
      <input id="aQty" type="number" inputmode="decimal" step="any" min="0" value="${startQty}" aria-label="Amount">
      <button id="aPlus" aria-label="More">+</button>
    </div>
    <div class="chips" id="aUnits" role="group" aria-label="Unit">${units.map(u => `<button class="chip" data-u="${u.key}" aria-pressed="${u.key === unit}" title="${esc(u.long || u.label)}">${esc(u.key === 'serving' && f.servingLabel ? 'serving · ' + f.servingLabel : u.label)}</button>`).join('')}</div>
    <div class="result"><div><span class="num" id="aK">0</span><small>kcal</small></div><div class="pro"><span class="num" id="aP">0g</span><small>protein</small></div></div>
    <p class="hint" id="aNote" hidden>Spoon sizes are approximate: about 15 g per tablespoon and 5 g per teaspoon. A heaping spoon is closer to 25 g.</p>
    <button class="btn" id="aAdd">Add to ${esc(dayName === 'Today' ? 'today' : dayName)}</button>
    <button class="btn ghost" id="aFix">Numbers look wrong? Fix them</button>`);
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
  $('aFix').onclick = () => {
    const g = f.servingG || null;
    const per = f.kcalServ != null ? { kcal: f.kcalServ, pro: f.proServ }
      : g ? { kcal: f.kcal100 * g / 100, pro: (f.pro100 || 0) * g / 100 } : { kcal: f.kcal100, pro: f.pro100 };
    openSheet('Fix the numbers', `<p class="hint">Enter what the label says for one serving. The app will use your numbers for this food from now on.</p><div id="labelOut"></div>`);
    labelForm($('labelOut'), { kcal: Math.round(per.kcal), pro: r1(per.pro || 0), servingG: g || (f.kcalServ == null ? 100 : null) }, '', f.barcode || null, f.name, f.id);
  };
  $('aAdd').onclick = () => {
    const q = parseFloat($('aQty').value);
    if (!(q > 0)) { toast('Enter how much you had.'); return; }
    const v = calc(f, q, unit);
    rememberFood(f); pushRecent(f, q, unit); touchMeta();
    addEntry(f.name, v.kcal, v.pro, `${fmtQty(q)} ${unitWord(f, unit, q)}`);
    renderSettings(); closeSheet(); toast(`Added ${Math.round(v.kcal)} kcal · ${Math.round(v.pro)}g protein`);
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
  openSheet('Search foods', `
    <input id="q" type="search" placeholder="Sweet potato, eggs, yogurt…" aria-label="Search foods" autocomplete="off">
    <div class="list" id="results"></div>
    <button class="btn ghost" id="online" hidden>Search packaged foods online</button>
    <button class="btn ghost" id="custom">Enter a food by hand</button>`);
  let items = [];
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
function openMeals() {
  const es = entriesFor(day);
  openSheet('My meals', `
    <div class="list" id="mealList">${S.meals.length ? S.meals.map((m, i) => `<button class="item" data-m="${i}"><span class="nm">${esc(m.name)}</span>
      <span class="meta">${m.kcal} kcal · ${m.pro}g</span></button>`).join('') : '<p class="empty">No saved meals yet.</p>'}</div>
    <h3>Save a new meal</h3>
    ${es.length ? `<button class="btn ghost" id="fromDay">Fill in from everything logged ${day === todayIso() ? 'today' : 'this day'}</button>` : ''}
    <label>Name<input id="mName" placeholder="e.g. Post-gym chicken bowl"></label>
    <div class="grid2"><label>Calories<input id="mK" type="number" inputmode="numeric"></label><label>Protein (g)<input id="mP" type="number" inputmode="numeric"></label></div>
    <button class="btn" id="mSave">Save meal</button>
    ${S.meals.length ? `<details><summary>Remove a meal</summary><div class="mlist" id="mDel">${S.meals.map((m, i) => `<div class="mrow"><span>${esc(m.name)}</span><button class="x" data-md="${i}" aria-label="Remove ${esc(m.name)}">${icon('i-x')}</button></div>`).join('')}</div></details>` : ''}`);
  $('mealList').onclick = e => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    const m = S.meals[+b.dataset.m]; addEntry(m.name, m.kcal, m.pro, 'saved meal'); closeSheet(); toast(`Added ${m.kcal} kcal · ${m.pro}g protein`);
  };
  if ($('fromDay')) $('fromDay').onclick = () => {
    $('mK').value = Math.round(es.reduce((a, e) => a + e.kcal, 0));
    $('mP').value = Math.round(es.reduce((a, e) => a + e.pro, 0));
    $('mName').focus();
  };
  $('mSave').onclick = () => {
    const n = $('mName').value.trim(), k = parseFloat($('mK').value), p = parseFloat($('mP').value) || 0;
    if (!n || !(k >= 0)) { toast('Add a name and calories.'); return; }
    S.meals.push({ id: uid(), name: n, kcal: Math.round(k), pro: Math.round(p) }); touchMeta(); openMeals(); toast('Meal saved');
  };
  if ($('mDel')) $('mDel').onclick = e => { const b = e.target.closest('[data-md]'); if (!b) return; S.meals.splice(+b.dataset.md, 1); touchMeta(); openMeals(); };
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
function metaDoc() { return { targets: S.targets, meals: S.meals, foods: S.foods, recent: S.recent, updatedAt: S.stamps.meta || Date.now() }; }
function applyDay(id, data) {
  if (data.entries && data.entries.length) S.log[id] = data.entries; else delete S.log[id];
  if (data.weight != null) S.weights[id] = data.weight; else delete S.weights[id];
  S.stamps.days[id] = data.updatedAt || 0;
  S.dirty = S.dirty.filter(k => k !== 'd:' + id);
}
function applyMeta(data) {
  ['targets', 'meals', 'foods', 'recent'].forEach(k => { if (data[k] !== undefined) S[k] = data[k]; });
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

/* ---------- events ---------- */
document.querySelector('.actions').onclick = e => {
  const b = e.target.closest('[data-open]'); if (!b) return;
  ({ scan: openScan, label: () => openLabel(null), search: openSearch, meals: openMeals })[b.dataset.open]();
};
$('syncBtn').onclick = openAccount;
$('prev').onclick = () => { day = shift(day, -1); renderDay(); renderTotals(); renderRows(); };
$('next').onclick = () => { if (day < todayIso()) { day = shift(day, 1); renderDay(); renderTotals(); renderRows(); } };
$('rows').onclick = e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  S.log[day] = entriesFor(day).filter(x => x.id !== b.dataset.del);
  if (!S.log[day].length) delete S.log[day];
  touchDay(day); renderTotals(); renderRows();
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderAll(); if (Sync.user) flush(); } });

/* app feel: no pinch zoom (iOS ignores the viewport setting) */
['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));

renderAll();
initSync();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
