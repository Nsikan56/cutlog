/* Cut Log — free calorie & protein tracker.
   Data is saved on the phone first (works offline), then synced to Firebase when signed in. */
'use strict';
/* The page and this script must come from the same update; if a cached copy is mixed in, reload once */
const APP_V = '63';
(() => {
  const htmlV = document.querySelector('meta[name="app-v"]')?.content;
  if (htmlV && htmlV !== APP_V) {
    let tried = false; try { tried = sessionStorage.getItem('cl-v') === htmlV + APP_V; sessionStorage.setItem('cl-v', htmlV + APP_V); } catch (e) {}
    if (!tried) {
      const go = () => location.reload();
      (window.caches ? caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))) : Promise.resolve()).then(go, go);
      throw new Error('Cut Log: updating');
    }
  }
})();

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
/* v62: protein in How much? keeps one decimal up to 30 g, so it matches the per-100 g line above it (22.6, not 23) */
const fmtP = g => (g >= 9.95 && g < 29.95 ? String(r1(g)) : fmtG(g)) + 'g';
const fmtG = g => { if (!(g > 0)) return '0'; if (g >= 9.95) return String(Math.round(g)); const v = Math.round(g * 10) / 10; return v === 0 ? '<0.1' : String(v); };
const fmtQty = q => (Math.round(q * 100) / 100).toString();
const icon = id => `<svg><use href="#${id}"/></svg>`;
/* ---------- motion helpers ---------- */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = t => 1 - Math.pow(1 - t, 3);
function animateNum(el, to, fmt = n => Math.round(n).toLocaleString(), ms = 550) {
  const from = el._v ?? 0; el._v = to;
  cancelAnimationFrame(el._raf);
  if (REDUCED || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = now => { const p = Math.min(1, (now - t0) / ms); el.textContent = fmt(from + (to - from) * easeOut(p)); if (p < 1) el._raf = requestAnimationFrame(step); };
  el._raf = requestAnimationFrame(step);
}
/* v54: every dropdown (<details>) glides open and shut instead of snapping. The open attribute is set at the start of opening
   and removed at the end of closing, so 'toggle' listeners and saved open/closed states work as before. */
const EASE_OUT = 'cubic-bezier(.2,.8,.2,1)';
function smoothDetails(e) {
  const s = e.target.closest('summary'), d = s && s.parentElement;
  if (!d || d.tagName !== 'DETAILS' || REDUCED || typeof d.animate !== 'function') return;
  e.preventDefault();
  const from = d.getBoundingClientRect().height, opening = !d.open || d.classList.contains('shut');
  if (d._anim) { d._anim.cancel(); d._anim = null; }
  d.classList.remove('shut', 'opening');
  d.open = opening; const to = d.getBoundingClientRect().height;   // measure the end size without painting
  d.open = true; d.classList.add(opening ? 'opening' : 'shut'); d.style.overflow = 'hidden';
  const a = d._anim = d.animate({ height: [from + 'px', to + 'px'] }, { duration: opening ? 340 : 260, easing: EASE_OUT });
  a.onfinish = () => { d._anim = null; d.style.overflow = ''; d.classList.remove('opening', 'shut'); if (!opening) d.open = false; };
}
document.addEventListener('click', smoothDetails);
function replay(el, cls) { if (!el || REDUCED) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
/* light haptic tap: iOS 18 gives a tick when a switch-style checkbox toggles */
const hapticEl = (() => { const l = document.createElement('label'); l.ariaHidden = 'true'; l.style.cssText = 'position:fixed;left:-9999px;opacity:0;pointer-events:none';
  const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); l.appendChild(i); document.body.appendChild(l); return l; })();
function haptic() { try { if (navigator.vibrate) navigator.vibrate(12); else hapticEl.click(); } catch (e) {} }

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
    targets: { calLo: 2000, calHi: 2300, protein: 150, goal: null, mode: 'lose' },
    meals: [], foods: [], recent: [], log: {}, weights: {}, slotPref: {},
    onboarded: false, name: '', startWeight: null, milestones: {}, msInit: false, scale: 'daily', waist: {}, units: 'imperial',
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
      if (s.onboarded === undefined) st.onboarded = true;   // saved before setup existed = already set up
      st.slotPref ||= {}; st.milestones ||= {}; st.waist ||= {};
      st.targets = Object.assign({ mode: 'lose' }, st.targets);   // the app began as a cutting app
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
function touchDay(d) { S.stamps.days[d] = Date.now(); markDirty('d:' + d); persist(); scheduleFlush(); queueMicrotask(() => checkMilestones()); }
function touchMeta() { S.stamps.meta = Date.now(); markDirty('meta'); persist(); scheduleFlush(); if (!msBusy) queueMicrotask(() => checkMilestones()); }
function touchAll() {
  const now = Date.now();
  S.stamps.meta = now; markDirty('meta');
  new Set([...Object.keys(S.log), ...Object.keys(S.weights), ...Object.keys(S.waist || {})]).forEach(d => { S.stamps.days[d] = now; markDirty('d:' + d); });
  persist(); scheduleFlush();
}
let day = todayIso();

/* ---------- nutrition math ---------- */
/* v43: cooked food without a scale. Plate and bowl sizes, raw/cooked twins for staples, and oil added in cooking. */
const PLATE_HINT = {
  plate: { s: 'side plate, or a light helping', m: 'a normal dinner plate, not heaped', l: 'heaped, or a restaurant plate' },
  bowl: { s: 'small bowl, or half full', m: 'a normal bowl', l: 'a big bowl, or a restaurant bowl' },
};
const OIL = { none: { k: 0, t: 'None' }, little: { k: 40, t: 'A little', d: 'a little oil' }, lot: { k: 120, t: 'A lot', d: 'plenty of oil' } };
const oilKey = k => OIL[k] && k !== 'none' ? k : null;
/* the built-in food behind an entry's saved copy (older copies don't have the newer twin/cook fields) */
const baseOf = f => (f && f.source === 'built-in' && BUILTIN_FOODS.find(b => b.id === f.id && b.name === f.name)) || f;
const twinOf = f => {
  if (f?.cookOf) return S.foods.find(x => x.id === f.cookOf) || PKG_SEEN.get(f.cookOf) || null;   // v61: cooked -> the package (v63: even if not saved yet)
  const pp = pkgPair(f); if (pp) return cookedOf(f, pp);                          // v61: a package -> its cooked version
  const b = baseOf(f); return b?.twin ? BUILTIN_FOODS.find(x => x.name === b.twin) || null : null;
};
/* v61: Raw / Cooked for your own packaged foods. Package labels for meat, fish, rice, pasta and oats give the raw or dry
   food. Kan weighs his food after cooking, and cooked meat weighs less (it loses water) while the calories stay, so the
   label undercounts by about a quarter for ground chicken. A saved or scanned food whose name matches one of the built-in
   raw/cooked pairs gets the same switch: Raw weight (or Dry weight) is the package as it is, and Cooked scales every number
   per 100 g by how much that pair changes when cooked (ground chicken 140 -> 180 kcal, so x1.29; white rice 365 -> 130,
   so x0.36). Rice, pasta and oats must also have dry-food numbers (closer to the dry food than the cooked one), so a
   package that's already cooked (ready rice) never gets it. Cooked versions are made when needed, never saved as foods. */
const PKG_PAIRS = [
  [/\b(ground|minced) chicken\b|\bchicken,? (ground|mince)/, 'Ground chicken, extra lean (raw)'],
  [/\b(ground|minced) beef\b|\bbeef,? (ground|mince)/, 'Ground beef, extra lean (raw)'],
  [/\bchicken breasts?\b/, 'Chicken breast (raw)'],
  [/\bbasa\b|\bswai\b|\bpangasius\b/, 'Basa / swai fillet (raw)'],
  [/\bsalmon\b/, 'Salmon, Atlantic (raw)'],
  [/\bbrown rice\b/, 'Brown rice (dry)'],
  [/\brice\b/, 'White rice (dry)'],
  [/\b(pasta|spaghetti|spaghettini|penne|macaroni|fusilli|linguine|rigatoni|rotini|fettuccine|farfalle|orzo)\b/, 'Pasta (dry)'],
  [/\boats\b|\boatmeal\b|\bporridge\b/, 'Oats, rolled (dry)'],
];
const PKG_NOT = /\b(cooked|roasted|grilled|smoked|canned|tinned|deli|sliced|nuggets?|breaded|fried|strips|cakes?|crackers?|crisps?|crispy|chips|cereal|milk|flour|bran|bars?|sauce|soup|pudding|salad|bowl|drink|granola|cookies?|vinegar|wine|oil|jerky|sushi|dinner|meal|kit)\b/;
function pkgPair(f) {
  if (!f || NOT_SAVED.includes(f.source) || f.source === 'cooked' || f.cookOf || !(f.kcal100 > 0)) return null;
  const nm = String(f.name || '').toLowerCase();
  if (PKG_NOT.test(nm)) return null;
  const hit = PKG_PAIRS.find(([re]) => re.test(nm)); if (!hit) return null;
  const raw = BUILTIN_FOODS.find(x => x.name === hit[1]), cooked = raw && BUILTIN_FOODS.find(x => x.name === raw.twin);
  if (!cooked) return null;
  if (raw.state === 'dry' && Math.abs(f.kcal100 - raw.kcal100) >= Math.abs(f.kcal100 - cooked.kcal100)) return null;   // already cooked
  return { raw, cooked };
}
const PKG_SEEN = new Map();   // v63: packs opened this session, so a just-scanned pack can be saved when it's logged as Cooked
function cookedOf(p, pp = pkgPair(p)) {
  if (!pp) return null;
  PKG_SEEN.set(p.id, p);
  const k = pp.cooked.kcal100 / pp.raw.kcal100;
  const c = { id: p.id + '~cooked', cookOf: p.id, name: `${p.name} (cooked)`, source: 'cooked', state: 'cooked', kcal100: p.kcal100 * k, pro100: (p.pro100 || 0) * k };
  if (p.brand) c.brand = p.brand;
  if (pp.cooked.cook) c.cook = true;
  if (pp.cooked.cup) c.cup = pp.cooked.cup;
  const f100 = p.fib100 != null ? p.fib100 : p.fibServ != null && p.servingG ? p.fibServ / p.servingG * 100 : null;
  if (f100 != null) c.fib100 = f100 * k;
  if (nsOk(p.nutri)) c.nutri = p.nutri;
  return c;
}
const stateOf = x => x.state || pkgPair(x)?.raw.state || 'raw';
/* the last time you logged this package, was it cooked? Then open it that way again */
const lastCooked = id => S.recent.find(r => r.food && (r.food.id === id || r.food.cookOf === id))?.food.cookOf === id;
function unitsFor(f) {
  const u = [];
  if (f.kcalServ != null || f.servingG) u.push({ key: 'serving', label: 'serving', long: f.servingLabel ? `serving (${f.servingLabel})` : 'serving', g: f.servingG || null });
  const dish = f.piece && /^(plate|bowl)$/.test(f.pieceLabel || '');      // plates and bowls come in three sizes
  if (dish) u.push({ key: 'pieceS', label: `small ${f.pieceLabel}`, long: PLATE_HINT[f.pieceLabel].s, g: f.piece * 0.6 });
  if (f.piece) u.push({ key: 'piece', label: f.pieceLabel || 'piece', long: dish ? PLATE_HINT[f.pieceLabel].m : undefined, g: f.piece });
  if (dish) u.push({ key: 'pieceL', label: `large ${f.pieceLabel}`, long: PLATE_HINT[f.pieceLabel].l, g: f.piece * 1.5 });
  if (f.kcal100 != null) {
    u.push({ key: 'g', label: 'grams', g: 1 });
    // hand portions: no scale needed (fist ≈ 1 cup, so it uses the food's cup weight when known)
    u.push({ key: 'palm', label: 'palm', long: 'palm-sized, about 100 g', g: 100 });
    u.push({ key: 'fist', label: 'fist', long: 'fist-sized, about 1 cup', g: f.cup || 150 });
    u.push({ key: 'cupped', label: 'cupped hand', long: 'about ½ cup', g: (f.cup || 150) / 2 });
    u.push({ key: 'tbsp', label: 'tbsp', long: 'tablespoon', g: 15 });
    u.push({ key: 'tsp', label: 'tsp', long: 'teaspoon', g: 5 });
    if (f.cup) u.push({ key: 'cup', label: 'cup', g: f.cup });
    u.push({ key: 'oz', label: 'oz (weight)', long: 'ounce by weight, 28 g', g: 28.35 });
  }
  return u;
}
/* fib is null when the food has no fibre data, so a total never pretends to know more than it does */
function calc(f, qty, unitKey) {
  const u = unitsFor(f).find(x => x.key === unitKey);
  if (!u || !(qty > 0)) return { kcal: 0, pro: 0, fib: null };
  if (u.key === 'serving' && f.kcalServ != null) {
    const fib = f.fibServ != null ? qty * f.fibServ : f.fib100 != null && f.servingG ? qty * f.servingG * f.fib100 / 100 : null;
    return { kcal: qty * f.kcalServ, pro: qty * (f.proServ || 0), fib };
  }
  const g = qty * u.g;
  const fib = f.fib100 != null ? g * f.fib100 / 100 : f.fibServ != null && f.servingG ? g * f.fibServ / f.servingG : null;
  return { kcal: g * f.kcal100 / 100, pro: g * (f.pro100 || 0) / 100, fib };
}
const hasFib = f => !!f && (f.fib100 != null || f.fibServ != null);
const fibPerServ = (f, g) => { const v = f.fibServ != null ? f.fibServ : f.fib100 != null ? f.fib100 * (g || 100) / 100 : null; return v == null ? null : r1(v); };
function setFib(e, v) { if (v == null || !isFinite(v)) delete e.fib; else e.fib = r1(v); }
/* Fibre for one logged entry, in grams, or null when unknown. Entries logged before v41 have no fib field:
   built-in foods and saved foods that have fibre now are worked out from the entry's own amount, without changing what's saved. */
function entryFib(e) {
  if (e.fib != null) return e.fib;
  const f = e.food; if (!f || !(e.qty > 0)) return null;
  let src = null;
  if (f.source === 'meal' && !hasFib(f)) return loggedMealFib(e);
  if (f.source === 'built-in') src = BUILTIN_FOODS.find(b => b.id === f.id && b.name === f.name);
  else if (!hasFib(f)) {
    /* The saved food may have been fixed since (Edit numbers re-saves calories rounded per serving and recalculates per 100 g),
       so compare what it gives for this entry's amount with what was logged, allowing for rounding (v47). */
    const s = f.cookOf ? (p => p && cookedOf(p))(S.foods.find(x => x.id === f.cookOf)) : S.foods.find(x => x.id === f.id);   // v61: cooked -> its package
    if (s && hasFib(s) && unitsFor(s).some(u => u.key === e.unit)) {
      // a meal ingredient has no logged calories of its own, so compare with what its own copy gives (v49)
      const v = calc(s, e.qty, e.unit), logged = e.kcal != null ? e.kcal - (OIL[e.oil]?.k || 0) : calc(f, e.qty, e.unit).kcal;
      if (v.fib != null && Math.abs(v.kcal - logged) <= Math.max(3, logged * 0.03)) return v.fib;
    }
    return null;
  }
  if (!hasFib(f) && !hasFib(src)) return null;
  const v = calc(hasFib(f) ? f : { ...f, fib100: src.fib100, fibServ: src.fibServ }, e.qty, e.unit);
  return v.fib;
}
/* v49: a meal logged before its ingredients had fibre. Work it out from the saved meal as it is now, but only if the
   meal still gives the same calories for that amount (so a meal changed since doesn't rewrite older days). */
function loggedMealFib(e) {
  const m = S.meals.find(x => 'meal-' + x.id === e.food.id); if (!m) return null;
  const f = mealFood(m); if (!hasFib(f) || !unitsFor(f).some(u => u.key === e.unit)) return null;
  const v = calc(f, e.qty, e.unit);
  return v.fib != null && Math.abs(v.kcal - e.kcal) <= Math.max(3, e.kcal * 0.03) ? v.fib : null;
}
const itemFib = it => entryFib({ food: it.food, qty: it.qty, unit: it.unit });
/* v50: a meal where only some ingredients have fibre data counts the ones that do, as an "at least" figure.
   Worked out from the saved meal each time it's shown; nothing new is stored on meals or entries. */
function mealPartFood(m) {
  if (!m) return null;
  const fibs = (m.items || []).map(itemFib), have = fibs.filter(x => x != null);
  if (!have.length || have.length === fibs.length) return null;
  const tot = have.reduce((a, b) => a + b, 0), f = mealFood(m);
  f.fibServ = tot / Math.max(1, m.servings || 1); if (m.cookedG > 0) f.fib100 = tot / m.cookedG * 100;
  return f;
}
const mealOf = f => f?.source === 'meal' ? S.meals.find(x => 'meal-' + x.id === f.id) || null : null;
/* the known part of a logged meal's fibre, only while the meal still gives the same calories for that amount */
function entryFibPart(e) {
  const pf = mealPartFood(mealOf(e.food)); if (!pf || !(e.qty > 0) || !unitsFor(pf).some(u => u.key === e.unit)) return null;
  const v = calc(pf, e.qty, e.unit);
  return v.fib != null && Math.abs(v.kcal - e.kcal) <= Math.max(3, e.kcal * 0.03) ? v.fib : null;
}
function dayFib(d) {
  const es = entriesFor(d); let g = 0, known = 0, part = 0;
  es.forEach(e => { const x = entryFib(e); if (x != null) { g += x; known++; } else { const y = entryFibPart(e); if (y != null) { g += y; part++; } } });
  return { g, known, part, total: es.length };
}
/* Nutri-Score: Open Food Facts' A–E grade for packaged foods. Only a–e are kept. */
const nsOk = g => /^[a-e]$/.test(g || '');
const nsBadge = (f, long) => nsOk(f?.nutri) ? `<span class="ns ns-${f.nutri}" title="Nutri-Score ${f.nutri.toUpperCase()}: a grade from Open Food Facts for packaged foods, A best to E least">${long ? 'Nutri-Score ' : ''}<b>${f.nutri.toUpperCase()}</b></span>` : '';
function unitWord(f, unitKey, qty) {
  const u = unitsFor(f).find(x => x.key === unitKey);
  if (!u) return '';
  const short = { g: 'g', tbsp: 'tbsp', tsp: 'tsp', oz: 'oz', cup: qty === 1 ? 'cup' : 'cups', serving: qty === 1 ? 'serving' : 'servings' }[u.key];
  if (short) return short;
  if (qty === 1 || /s$/.test(u.label)) return u.label;
  return /o$/.test(u.label) ? u.label + 'es' : u.label + 's';
}
function servLabel(f) {
  const s = f.servingLabel || (f.servingG ? f.servingG + ' g' : '');
  return String(s).replace(/(\d)\.0+(?=\s*(g|ml)\b)/gi, '$1').replace(/(\d)(g|ml)\b/gi, '$1 $2');
}
function perLine(f) {
  if (f.kcal100 != null) {
    let s = `${Math.round(f.kcal100)} kcal · ${r1(f.pro100 || 0)}g protein per 100 g`;
    if (f.servingG) s += ` · serving ${servLabel(f)}`;
    return s;
  }
  if (f.kcalServ != null) return `${Math.round(f.kcalServ)} kcal · ${r1(f.proServ || 0)}g protein per serving`;
  return '';
}
function stepFor(unit) { return unit === 'g' ? 10 : unit === 'piece' ? 1 : 0.5; }
const HAND = ['palm', 'fist', 'cupped'];

/* ---------- rendering ---------- */
function entriesFor(d) { return S.log[d] || []; }
function setArc(el, frac) {
  if (!el.style.strokeDasharray) { el.style.strokeDasharray = RING_C; el.style.strokeDashoffset = RING_C; el.getBoundingClientRect(); }
  el.style.strokeDashoffset = RING_C * (1 - Math.max(0, Math.min(1, frac)));
}
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
  animateNum($('calNum'), cal);
  setArc($('calArc'), cal / T.calHi);
  $('calRing').classList.toggle('over', cal > T.calHi);
  const tick = $('calTick'), tl = 1.2;   // short mark where the range starts
  tick.style.strokeDasharray = `${tl} ${RING_C}`; tick.style.strokeDashoffset = -(RING_C * T.calLo / T.calHi) + tl / 2;
  $('calSub').textContent = `of ${T.calLo.toLocaleString()}–${T.calHi.toLocaleString()}`;
  animateNum($('proNum'), pro);
  setArc($('proArc'), pro / T.protein);
  $('proSub').textContent = pro >= T.protein ? `${T.protein}g target hit` : `${T.protein - pro}g to go`;
  const st = $('status'), before = st.textContent; st.className = 'status';
  queueMicrotask(() => { if (st.textContent !== before) replay(st, 'fade-in'); });
  if (!es.length) st.textContent = 'Scan, snap or search what you eat and the rings fill up.';
  else if (cal < T.calLo) st.textContent = mode() === 'gain' ? `${(T.calLo - cal).toLocaleString()} kcal to go to reach your range. Room for another meal.` : `${(T.calLo - cal).toLocaleString()} kcal under your range. Room for a high-protein snack.`;
  else if (cal <= T.calHi) { st.className = 'status ok'; st.textContent = 'In your range for today.'; }
  else { st.className = 'status hi'; st.textContent = `${(cal - T.calHi).toLocaleString()} kcal over your range. One day like this is fine; the weekly trend decides.`; }
  safe(renderFits); safe(renderWeek); safe(renderCiBanner); safe(renderNudge); safe(renderNut); safe(renderGuideBanner); safe(renderEstBanner);
}
let shownRows = { day: null, ids: new Set() };
function renderRows() {
  const es = entriesFor(day), r = $('rows');
  const fresh = shownRows.day === day ? es.filter(e => !shownRows.ids.has(e.id)).map(e => e.id) : [];
  shownRows = { day, ids: new Set(es.map(e => e.id)) };
  $('count').textContent = es.length ? `${es.length} item${es.length > 1 ? 's' : ''}` : '';
  $('rowsHint').hidden = !es.length; renderCopy();
  if (!es.length) { r.innerHTML = '<p class="empty">Nothing logged for this day yet.</p>'; return; }
  const rowHtml = e => {
    const time = e.at ? new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
    const sub = [e.detail, time].filter(Boolean).join(' · ');
    return `<div class="row${fresh.includes(e.id) ? ' row-in' : ''}" data-id="${esc(e.id)}"><span class="n">${esc(e.name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="c">${Math.round(e.kcal)}<small>kcal</small></span><span class="pill">${fmtG(e.pro)}g</span></div>`;
  };
  r.innerHTML = SLOTS.map(([k, label]) => {
    const g = es.filter(e => slotOf(e) === k); if (!g.length) return '';
    const tk = g.reduce((a, e) => a + e.kcal, 0), tp = g.reduce((a, e) => a + e.pro, 0);
    return `<div class="mgroup"><div class="mg-h"><span>${label}</span><span class="mg-t">${Math.round(tk).toLocaleString()} kcal · ${fmtG(tp)}g</span></div>${g.map(rowHtml).join('')}</div>`;
  }).join('');
}
function copySource() {
  for (let i = 1; i <= 14; i++) { const d = shift(day, -i); if (entriesFor(d).length) return d; }
  return null;
}
function dayName(d) {
  if (d === shift(todayIso(), -1)) return 'yesterday';
  if (d === shift(day, -1)) return 'the day before';
  return parseIso(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function renderCopy() {
  const src = copySource(), b = $('copyBtn');
  b.hidden = !src;
  if (src) b.textContent = `Copy from ${dayName(src)}`;
}
function copyEntries(list, src) {
  const now = Date.now(), ids = [];
  list.forEach((e, i) => { const c = { ...e, id: uid(), at: now + i, slot: slotOf(e) }; ids.push(c.id); (S.log[day] ||= []).push(c); });
  touchDay(day); renderTotals(); renderRows(); haptic();
  const kc = list.reduce((a, e) => a + e.kcal, 0);
  toast(`Copied ${list.length} item${list.length > 1 ? 's' : ''} · ${Math.round(kc).toLocaleString()} kcal`, { label: 'Undo', fn: () => {
    S.log[day] = entriesFor(day).filter(e => !ids.includes(e.id)); if (!S.log[day].length) delete S.log[day];
    touchDay(day); renderTotals(); renderRows(); } });
}
function openCopy() {
  const src = copySource(); if (!src) return;
  const es = entriesFor(src), name = dayName(src);
  const total = es.reduce((a, e) => a + e.kcal, 0);
  openSheet(`Copy from ${name}`, `
    <p class="hint">Tap a meal or a single item to add it to ${day === todayIso() ? 'today' : 'this day'}.</p>
    ${SLOTS.map(([k, label]) => {
      const g = es.filter(e => slotOf(e) === k); if (!g.length) return '';
      const tk = g.reduce((a, e) => a + e.kcal, 0);
      return `<div class="copy-g"><div class="mg-h"><span>${label}</span><button class="edit" data-cs="${k}">Copy ${label.toLowerCase()} · ${Math.round(tk)} kcal</button></div>
        <div class="list">${g.map(e => `<button class="item" data-ce="${esc(e.id)}"><span class="nm">${esc(e.name)}<small>${esc(e.detail || '')}</small></span><span class="meta">${Math.round(e.kcal)} kcal</span></button>`).join('')}</div></div>`;
    }).join('')}
    <button class="btn" id="copyAll">Copy everything · ${Math.round(total).toLocaleString()} kcal</button>`);
  $('sheetBody').onclick = e => {
    const s = e.target.closest('[data-cs]'), one = e.target.closest('[data-ce]');
    if (s) { copyEntries(es.filter(x => slotOf(x) === s.dataset.cs), src); closeSheet(); }
    else if (one) { copyEntries(es.filter(x => x.id === one.dataset.ce), src); closeSheet(); }
    else if (e.target.closest('#copyAll')) { copyEntries(es, src); closeSheet(); }
  };
}
function weightsArr() { return Object.entries(S.weights).map(([date, lb]) => ({ date, lb: +lb })).sort((a, b) => a.date < b.date ? -1 : 1); }
function avgBetween(arr, from, to) {
  const v = arr.filter(w => w.date >= from && w.date <= to).map(w => w.lb);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function renderWeights() {
  const t = todayIso(), arr = weightsArr(), sc = scale(), f = $('wForm');
  safe(renderWaist); safe(renderEstBanner);     // a new weigh-in ends the estimate reminder right away
  $('wHist').hidden = arr.length < 2;            // v55: full weight history
  $('wTitle').textContent = sc === 'weekly' ? 'Weekly weigh-in' : sc === 'none' ? 'Weight' : 'Morning weigh-in';
  const noneMode = sc === 'none' && f.dataset.editing !== '1';
  $('noScale').hidden = !noneMode;
  if (noneMode) { f.hidden = true; $('wDateRow').hidden = true; $('wDone').hidden = true; $('wBody').hidden = !arr.length; if (!arr.length) return; }
  else $('wBody').hidden = false;
  const editing = f.dataset.editing === '1', last = arr[arr.length - 1];
  const loggedDate = sc === 'daily' ? (S.weights[t] != null ? t : null) : (last && daysBetween(last.date, t) <= 6 ? last.date : null);
  const logged = !!loggedDate && !editing && !noneMode;
  if (!noneMode) { f.hidden = logged; $('wDateRow').hidden = logged; $('wDone').hidden = !logged; }
  if (logged) {
    const lw = S.weights[loggedDate];
    $('wNum').textContent = fW(lw);
    $('wTag').textContent = loggedDate === t ? 'Logged today' : `Logged ${parseIso(loggedDate).toLocaleDateString(undefined, { weekday: 'long' })}`;
    const prev = [...arr].reverse().find(w => w.date < loggedDate);
    const dl = $('wDelta'); dl.className = 'wdone-delta';
    if (prev) {
      const x = lw - prev.lb, days = daysBetween(prev.date, loggedDate);
      const when = loggedDate === t ? (days === 1 ? 'yesterday' : `${days} days ago`) : (days === 1 ? 'the day before' : `${days} days earlier`);
      dl.textContent = Math.abs(x) < 0.05 ? `Same as ${when}` : `${x > 0 ? '+' : '−'}${fW(Math.abs(x))} ${wU()} vs ${when}`;
      dl.classList.add(goodness(x));
    } else dl.textContent = 'Your first weigh-in. The trend starts here.';
    const nx = $('wNext'); nx.hidden = sc !== 'weekly';
    if (sc === 'weekly') { const nd = shift(loggedDate, 7); nx.textContent = nd <= t ? 'Next weigh-in: today' : `Next weigh-in: ${shortDate(nd)}`; }
    f.dataset.date = loggedDate;
  } else if (!noneMode && document.activeElement !== $('wIn')) {
    const ed = f.dataset.date;
    $('wIn').value = editing && ed && S.weights[ed] != null ? fWs(S.weights[ed]) : '';
    $('wIn').placeholder = sc === 'daily' ? 'Weight after waking' : `Your weight in ${wU()}`;
    $('wDateBtn').textContent = sc === 'daily' ? 'Weighed on another day?' : 'Weighed on a different day?';
  }
  const a = avgBetween(arr, shift(t, -6), t), b = avgBetween(arr, shift(t, -13), shift(t, -7));
  const n7 = arr.filter(w => w.date >= shift(t, -6)).length, useLatest = sc !== 'daily' && n7 < 2 && last;
  $('avgK').textContent = useLatest ? 'Latest' : '7-day avg';
  $('avg7').textContent = useLatest ? fW(last.lb) : a ? fW(a) : '–';
  const d = $('delta'); d.className = 'v';
  if (a && b) { const x = a - b; d.textContent = (x > 0 ? '+' : x < 0 ? '−' : '') + fW(Math.abs(x)); d.classList.add(goodness(x)); } else d.textContent = '–';
  const G = S.targets.goal;
  $('goalK').textContent = mode() === 'maintain' ? (G ? `From ${fWs(G)}` : 'From goal') : G ? `To ${fWs(G)}` : 'To goal';
  const cur = a || (useLatest ? last.lb : null);
  $('toGoal').textContent = cur && G ? fW(Math.abs(cur - G)) : '–';
  const darr = arr.map(w => ({ date: w.date, lb: toW(w.lb) }));   // chart in display units
  const pts = darr.filter(w => w.date >= shift(t, -27));
  const ch = $('chart');
  if (pts.length < 2) {
    ch.innerHTML = '';
    $('wHint').textContent = pts.length ? 'One weigh-in so far. The trend line appears after your second.'
      : sc === 'daily' ? 'Weigh after the bathroom, before food or water. The weekly average is the number that matters.'
      : 'Weigh once a week, same day and time if you can. A gym or pharmacy scale works.';
    return;
  }
  $('wHint').textContent = sc === 'daily' ? 'Last 4 weeks. Dots are daily weigh-ins; the line is your 7-day average.' : 'Last 4 weeks. Dots are your weigh-ins; the line is the trend.';
  const W = 520, H = 160, L = 34, R = 12, T = 12, B = 24;
  const t0 = parseIso(shift(t, -27)).getTime(), t1 = parseIso(t).getTime();
  const lbs = pts.map(p => p.lb);
  const lo = Math.floor(Math.min(...lbs) - 1), hi = Math.ceil(Math.max(...lbs) + 1);
  const X = s => L + (parseIso(s).getTime() - t0) / (t1 - t0) * (W - L - R);
  const Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const av = pts.map(p => [X(p.date), Y(avgBetween(darr, shift(p.date, -6), p.date))]);
  const line = av.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const area = `${av[0][0].toFixed(1)},${H - B} ${line} ${av[av.length - 1][0].toFixed(1)},${H - B}`;
  const lastPt = av[av.length - 1];
  const txt = 'font-size="11" fill="var(--muted)" font-family="Barlow, system-ui, sans-serif"';
  ch.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over the last four weeks">
    <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" ${txt}>${v}</text>`).join('')}
    <text x="${L}" y="${H - 6}" ${txt}>${parseIso(shift(t, -27)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" ${txt}>Today</text>
    <polygon points="${area}" fill="url(#wg)"/>
    ${pts.map(p => `<circle cx="${X(p.date)}" cy="${Y(p.lb)}" r="3" fill="var(--muted)" opacity=".5"/>`).join('')}
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}
const MODE_HINT = {
  lose: 'Losing fat while keeping muscle. Weight going down counts as progress.',
  maintain: 'Holding your weight steady. Staying close to your goal weight counts as progress.',
  gain: 'Building muscle with a slow, lean gain. Weight going up counts as progress.',
};
function renderSettings() {
  const T = S.targets;
  if ($('goalForm').hidden) {
    $('tLo').value = T.calLo; $('tHi').value = T.calHi; $('tPro').value = T.protein; $('tGoal').value = T.goal != null ? fWs(T.goal) : '';
    $('tStart').value = S.startWeight != null ? fWs(S.startWeight) : '';
    $('tStart').placeholder = weightsArr()[0] ? `First weigh-in: ${fWs(weightsArr()[0].lb)}` : 'Your first weigh-in';
  }
  if ($('pNameForm').hidden) $('pName').value = S.name || '';
  $('pNameVal').textContent = S.name || 'Not set'; $('pNameVal').classList.toggle('muted', !S.name);
  const sw = S.startWeight ?? weightsArr()[0]?.lb;
  $('gvMode').textContent = MODES[mode()];
  $('gvCal').textContent = `${T.calLo.toLocaleString()}–${T.calHi.toLocaleString()} kcal`;
  $('gvPro').textContent = `${T.protein}g a day`;
  $('gvGoal').textContent = T.goal ? `${fWs(T.goal)} ${wU()}` : 'Not set';
  $('gvStart').textContent = sw != null ? `${fWs(sw)} ${wU()}${S.startWeight == null ? ' (first weigh-in)' : ''}` : 'Not set';
  $('goalHint').textContent = MODE_HINT[mode()]; $('goalHint').hidden = !$('goalForm').hidden;
  $('youName').textContent = S.name || 'Add your name';
  $('youName').classList.toggle('muted', !S.name);
  $('avatar').textContent = (S.name || '?').trim().charAt(0).toUpperCase() || '?';
  $('modeBadge').textContent = MODES[mode()];
  const pm = $('pMode').dataset.pending || mode();
  [...$('pMode').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.v === pm));
  $('pModeHint').textContent = MODE_HINT[pm];
  [...$('pScale').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.v === scale()));
  [...$('pUnits').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.v === (S.units || 'imperial')));
  $('pScaleHint').textContent = SCALE_HINT[scale()];
  $('foodCount').textContent = S.foods.length ? `${S.foods.length}` : '';
  renderHeader();
  const nf = S.foods.length;
  $('foodsBtn').hidden = !nf; $('foodsEmpty').hidden = !!nf;
  $('foodsSum').textContent = !nf ? '' : nf <= 2 ? S.foods.map(f => f.name).join(' and ')
    : `${S.foods.slice(0, 2).map(f => f.name).join(', ')} and ${nf - 2} more`;
}
function safe(fn) { try { fn(); } catch (e) { console.error('Cut Log render:', fn.name, e); } }
function renderAll() {
  [renderUnits, renderDay, renderTotals, renderRows, renderWeights, renderSettings, renderSync].forEach(safe);
  if (typeof tab !== 'undefined' && tab === 'trends') safe(renderTrends);
}

/* ---------- units: data is stored in lb and inches; only display and input convert ---------- */
const KG = 0.45359237;
const metric = () => S.units === 'metric';
const wU = () => metric() ? 'kg' : 'lb', lU = () => metric() ? 'cm' : 'in';
const toW = lb => metric() ? lb * KG : lb, fromW = v => metric() ? v / KG : v;
const fW = lb => toW(lb).toFixed(1);                                  // 211.6 / 96.0
const fWs = lb => String(Math.round(toW(lb) * 10) / 10);              // 198 / 89.8
const rW = lb => metric() ? Math.round(lb * 100) / 100 : r1(lb);
const toL = i => metric() ? i * 2.54 : i, fromL = v => metric() ? v / 2.54 : v;
const fL = i => metric() ? String(Math.round(i * 2.54 * 2) / 2) : String(Math.round(i * 100) / 100);
const PACE = () => metric() ? { lose: '0.5–0.7 kg', gain: '0.25 kg' } : { lose: '1–1.5 lb', gain: '0.5 lb' };
function renderUnits() {
  document.querySelectorAll('.u-w').forEach(e => { e.textContent = wU(); });
  document.querySelectorAll('.u-l').forEach(e => { e.textContent = metric() ? 'cm' : 'inches'; });
  document.querySelectorAll('.u-ls').forEach(e => { e.textContent = lU(); });
  $('zIn').step = metric() ? '0.5' : '0.25';
  $('zIn').setAttribute('aria-label', `Waist in ${metric() ? 'centimetres' : 'inches'}`);
  $('wIn').setAttribute('aria-label', `Weight in ${metric() ? 'kilograms' : 'pounds'}`);
}

/* ---------- weigh-in frequency ---------- */
const scale = () => S.scale || 'daily';
const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 864e5);
const shortDate = d => parseIso(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const SCALE_HINT = {
  daily: 'Weigh every morning after the bathroom, before food or water. This gives the most accurate trend.',
  weekly: 'Weigh once a week, same day and time if you can. A gym or pharmacy scale works. Trends take a few weeks longer to settle.',
  none: 'Track your waist with a tape measure instead. A weigh-in now and then, at a gym or pharmacy, still helps your trend.',
};

/* ---------- goal mode ---------- */
const MODES = { lose: 'Cutting', maintain: 'Maintaining', gain: 'Building' };
const mode = () => S.targets.mode || 'lose';
function goodness(change) {          // is this weight change good news for the current goal?
  const m = mode();
  if (m === 'maintain') return Math.abs(change) < 0.3 ? 'good' : 'flat';
  if (Math.abs(change) < 0.05) return 'flat';
  return (m === 'lose' ? change < 0 : change > 0) ? 'good' : 'bad';
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
}
function renderHeader() {
  const g = $('greet'); if (!g) return;
  g.textContent = S.name ? `${greeting()}, ${S.name}` : greeting();
}

/* ---------- meal slots ---------- */
const SLOTS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snacks', 'Snacks']];
function timeSlot(at) {
  const d = new Date(at || Date.now()), h = d.getHours() + d.getMinutes() / 60;
  return h < 11.5 ? 'breakfast' : h < 16 ? 'lunch' : h < 21.5 ? 'dinner' : 'snacks';
}
function slotOf(e) { return e.slot || timeSlot(e.at); }
function defaultSlot(foodId) {
  if (foodId && S.slotPref?.[foodId]) return S.slotPref[foodId];       // where you usually log this food
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (day === todayIso() && h < 14 && !entriesFor(day).some(e => slotOf(e) === 'breakfast')) return 'breakfast';  // first meal of a late morning
  return timeSlot(Date.now());
}
function slotChips(sel) { return `<div class="chips slots" id="aSlot" role="group" aria-label="Meal">${SLOTS.map(([k, l]) => `<button class="chip" data-s="${k}" aria-pressed="${k === sel}">${l}</button>`).join('')}</div>`; }

/* ---------- log actions ---------- */
function addEntry(name, kcal, pro, detail, src, slot) {
  const e = { id: uid(), name, kcal: r1(kcal), pro: r1(pro), detail: detail || '', at: Date.now(), slot: slot || defaultSlot(src?.food?.id) };
  if (src) { e.food = src.food; e.qty = src.qty; e.unit = src.unit; setFib(e, src.fib); if (src.oil) e.oil = src.oil; }
  (S.log[day] ||= []).push(e);
  touchDay(day); renderTotals(); renderRows(); haptic();
}
function removeEntry(id) {
  const el = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (el && !REDUCED && !el.classList.contains('row-out')) {
    el.style.height = el.offsetHeight + 'px'; el.getBoundingClientRect(); el.classList.add('row-out');
    haptic(); setTimeout(() => doRemoveEntry(id), 230); return;
  }
  doRemoveEntry(id);
}
function doRemoveEntry(id) {
  const list = entriesFor(day), i = list.findIndex(x => x.id === id); if (i < 0) return;
  const [gone] = list.splice(i, 1), d = day;
  if (!list.length) delete S.log[d];
  touchDay(d); renderTotals(); renderRows();
  toast(`Removed ${gone.name}`, { label: 'Undo', fn: () => { (S.log[d] ||= []).splice(i, 0, gone); touchDay(d); renderTotals(); renderRows(); } });
}
const NOT_SAVED = ['built-in', 'meal', 'entry', 'cooked'];
/* v50: Recent, meal ingredients and logged entries keep a copy of a food from when it was used. If you've fixed the saved
   food since (fibre, Edit numbers), new logs use the saved one, and an old copy never overwrites it. */
const freshFood = f => {
  if (f?.cookOf) { const p = S.foods.find(x => x.id === f.cookOf); return (p && cookedOf(p)) || f; }   // v61: rebuilt from the saved package
  return (f && !NOT_SAVED.includes(f.source) && S.foods.find(x => x.id === f.id)) || f;
};
function rememberFood(f) {
  if (!NOT_SAVED.includes(f.source)) {
    const i = S.foods.findIndex(x => x.id === f.id);
    if (i >= 0) S.foods[i] = f; else S.foods.unshift(f);
  }
}
function pushRecent(f, qty, unit) {
  if (NOT_SAVED.includes(f.source) && f.source !== 'built-in' && f.source !== 'cooked') return;
  f = freshFood(f);
  S.recent = [{ food: f, qty, unit }, ...S.recent.filter(r => r.food.id !== f.id)].slice(0, 12);
}

/* ---------- toast ---------- */
let toastTimer, toastNext = null;
function hideToast() { const t = $('toast'); t.classList.remove('in'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; if (toastNext) { const [m, a] = toastNext; toastNext = null; setTimeout(() => toast(m, a), 120); } }, 260); }
/* opts.wait (v53): if a message with a button (like Undo) is still up, show this one right after it instead of covering it */
function toast(msg, action, opts) {
  const t = $('toast');
  if (opts?.wait && !t.hidden && t.querySelector('.toast-act')) { toastNext = [msg, action]; return; }
  toastNext = null; clearTimeout(toastTimer); t.textContent = ''; t.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('in')));
  const m = document.createElement('span'); m.className = 'toast-msg'; m.textContent = msg; t.appendChild(m);
  if (action) {
    const b = document.createElement('button'); b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { hideToast(); haptic(); action.fn(); };
    t.appendChild(b);
  }
  toastTimer = setTimeout(hideToast, action ? 5000 : 2600);
}
/* When building a meal, food flows hand their result back here instead of logging it */
let pick = null, draft = null;

/* ---------- sheet (draggable, with resting points like iOS) ---------- */
const sheetEl = $('sheet'), scrimEl = $('scrim'), sheetBody = $('sheetBody');
const SH = { y: 0, open: false, hideTimer: null, drag: null };
let onSheetClose = null;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
function sheetH() { return sheetEl.offsetHeight || 1; }
function detents() { return [0, sheetH()]; }   // open where it opens, or closed
const WIDE_Q = matchMedia('(min-width: 980px)');
function setY(y, animate) {
  SH.y = y;
  if (WIDE_Q.matches) {                        // laptop: a centered window that fades and lifts in
    const p = Math.max(0, Math.min(1, 1 - y / sheetH()));
    const tr = animate ? `transform .3s ${EASE}, opacity .22s` : 'none';
    sheetEl.style.transition = tr;
    sheetEl.style.transform = `translate(-50%, calc(-50% + ${(1 - p) * 24}px)) scale(${0.96 + 0.04 * p})`;
    sheetEl.style.opacity = p;
    scrimEl.style.transition = animate ? 'opacity .3s' : 'none'; scrimEl.style.opacity = p;
    $('app').style.transform = '';
    return;
  }
  sheetEl.style.opacity = '';
  const tr = animate ? `transform .36s ${EASE}` : 'none';
  sheetEl.style.transition = tr; sheetEl.style.transform = `translateY(${y}px)`;
  const p = Math.max(0, Math.min(1, 1 - y / sheetH()));
  scrimEl.style.transition = animate ? 'opacity .36s' : 'none'; scrimEl.style.opacity = p;
  const app = $('app');
  app.style.transition = animate ? tr : 'none';
  app.style.transformOrigin = `50% ${$('scroller').scrollTop + innerHeight / 2}px`;
  app.style.transform = p > 0.001 ? `scale(${1 - 0.04 * p})` : '';
}
function openSheet(title, html, cleanup) {
  if (onSheetClose) { try { onSheetClose(); } catch (e) {} }
  clearTimeout(SH.hideTimer);
  const swapping = SH.open;
  const h0 = swapping ? sheetEl.getBoundingClientRect().height : 0;   // v54: measured before the typing lock below is cleared
  sheetBody.onclick = null; sheetEl.style.minHeight = '';
  $('sheetTitle').textContent = title;
  sheetBody.innerHTML = html;
  if (swapping) { replay(sheetBody, 'swap-in'); replay($('sheetTitle'), 'swap-in'); glideSheet(h0); }
  sheetBody.scrollTop = 0;
  onSheetClose = cleanup || null;
  sheetEl.style.pointerEvents = ''; scrimEl.style.pointerEvents = '';
  if (!SH.open) {
    SH.open = true;
    sheetEl.hidden = false; scrimEl.hidden = false;
    $('scroller').style.overflowY = 'hidden';
    setY(sheetH(), false);
    sheetEl.getBoundingClientRect();          // commit the start position before animating in
    requestAnimationFrame(() => setY(0, true));
  } else if (SH.y !== 0) setY(0, true);
}
/* v54: when one screen in the panel replaces another, the panel glides to its new height instead of jumping */
function glideSheet(h0) {
  if (REDUCED || !h0 || typeof sheetEl.animate !== 'function') return;
  if (sheetEl._glide) sheetEl._glide.cancel();
  const h1 = sheetEl.getBoundingClientRect().height; if (Math.abs(h1 - h0) < 6) return;
  sheetEl.style.overflow = 'hidden';
  const a = sheetEl._glide = sheetEl.animate({ height: [h0 + 'px', h1 + 'px'] }, { duration: 320, easing: EASE_OUT });
  a.onfinish = a.oncancel = () => { if (sheetEl._glide === a) { sheetEl._glide = null; sheetEl.style.overflow = ''; } };
}
function closeSheet() {
  if (draft) markDraft('open', false);   // left the meal on purpose: keep it in My meals, don't pop it up next launch
  const unsaved = draft && draft.touched && loadDraft() ? draft : null;   // v53: closed without Save meal
  pick = null; draft = null;
  if (onSheetClose) { try { onSheetClose(); } catch (e) {} onSheetClose = null; }
  if (!SH.open) return;
  SH.open = false; SH.drag = null;
  safe(renderTotals);   // v50: changes made in a panel (fixing a food, saving a meal) show on Today right away
  sheetEl.style.pointerEvents = 'none'; scrimEl.style.pointerEvents = 'none';
  setY(sheetH(), true);
  if (unsaved) toast(unsaved.id ? 'Meal changes not saved yet' : 'New meal not saved yet',
    { label: 'Save', fn: () => { if (saveMealFrom(unsaved)) toast('Meal saved'); } }, { wait: true });
  clearTimeout(SH.hideTimer);
  SH.hideTimer = setTimeout(() => {
    sheetEl.hidden = true; scrimEl.hidden = true;
    sheetEl.style.pointerEvents = ''; scrimEl.style.pointerEvents = '';
    $('scroller').style.overflowY = ''; $('app').style.transform = ''; sheetEl.style.minHeight = '';
  }, 360);
}
/* While typing a search, the panel may grow but never shrink. Fewer results would otherwise
   pull it down behind the iPhone keyboard, hiding the search box. */
function holdSheetHeight() {
  if (!SH.open) return;
  const h = Math.max(sheetEl.offsetHeight, parseFloat(sheetEl.style.minHeight) || 0);
  if (h > 0) sheetEl.style.minHeight = h + 'px';
}
$('sheetClose').onclick = closeSheet;
scrimEl.onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && SH.open) closeSheet(); });

/* finger tracking */
function dragStart(y, t, target) {
  if (!SH.open || WIDE_Q.matches) return;
  if (target && target.closest && target.closest('.wh-chart')) return;   // v55: dragging along the weight chart reads it, it doesn't move the panel
  SH.drag = { y0: y, startY: SH.y, mode: null, inBody: sheetBody.contains(target), samples: [[y, t]] };
}
function dragMove(y, t, e) {
  const d = SH.drag; if (!d) return;
  if (!d.mode) {
    const dy = y - d.y0;
    if (Math.abs(dy) < 6) return;
    const atTop = sheetBody.scrollTop <= 0;
    d.mode = !d.inBody || (dy > 0 && atTop) ? 'drag' : 'scroll';
    d.y0 = y;
  }
  if (d.mode !== 'drag') return;
  if (e.cancelable) e.preventDefault();
  let ny = d.startY + (y - d.y0);
  if (ny < 0) ny = -Math.pow(-ny, 0.7);      // rubber band above the top
  setY(ny, false);
  d.samples.push([y, t]); if (d.samples.length > 5) d.samples.shift();
}
function dragEnd() {
  const d = SH.drag; SH.drag = null;
  if (!d || d.mode !== 'drag') return;
  const b = d.samples[d.samples.length - 1], a = d.samples.find(s => b[1] - s[1] <= 80) || d.samples[0];
  const v = b[1] > a[1] ? (b[0] - a[0]) / (b[1] - a[1]) : 0;   // px per ms, + is down
  const ds = detents(), closed = ds[ds.length - 1];
  const moved = SH.y - d.startY;
  let target;
  // close on a downward flick or when pulled past a third of the way; otherwise spring back
  if (v > 1 || (moved > sheetH() / 3 && v > -0.2)) target = closed;
  else target = 0;
  if (target >= closed - 1) closeSheet(); else setY(target, true);
}
sheetEl.addEventListener('touchstart', e => dragStart(e.touches[0].clientY, e.timeStamp, e.target), { passive: true });
sheetEl.addEventListener('touchmove', e => dragMove(e.touches[0].clientY, e.timeStamp, e), { passive: false });
sheetEl.addEventListener('touchend', dragEnd);
sheetEl.addEventListener('touchcancel', dragEnd);
/* mouse: drag by the handle or title bar on a laptop */
sheetEl.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || !e.target.closest('.grab, .sheet-head') || e.target.closest('button')) return;
  dragStart(e.clientY, e.timeStamp, e.target);
  const mv = ev => dragMove(ev.clientY, ev.timeStamp, ev);
  const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); dragEnd(); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
});
addEventListener('resize', () => { if (SH.open && !SH.drag) setY(0, false); });

/* ---------- amount step (shared by every flow) ---------- */
function openAmount(f, preset, opts = {}) {
  if (!opts.editId) f = freshFood(f);
  if (!opts.editId && !opts.asIs && !pick && lastCooked(f.id) && pkgPair(f)) {        // v61: you logged it cooked last time
    f = cookedOf(f);
    if (preset?.unit && !unitsFor(f).some(u => u.key === preset.unit)) preset = { ...preset, qty: 100, unit: 'g' };
  }
  const units = unitsFor(f);
  if (!units.length) { toast('This food has no calorie data. Try the label photo instead.'); return; }
  let unit = preset?.unit && units.some(u => u.key === preset.unit) ? preset.unit
    : (units.find(u => u.key === 'piece') || units.find(u => u.key === 'serving') || units[0]).key;
  const startQty = preset?.qty ?? (unit === 'g' ? 100 : 1);
  const dayName = $('dayLabel').textContent;
  const editing = opts.editId, picking = pick;
  const editEntry = editing ? entriesFor(day).find(x => x.id === editing) : null;
  let slot = editEntry ? slotOf(editEntry) : defaultSlot(f.id);
  const cta = picking ? picking.label : editing ? 'Save changes' : `Add to ${dayName === 'Today' ? 'today' : dayName}`;
  const base = baseOf(f), twin = twinOf(f);
  const canOil = !picking && !!(base.cook || pkgPair(f)?.raw.cook);          // whole foods you cook yourself; dishes already include their oil, meals add it as an ingredient
  let oil = canOil ? oilKey(preset?.oil) : null;
  if (opts.slot) slot = opts.slot;
  openSheet(editing ? 'Edit entry' : 'How much?', `
    <div class="food-head" id="aFood" data-id="${esc(f.id)}"><strong>${esc(f.name)}</strong><span>${esc([f.brand, perLine(f)].filter(Boolean).join(' · '))}</span><span class="ns-row" id="aNs">${nsBadge(f, true)}</span></div>
    ${twin ? `<div class="seg2 st" id="aState" role="group" aria-label="Weighed raw or cooked">${[base, twin].sort((a, b) => stateOf(a) === 'cooked' ? 1 : stateOf(b) === 'cooked' ? -1 : 0).map(x => `<button type="button" data-st="${esc(x.name)}" aria-pressed="${x.name === base.name}">${stateOf(x) === 'dry' ? 'Dry weight' : stateOf(x) === 'raw' ? 'Raw weight' : 'Cooked'}</button>`).join('')}</div>
    <p class="st-hint">Pick how it was when you measured it. Cooking changes the weight, so the numbers differ.${f.cookOf || pkgPair(f) ? ' Cooked is worked out from the package.' : ''}</p>` : ''}
    <div class="stepper">
      <button id="aMinus" aria-label="Less">−</button>
      <input id="aQty" type="number" inputmode="decimal" step="any" min="0" value="${startQty}" aria-label="Amount">
      <button id="aPlus" aria-label="More">+</button>
    </div>
    <div class="chips" id="aUnits" role="group" aria-label="Unit">${units.map(u => `<button class="chip" data-u="${u.key}" aria-pressed="${u.key === unit}" title="${esc(u.long || u.label)}">${esc(u.key === 'serving' && f.servingLabel ? 'serving · ' + servLabel(f) : u.label)}</button>`).join('')}</div>
    <div class="result"><div><span class="num" id="aK">0</span><small>kcal</small></div><div class="pro"><span class="num" id="aP">0g</span><small>protein</small></div></div>
    <p class="fib-line" id="aF" hidden></p>
    ${canOil ? `<div class="oil"><span class="oil-k">Cooked with oil or butter?</span><div class="chips" id="aOil" role="group" aria-label="Cooking oil">${Object.entries(OIL).map(([k, o]) => `<button class="chip" data-oil="${k}" aria-pressed="${k === (oil || 'none')}">${o.t}${o.k ? ` <small>+${o.k}</small>` : ''}</button>`).join('')}</div></div>` : ''}
    ${picking ? '' : slotChips(slot)}
    ${f.est ? '<p class="hint">Recipes and portions vary a lot, especially with oil. This is a typical estimate; tap "Numbers look wrong?" to set your own.</p>' : ''}
    ${f.kcal100 != null ? `<details class="hand" id="aHand"><summary>No scale? Estimate with your hand</summary>
      <div class="hand-rows">
        <div><b>Palm</b><span>About 100 g. Chicken, fish, meat, tofu. Size and thickness of your palm, no fingers.</span></div>
        <div><b>Fist</b><span>About 1 cup. Rice, pasta, swallow, yam, potatoes, cereal.</span></div>
        <div><b>Cupped hand</b><span>About ½ cup. Beans, nuts, chips, fruit, snacks.</span></div>
        <div><b>Thumb</b><span>About 1 tablespoon. Oil, butter, peanut butter. Use the tbsp unit.</span></div>
        <p class="hint">Use your own hand. It scales with your body, which keeps your portions consistent.</p>
      </div></details>` : ''}
    ${/^(plate|bowl)$/.test(f.pieceLabel || '') && f.piece ? `<details class="hand" id="aPlate"><summary>Which ${f.pieceLabel} size?</summary>
      <div class="plates">${['s', 'm', 'l'].map((k, i) => `<div><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${[18, 25, 30][i]}" class="pl"/><ellipse cx="32" cy="${33 - i}" rx="${[9, 15, 21][i]}" ry="${[5, 8, 12][i]}" class="fd"/></svg><b>${['Small', 'Regular', 'Large'][i]}</b><span>${PLATE_HINT[f.pieceLabel][k]}</span></div>`).join('')}</div>
      <p class="hint">Regular is about ${Math.round(f.piece)} g. Small is about 60% of that, large about 1½ times.</p></details>` : ''}
    <p class="hint" id="aNote" hidden>Spoon sizes are approximate: about 15 g per tablespoon and 5 g per teaspoon. A heaping spoon is closer to 25 g.</p>
    <button class="btn" id="aAdd">${esc(cta)}</button>
    ${NOT_SAVED.includes(f.source) ? '' : '<button class="btn ghost" id="aFix">Numbers look wrong? Fix them</button>'}
    ${editing ? '<button class="btn ghost" id="aMove">Move to another day</button><button class="btn danger" id="aDel">Remove from log</button>' : ''}`);
  const upd = () => {
    const v = calc(f, parseFloat($('aQty').value), unit);
    if (oil && v.kcal > 0) v.kcal += OIL[oil].k;
    animateNum($('aK'), v.kcal, undefined, 220); animateNum($('aP'), v.pro, fmtP, 220);
    let fibTxt = v.fib != null && v.fib >= 0.05 ? `${fmtG(v.fib)}g fibre` : null;   // v62: no "0g fibre" on eggs, meat and fish
    if (v.fib == null && v.kcal > 0) {      // v50: a meal with some ingredients missing fibre data
      const pf = mealPartFood(mealOf(f)), pv = pf && calc(pf, parseFloat($('aQty').value), unit);
      if (pv?.fib != null && Math.abs(pv.kcal - v.kcal) <= Math.max(3, pv.kcal * 0.03)) fibTxt = `at least ${fmtG(pv.fib)}g fibre (not every ingredient has fibre data)`;
    }
    $('aF').hidden = !fibTxt || !(v.kcal > 0); if (fibTxt) $('aF').textContent = fibTxt;
    $('aNote').hidden = !['tbsp', 'tsp'].includes(unit);
    if (HAND.includes(unit) && $('aHand') && !$('aHand').dataset.seen) {   // teaches the first couple of times, then stays tucked away
      $('aHand').dataset.seen = '1';
      let n = 0; try { n = +localStorage.getItem('cutlog.handGuide') || 0; localStorage.setItem('cutlog.handGuide', n + 1); } catch (e) {}
      if (n < 2) $('aHand').open = true;
    }
  };
  const bump = dir => { const q = parseFloat($('aQty').value) || 0; $('aQty').value = fmtQty(Math.max(0, q + dir * stepFor(unit))); upd(); };
  $('aMinus').onclick = () => bump(-1); $('aPlus').onclick = () => bump(1);
  $('aQty').oninput = upd;
  $('aUnits').onclick = e => {
    const b = e.target.closest('[data-u]'); if (!b) return;
    unit = b.dataset.u; haptic();
    [...$('aUnits').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.u === unit));
    if (unit === 'g' && parseFloat($('aQty').value) < 10) $('aQty').value = 100;
    if (unit !== 'g' && parseFloat($('aQty').value) >= 10) $('aQty').value = 1;
    upd();
  };
  upd(); enrichFood(f); recheckServing(f, editing);
  if ($('aState')) $('aState').onclick = e => {
    const b = e.target.closest('[data-st]'); if (!b || b.dataset.st === base.name) return;
    const to = [base, twin].find(x => x.name === b.dataset.st); if (!to) return;
    haptic();
    let q = parseFloat($('aQty').value) || 0, u = unit;
    if (!unitsFor(to).some(x => x.key === u)) { const g = unitsFor(f).find(x => x.key === u)?.g; q = g ? Math.round(q * g) : 100; u = 'g'; }   // same amount, in grams
    openAmount(to, { qty: q, unit: u, oil }, { ...opts, slot, asIs: true });
  };
  if ($('aOil')) $('aOil').onclick = e => {
    const b = e.target.closest('[data-oil]'); if (!b) return;
    oil = oilKey(b.dataset.oil); haptic();
    [...$('aOil').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.oil === (oil || 'none')));
    upd();
  };
  const fade = () => { const c = $('aUnits'); if (c) c.classList.toggle('more', c.scrollLeft + c.clientWidth < c.scrollWidth - 4); };
  $('aUnits').addEventListener('scroll', fade, { passive: true }); requestAnimationFrame(fade); setTimeout(fade, 400);
  requestAnimationFrame(() => {      // v61: the chosen unit is always in view (5 tbsp hiding off the edge read as 5 servings)
    const c = $('aUnits'), b = c?.querySelector('[aria-pressed="true"]'); if (!b) return;
    const cr = c.getBoundingClientRect(), br = b.getBoundingClientRect();
    if (br.right > cr.right - 24 || br.left < cr.left) { c.scrollLeft += br.left - cr.left - 16; fade(); }
  });
  if ($('aSlot')) $('aSlot').onclick = e => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    slot = b.dataset.s; haptic();
    [...$('aSlot').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.s === slot));
  };
  if ($('aDel')) $('aDel').onclick = () => { closeSheet(); removeEntry(editing); };
  if ($('aMove')) $('aMove').onclick = () => openMoveDay(editing);
  if ($('aFix')) $('aFix').onclick = () => {
    const g = f.servingG || null, was = { preset: { qty: parseFloat($('aQty').value) || 1, unit, oil }, opts: { ...opts, slot } };   // v50: come back to the same amount
    const per = f.kcalServ != null ? { kcal: f.kcalServ, pro: f.proServ }
      : g ? { kcal: f.kcal100 * g / 100, pro: (f.pro100 || 0) * g / 100 } : { kcal: f.kcal100, pro: f.pro100 };
    openSheet('Fix the numbers', `<p class="hint">Enter what the label says for one serving. The app will use your numbers for this food from now on.</p><div id="labelOut"></div>`);
    labelForm($('labelOut'), { kcal: Math.round(per.kcal), pro: r1(per.pro || 0), fib: fibPerServ(f, g), servingG: g || (f.kcalServ == null ? 100 : null) }, '', f.barcode || null, f.name, f.id, was);
  };
  $('aAdd').onclick = () => {
    const q = parseFloat($('aQty').value);
    if (!(q > 0)) { toast('Enter how much you had.'); return; }
    const v = calc(f, q, unit), oilD = oil ? ` · ${OIL[oil].d}` : '', detail = `${fmtQty(q)} ${unitWord(f, unit, q)}${oilD}`;
    if (oil) v.kcal += OIL[oil].k;
    if (!(editing && S.foods.some(x => x.id === f.id && x !== f))) rememberFood(f);   // an entry's old copy never overwrites the saved food
    if (f.cookOf && !S.foods.some(x => x.id === f.cookOf) && PKG_SEEN.has(f.cookOf)) rememberFood(PKG_SEEN.get(f.cookOf));   // v63: a new pack logged as Cooked is saved too
    pushRecent(f, q, unit); touchMeta(); renderSettings();
    if (picking) { pick = null; picking.onDone(f, q, unit, v); return; }
    if (editing) {
      const moved = editEntry && slotOf(editEntry) !== slot;
      if (editEntry) { Object.assign(editEntry, { kcal: r1(v.kcal), pro: r1(v.pro), detail, food: f, qty: q, unit, slot }); setFib(editEntry, v.fib); if (oil) editEntry.oil = oil; else delete editEntry.oil; }
      if (moved) { S.slotPref[f.id] = slot; touchMeta(); }      // moving a food teaches the app where it usually goes
      touchDay(day); renderTotals(); renderRows(); closeSheet();
      toast(moved ? `Moved to ${SLOTS.find(s => s[0] === slot)[1]}. It'll go there next time too.` : 'Entry updated'); return;
    }
    S.slotPref[f.id] = slot;
    // logging the same thing again in the same meal adds to the existing line
    const same = entriesFor(day).find(x => x.food && x.food.id === f.id && x.unit === unit && slotOf(x) === slot && (x.oil || null) === oil);   // a different oil choice gets its own line
    if (same) {
      const prev = { kcal: same.kcal, pro: same.pro, qty: same.qty, detail: same.detail }, prevFib = same.fib;
      const had = entryFib(same);
      same.qty = r1(same.qty + q); same.kcal = r1(same.kcal + v.kcal); same.pro = r1(same.pro + v.pro);
      setFib(same, had != null && v.fib != null ? had + v.fib : null);   // only known when both parts are known
      same.detail = `${fmtQty(same.qty)} ${unitWord(f, unit, same.qty)}${oilD}`;
      touchDay(day); renderTotals(); renderRows(); haptic(); closeSheet();
      replay(document.querySelector(`.row[data-id="${CSS.escape(same.id)}"]`), 'row-bump');
      toast(`Now ${same.detail} · ${Math.round(same.kcal)} kcal`, { label: 'Undo', fn: () => { Object.assign(same, prev); setFib(same, prevFib); touchDay(day); renderTotals(); renderRows(); } });
      return;
    }
    addEntry(f.name, v.kcal, v.pro, detail, { food: f, qty: q, unit, fib: v.fib, oil }, slot);
    closeSheet(); toast(`Added ${Math.round(v.kcal)} kcal · ${fmtG(v.pro)}g protein`);
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
  offExtras(f, p);
  fixServingSwap(f, n, sq);
  if (f.kcal100 > 900) {          // impossible (pure oil is about 884): a label rounded up on a tiny serving, e.g. 5 kcal on 0.5 g = 1,000
    if (sq > 0 && f.kcalServ == null) { f.kcalServ = f.kcal100 * sq / 100; f.proServ = (f.pro100 || 0) * sq / 100; }
    f.kcal100 = MAX_KCAL100;
  }
  return (f.kcal100 != null || f.kcalServ != null) ? f : null;
}
/* v60: Open Food Facts sometimes has a label's per-serving numbers typed into its "per 100 g" fields. Kan's Chosen Foods
   avocado oil spray (0815074022915) says 5 kcal and 0.5 g fat "per 100 g" with a 0.5 g serving, so one serving came out
   as 0.025 kcal and showed 0. Either of two signs is enough:
   1. The packaging's own per-serving calories don't match the per-100 g number scaled to the serving (beyond rounding).
   2. No usable per-serving calories, but the "per 100 g" fat + carbs + protein weigh about one serving (as copied from the
      label), the serving is small (30 g or less), and read per 100 g they'd come to under 1 kcal a serving.
   Then the label's serving numbers are used for "serving", and per 100 g is worked out from them, held to the most a food
   can have (pure oil, about 884 kcal per 100 g), because labels round tiny servings up (5 kcal on 0.5 g would be 1,000). */
const MAX_KCAL100 = 884;
const offNum = v => v == null || v === '' || !isFinite(+v) ? null : +v;
function fixServingSwap(f, n, sq) {
  if (!(sq > 0) || f.kcal100 == null) return false;
  const scaled = f.kcal100 * sq / 100;
  let ks = offNum(n['energy-kcal_serving']);
  if (ks == null && offNum(n['energy_serving']) != null) ks = n['energy_serving'] / 4.184;
  let kS, pS, fS;
  if (ks != null && ks >= 1 && Math.abs(ks - scaled) > Math.max(2, ks * 0.5)) {
    kS = ks; pS = offNum(n['proteins_serving']) ?? 0; fS = offNum(n['fiber_serving']);
  } else {
    const mass = ['fat_100g', 'carbohydrates_100g', 'proteins_100g'].reduce((s, k) => s + (offNum(n[k]) || 0), 0);
    if (!(sq <= 30 && f.kcal100 >= 1 && scaled < 1 && mass > 0 && Math.abs(mass - sq) <= sq * 0.25)) return false;
    kS = f.kcal100; pS = f.pro100 || 0; fS = offNum(n['fiber_100g']);
  }
  f.kcalServ = kS; f.proServ = pS;
  f.kcal100 = Math.min(kS / sq * 100, MAX_KCAL100); f.pro100 = Math.min(pS / sq * 100, 100);
  delete f.fib100; delete f.fibServ;
  if (fS != null && fS >= 0) { f.fibServ = fS; f.fib100 = Math.min(fS / sq * 100, 100); }
  return true;
}
/* fibre and Nutri-Score, when Open Food Facts has them */
function offExtras(f, p) {
  const n = p.nutriments || {};
  if (n['fiber_100g'] != null && n['fiber_100g'] !== '' && +n['fiber_100g'] >= 0) f.fib100 = +n['fiber_100g'];
  else if (f.kcalServ != null && n['fiber_serving'] != null && n['fiber_serving'] !== '' && +n['fiber_serving'] >= 0) f.fibServ = +n['fiber_serving'];
  if (nsOk(p.nutriscore_grade)) f.nutri = p.nutriscore_grade;
  return f;
}
const OFF_FIELDS = 'product_name,product_name_en,product_name_fr,brands,nutriments,serving_quantity,serving_size,nutriscore_grade';
/* Foods scanned before v41 have no fibre or grade. The first time one is opened, ask Open Food Facts once and add only
   those two things; calories and protein are never touched (they may have been fixed by hand). */
const enrichTried = new Set();
async function enrichFood(f) {
  if (!f?.barcode || f.source !== 'scan' || f.nutri !== undefined || hasFib(f) || enrichTried.has(f.id) || !navigator.onLine) return;
  enrichTried.add(f.id);
  try {
    const res = await fetch(`${OFF}/api/v2/product/${f.barcode}.json?fields=nutriments,nutriscore_grade`);
    if (!res.ok) return;
    const j = await res.json(); if (j.status !== 1 || !j.product) return;
    const add = offExtras({ kcalServ: f.kcalServ }, j.product);
    const saved = S.foods.find(x => x.id === f.id);
    [f, saved].forEach(t => { if (!t) return; t.nutri = add.nutri || ''; if (add.fib100 != null) t.fib100 = add.fib100; else if (add.fibServ != null && t.kcalServ != null) t.fibServ = add.fibServ; });
    touchMeta(); renderTotals();
    if (SH.open && $('sheetTitle').textContent === 'How much?' && $('aFood')?.dataset.id === f.id) { $('aNs').innerHTML = nsBadge(f, true); $('aQty').dispatchEvent(new Event('input')); }
  } catch (e) { /* offline or blocked: try again next visit */ }
}
/* v60: a food scanned before the fix above may still hold the swapped numbers (0 kcal a serving). The first time it's opened,
   ask Open Food Facts once; if the corrected reading has per-serving numbers, update the saved food. Foods fixed by hand
   (source 'label') are never touched, and entries already logged keep the numbers they were logged with. */
const servTried = new Set();
const looksSwapped = f => !!f?.barcode && f.source === 'scan' && f.kcalServ == null && f.servingG > 0 && f.servingG <= 30 && f.kcal100 >= 1 && f.kcal100 * f.servingG / 100 < 1;
async function recheckServing(f, editing) {
  if (!looksSwapped(f) || servTried.has(f.id) || !navigator.onLine) return;
  servTried.add(f.id);
  try {
    const res = await fetch(`${OFF}/api/v2/product/${f.barcode}.json?fields=${OFF_FIELDS}`);
    if (!res.ok) return;
    const j = await res.json(); if (j.status !== 1 || !j.product) return;
    const g = offToFood(j.product, f.barcode); if (!g || g.kcalServ == null) return;
    const saved = S.foods.find(x => x.id === f.id);
    (editing ? [saved] : [...new Set([f, saved])]).forEach(t => {
      if (!t || t.source !== 'scan') return;
      ['kcal100', 'pro100', 'kcalServ', 'proServ'].forEach(k => { t[k] = g[k]; });
      delete t.fib100; delete t.fibServ;
      if (g.fib100 != null) t.fib100 = g.fib100;
      if (g.fibServ != null) t.fibServ = g.fibServ;
    });
    touchMeta(); renderTotals();
    if (!editing && SH.open && $('sheetTitle').textContent === 'How much?' && $('aFood')?.dataset.id === f.id) {
      $('aFood').children[1].textContent = [f.brand, perLine(f)].filter(Boolean).join(' · ');
      $('aQty').dispatchEvent(new Event('input'));
    }
    toast(`Fixed: ${Math.round(g.kcalServ)} kcal per serving`);
  } catch (e) { /* offline or blocked: try again next time the app starts */ }
}
async function lookupBarcode(code) {
  code = String(code).replace(/\D/g, '');
  const saved = S.foods.find(f => f.barcode && (f.barcode === code || f.barcode === '0' + code || '0' + f.barcode === code));
  if (saved) return { food: saved };
  const tries = code.length === 12 ? [code, '0' + code] : [code];
  for (const c of tries) {
    try {
      const res = await fetch(`${OFF}/api/v2/product/${c}.json?fields=${OFF_FIELDS}`);
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
  const vw = document.querySelector('.video-wrap');
  scan.stop = true;                               // no more reads while the flash plays
  if (vw) { vw.classList.add('hit'); haptic(); await new Promise(r => setTimeout(r, 220)); }
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
  if (scan.stop || !scan.stream) return;          // closed while the camera was starting
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
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0, c.width, c.height); try { bmp.close(); } catch (e) {}
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
  let kcal = null, pro = null, fib = null, servingG = null, servingText = '';
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
    if (fib == null && /fib(re|er)/.test(low) && !/soluble|insoluble/.test(low)) {        // "Fibre / Fibres 4 g", "Dietary Fiber 3g"
      const after = low.slice(low.search(/fib(re|er)/));
      const m = after.match(/(\d{1,2}(?:[.,]\d)?)\s*g/);
      if (m) fib = num(m[1]);
    }
    if (servingG == null && /(per|pour|serving|portion|size)/.test(low)) {
      const m = low.match(/\(?\s*(\d{1,4}(?:[.,]\d)?)\s*(g|ml|mℓ)\b/);
      if (m) { servingG = num(m[1]); servingText = l.replace(/\s+/g, ' ').slice(0, 60); }
    }
  }
  if (servingG == null) { const m = text.match(/\(\s*(\d{1,4})\s*(g|ml)\s*\)/i); if (m) { servingG = num(m[1]); servingText = m[0]; } }
  return { kcal, pro, fib, servingG, servingText };
}
function openLabel(barcode) {
  if (pick && draft && barcode) { draft.pendingCode = barcode; draft.touched = true; saveDraft(draft); }   // remembered in case iOS restarts the app during the photo
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
function labelForm(out, p, text, barcode, name, keepId, then) {
  out.insertAdjacentHTML('beforeend', `
    ${text ? '<p class="hint">Check these against the label and fix anything that looks off.</p>' : ''}
    <label>Food name<input id="lName" value="${esc(name || '')}" placeholder="e.g. Greek yogurt 0%"></label>
    <div class="grid2">
      <label>Calories per serving<input id="lK" type="number" inputmode="decimal" value="${p.kcal ?? ''}"></label>
      <label>Protein per serving (g)<input id="lP" type="number" inputmode="decimal" value="${p.pro ?? ''}"></label>
    </div>
    <label>Fibre per serving (g, optional)<input id="lF" type="number" inputmode="decimal" min="0" value="${p.fib ?? ''}" placeholder="Leave blank if the label doesn't say"></label>
    <label>Serving size (g or ml)<input id="lG" type="number" inputmode="decimal" value="${p.servingG ?? ''}" placeholder="Optional, e.g. 175"></label>
    <p class="field-note">The number in brackets on the label. Adding it lets you log by spoon or gram.</p>
    <button class="btn" id="lSave">Next: how much did you have?</button>
    ${text ? `<details><summary>What the reader saw</summary><div class="ocr">${esc(text)}</div></details>` : ''}`);
  $('lSave').onclick = () => {
    const nm = $('lName').value.trim(), k = parseFloat($('lK').value), pr = parseFloat($('lP').value) || 0, g = parseFloat($('lG').value), fb = parseFloat($('lF').value);
    if (!nm) { toast('Give the food a name.'); return; }
    if (!(k >= 0)) { toast('Enter the calories per serving.'); return; }
    const f = { id: keepId || (barcode ? 'p' + barcode : 'c' + uid()), name: nm, source: 'label', kcalServ: k, proServ: pr };
    if (barcode) f.barcode = barcode;
    if (fb >= 0 && fb < 100) f.fibServ = fb;
    if (g > 0) { f.servingG = g; f.servingLabel = g + ' g'; f.kcal100 = k / g * 100; f.pro100 = pr / g * 100; if (f.fibServ != null) f.fib100 = fb / g * 100; }
    const old = keepId && S.foods.find(x => x.id === keepId); if (old && nsOk(old.nutri)) f.nutri = old.nutri;   // keep the grade when fixing numbers
    rememberFood(f); touchMeta(); renderSettings();
    const back = then && unitsFor(f).some(u => u.key === then.preset.unit) ? then.preset : { qty: 1, unit: 'serving' };
    openAmount(f, back, then?.opts || {});
  };
}

/* ---------- search ---------- */
function listHtml(items) {
  return items.map((it, i) => `<button class="item" data-i="${i}"><span class="nm">${esc(it.f.name)}${it.f.brand ? `<small>${esc(it.f.brand)}</small>` : ''}</span>
    ${nsBadge(it.f)}<span class="meta">${esc(it.meta || (it.f.kcal100 != null ? Math.round(it.f.kcal100) + ' kcal/100g' : Math.round(it.f.kcalServ) + ' kcal/serv'))}</span></button>`).join('');
}
function openSearch() {
  openSheet(pick ? 'Add an ingredient' : 'Search foods', `
    ${pick ? '<button class="btn ghost" id="pickScan">Scan a barcode instead</button>' : ''}
    <input id="q" type="search" placeholder="Sweet potato, eggs, yogurt…" aria-label="Search foods" autocomplete="off">
    <div class="list" id="results"></div>
    <button class="btn ghost" id="online" hidden>Search packaged foods online</button>
    <button class="btn ghost" id="custom">Enter a food by hand</button>
    ${pick ? '' : '<button class="btn ghost" id="quick">Quick add: just calories and protein</button>'}`);
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
      const match = f => words.every(w => (f.name + ' ' + (f.brand || '') + ' ' + (f.alias || '')).toLowerCase().includes(w));
      // best matches first: name starts with it, then a word starts with it, then anywhere. Saved foods lead within each group.
      const rank = f => { const n = f.name.toLowerCase(); return n.startsWith(q) ? 0 : n.split(/[^a-z0-9%]+/).some(w => w.startsWith(words[0])) ? 1 : n.includes(words[0]) ? 2 : 3; };
      items = [...S.foods.filter(match), ...BUILTIN_FOODS.filter(match)].map((f, i) => ({ f, r: rank(f), i }))
        .sort((a, b) => a.r - b.r || a.i - b.i).slice(0, 30).map(x => ({ f: x.f }));
      $('results').innerHTML = items.length ? listHtml(items) : '<p class="empty">No match in your foods. Try searching online.</p>';
      $('online').hidden = false;
    }
  };
  $('results').onclick = e => { const b = e.target.closest('[data-i]'); if (b) { const it = items[+b.dataset.i]; openAmount(it.f, it.preset); } };
  $('q').oninput = () => { holdSheetHeight(); show(); }; show();
  $('online').onclick = async () => {
    const q = $('q').value.trim(); if (!q) return;
    holdSheetHeight();
    $('results').innerHTML = '<div class="loading"><div class="spinner"></div>Searching Open Food Facts…</div>';
    try {
      const url = `${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,brands,nutriments,serving_quantity,serving_size,nutriscore_grade`;
      const j = await (await fetch(url)).json();
      items = (j.products || []).map(p => offToFood(p, p.code)).filter(Boolean).map(f => ({ f }));
      $('results').innerHTML = items.length ? listHtml(items) : '<p class="empty">Nothing found online. Try fewer words or a brand name.</p>';
    } catch (e) { $('results').innerHTML = "<p class=\"empty\">Couldn't reach the food database. Check your connection.</p>"; }
  };
  if ($('quick')) $('quick').onclick = () => openQuick(items.length ? '' : $('q').value.trim());   // carry the text over only if nothing matched
  $('custom').onclick = () => { const typed = $('q').value.trim(); openSheet('Enter a food', '<div id="labelOut"></div>'); labelForm($('labelOut'), {}, '', null, typed); };
}

/* ---------- quick add: one-off numbers, nothing saved to your foods ---------- */
function openQuick(typed) {
  const dn = $('dayLabel').textContent;
  let slot = defaultSlot();
  openSheet('Quick add', `
    <p class="hint">For one-offs like a restaurant meal, a sample or a friend's cooking. Nothing is added to your saved foods.</p>
    <label>What was it? (optional)<input id="qName" maxlength="40" value="${esc(typed || '')}" placeholder="e.g. Sample cup at work"></label>
    <div class="grid2"><label>Calories<input id="qK" type="number" inputmode="decimal" min="0"></label><label>Protein (g)<input id="qP" type="number" inputmode="decimal" min="0"></label></div>
    ${slotChips(slot)}
    <button class="btn" id="qAdd">Add to ${dn === 'Today' ? 'today' : esc(dn)}</button>`);
  $('aSlot').onclick = e => { const b = e.target.closest('[data-s]'); if (!b) return; slot = b.dataset.s; haptic();
    [...$('aSlot').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.s === slot)); };
  $('qAdd').onclick = () => {
    const k = parseFloat($('qK').value) || 0, pr = parseFloat($('qP').value) || 0;
    if (!(k > 0 || pr > 0) || k > 10000 || pr > 1000) { toast('Enter the calories, the protein, or both.'); return; }
    addEntry($('qName').value.trim() || 'Quick add', k, pr, 'quick add', null, slot);
    closeSheet(); toast(`Added ${Math.round(k)} kcal · ${fmtG(pr)}g protein`);
  };
  setTimeout(() => $('qK')?.focus(), 350);
}

/* ---------- meals ---------- */
function mealFood(m) {
  const f = { id: 'meal-' + m.id, name: m.name, source: 'meal', kcalServ: m.kcal, proServ: m.pro };
  const n = Math.max(1, m.servings || 1);
  if (m.cookedG > 0) {        // weighed batch: log any amount by grams or hand portions
    f.servingG = m.cookedG / n; f.servingLabel = `${Math.round(f.servingG)} g`;
    f.kcal100 = (m.totalK ?? m.kcal * n) / m.cookedG * 100; f.pro100 = (m.totalP ?? m.pro * n) / m.cookedG * 100;
  }
  // fibre only when every ingredient has it (worked out from the saved ingredients, nothing new is stored)
  const fibs = (m.items || []).map(itemFib);
  if (fibs.length && fibs.every(x => x != null)) {
    const tot = fibs.reduce((a, b) => a + b, 0);
    f.fibServ = tot / n; if (m.cookedG > 0) f.fib100 = tot / m.cookedG * 100;
  }
  return f;
}
function entryFood(e) { return e.food || { id: 'entry-' + e.id, name: e.name, source: 'entry', kcalServ: e.kcal, proServ: e.pro }; }
function openMeals() {
  openSheet('My meals', `
    ${draftRow()}
    <div class="list" id="mealList">${S.meals.length ? S.meals.map((m, i) => `<div class="meal-row">
        <button class="item" data-m="${i}"><span class="nm">${esc(m.name)}<small>${m.items?.length ? `${m.items.length} ingredient${m.items.length > 1 ? 's' : ''}${m.servings > 1 ? ` · makes ${m.servings}` : ''}${m.cookedG ? ` · weighed ${Math.round(m.cookedG).toLocaleString()} g` : ''}` : 'quick meal'}</small></span>
        <span class="meta">${m.kcal} kcal · ${m.pro}g</span></button>
        <button class="edit" data-edit="${i}" aria-label="Edit ${esc(m.name)}">Edit</button></div>`).join('') : '<p class="empty">No saved meals yet. Build one from the foods you cook with.</p>'}</div>
    <p class="hint">Tap a meal, choose how many, and add it.</p>
    <button class="btn" id="newMeal">Build a new meal</button>`);
  if ($('mDraft')) $('mDraft').onclick = () => { const x = loadDraft(); if (x) resumeDraft(x.d); };
  if ($('mDraftX')) $('mDraftX').onclick = () => { clearDraft(); haptic(); openMeals(); };
  $('mealList').onclick = e => {
    const ed = e.target.closest('[data-edit]');
    if (ed) { const m = S.meals[+ed.dataset.edit], fresh = () => JSON.parse(JSON.stringify({ ...m, items: m.items || [] }));
      // v53: a change made but not saved (closed without Save meal) used to vanish here: Edit showed the old saved meal
      const x = loadDraft();
      if (x && x.d.id === m.id && x.d.touched) { openMealEditor(x.d);
        toast('Unsaved changes are back', { label: 'Discard', fn: () => { clearDraft(); openMealEditor(fresh()); } }); }
      else openMealEditor(fresh());
      return; }
    const b = e.target.closest('[data-m]'); if (!b) return;
    const m = S.meals[+b.dataset.m];
    openAmount(mealFood(m), { qty: 1, unit: 'serving' });
  };
  $('newMeal').onclick = () => openMealEditor({ id: null, name: '', servings: 1, items: [], kcal: '', pro: '' });
}
function mealTotals(d) {
  const t = d.items.reduce((a, it) => { const v = calc(it.food, it.qty, it.unit); return { kcal: a.kcal + v.kcal, pro: a.pro + v.pro }; }, { kcal: 0, pro: 0 });
  const n = Math.max(1, +d.servings || 1);
  return { kcal: t.kcal / n, pro: t.pro / n, totalK: t.kcal, totalP: t.pro };
}
/* The meal being built is kept on this phone as it changes. iOS sometimes restarts a home-screen app after the camera
   or the label reader (they use a lot of memory), which used to wipe a half-built meal. Per device, not synced, and not
   part of the saved data. */
const DRAFT_KEY = 'cutlog.mealDraft', DRAFT_RESUME_MS = 15 * 60 * 1000;
const draftWorth = d => !!(d && Array.isArray(d.items) && ((d.name || '').trim() || d.items.length));
/* v48: 'at' only moves on a real change, and a draft is picked up by itself once, only if the builder was still open
   when the app went away. Before, just opening the builder restamped the time, so it popped up on every launch. */
function saveDraft(d, changed = true) { try {
  if (!(draftWorth(d) && d.touched)) return;
  const old = changed ? null : JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ d, at: old?.at || Date.now(), open: true, resumed: !!old?.resumed }));
} catch (e) {} }
function markDraft(k, v) { try { const x = JSON.parse(localStorage.getItem(DRAFT_KEY)); if (x) { x[k] = v; localStorage.setItem(DRAFT_KEY, JSON.stringify(x)); } } catch (e) {} }
const autoResume = x => !!(x && x.open && !x.resumed && Date.now() - x.at < DRAFT_RESUME_MS);
function loadDraft() { try { const x = JSON.parse(localStorage.getItem(DRAFT_KEY)); return x && draftWorth(x.d) ? x : null; } catch (e) { return null; } }
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }
function draftRow() {
  const x = loadDraft(); if (!x) return '';
  const d = x.d, n = d.items.length, what = [(d.name || '').trim() || 'No name yet', n ? `${n} ingredient${n > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
  return `<div class="draft-row"><button class="food-open" id="mDraft"><span><b>${d.id ? 'Finish editing your meal' : 'Finish your unsaved meal'}</b><small>${esc(what)}</small></span>${icon('i-chev-r')}</button>
    <button class="linkbtn" id="mDraftX">Discard it</button></div>`;
}
/* Back to the meal as it was. If a label photo was in progress for an unknown barcode, go straight back to it. */
function resumeDraft(d, afterRestart) {
  openMealEditor(d);
  if (d.pendingCode) {
    const code = d.pendingCode;
    pick = { label: 'Add to meal', onDone: (f, q, u) => { draft = d; delete d.pendingCode; d.touched = true; d.items.push({ food: f, qty: q, unit: u }); saveDraft(d); openMealEditor(d); } };
    openLabel(code);
    toast(afterRestart ? "Picked up your meal. The label photo didn't finish, so try it again." : 'Back to the label for that barcode');
  } else if (afterRestart) toast('Picked up your meal where you left off');
}
/* Saves the meal being built or edited. Shared by the Save meal button and v53's "Save" on the not-saved-yet message. */
function saveMealFrom(d) {
  const name = (d.name || '').trim(); if (!name) { toast('Give the meal a name.'); return false; }
  let kcal, pro;
  let totalK = null, totalP = null;
  if (d.items.length) { const t2 = mealTotals(d); kcal = Math.round(t2.kcal); pro = Math.round(t2.pro); totalK = t2.totalK; totalP = t2.totalP; }
  else { kcal = Math.round(parseFloat(d.kcal)); pro = Math.round(parseFloat(d.pro) || 0); if (!(kcal >= 0)) { toast('Add ingredients or type the calories.'); return false; } }
  const m = { id: d.id || uid(), name, servings: d.servings || 1, items: d.items, kcal, pro };
  if (d.items.length && d.cookedG) { m.cookedG = d.cookedG; m.totalK = Math.round(totalK); m.totalP = r1(totalP); }
  const i = S.meals.findIndex(x => x.id === m.id);
  if (i >= 0) S.meals[i] = m; else S.meals.push(m);
  d.id = m.id; clearDraft(); touchMeta(); return true;
}
function openMealEditor(d) {
  draft = d; saveDraft(d, false);
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
    ${hasItems ? `<label>Total cooked weight in grams (optional)<input id="mCooked" type="number" inputmode="numeric" min="1" value="${d.cookedG || ''}" placeholder="e.g. 1400"></label>
    <p class="field-note">Weigh everything once it's cooked, without the pot. Then you can log any amount you dish out by grams or by hand portion.</p>
    <p class="hint" id="mPer"></p>` : ''}
    ${hasItems ? `<div class="result"><div><span class="num" id="mK">${Math.round(t.kcal)}</span><small>kcal / serving</small></div><div class="pro"><span class="num" id="mP">${Math.round(t.pro)}g</span><small>protein / serving</small></div></div>`
      : `<p class="hint">No ingredients? Type the totals for one serving instead.</p>
         <div class="grid2"><label>Calories<input id="mKin" type="number" inputmode="numeric" value="${d.kcal ?? ''}"></label><label>Protein (g)<input id="mPin" type="number" inputmode="numeric" value="${d.pro ?? ''}"></label></div>`}
    <button class="btn" id="mSave">Save meal</button>
    ${d.id ? '<button class="btn danger" id="mDelete">Delete meal</button>' : ''}`);
  const keep = () => { d.name = $('mName').value; d.servings = Math.max(1, parseFloat($('mServ').value) || 1); if ($('mKin')) { d.kcal = $('mKin').value; d.pro = $('mPin').value; }
    if ($('mCooked')) d.cookedG = parseFloat($('mCooked').value) > 0 ? parseFloat($('mCooked').value) : null; };
  const per = () => { if (!$('mPer')) return; keep(); const t3 = mealTotals(d);
    $('mPer').textContent = d.cookedG ? `${Math.round(t3.totalK / d.cookedG * 100)} kcal and ${fmtG(t3.totalP / d.cookedG * 100)}g protein per 100 g. One serving is about ${Math.round(d.cookedG / (d.servings || 1))} g.` : ''; };
  const back = () => { saveDraft(d); openMealEditor(d); };   // back to the builder after a change
  /* Undo for a removed or changed ingredient: puts the list back the way it was */
  const undoIng = (msg, prev) => toast(msg, { label: 'Undo', fn: () => {
    d.items = prev; d.touched = true;
    if (draft === d && SH.open && /^(Edit meal|Build a meal)$/.test($('sheetTitle').textContent)) { keep(); back(); }
    else if (loadDraft()) saveDraft(d);
  } });
  const touch = () => { d.touched = true; saveDraft(d); };   // only real changes count as an unsaved meal
  $('mName').oninput = () => { keep(); touch(); };
  if ($('mKin')) $('mKin').oninput = $('mPin').oninput = () => { keep(); touch(); };
  $('mServ').oninput = () => { keep(); touch(); if (hasItems) { const t2 = mealTotals(d); $('mK').textContent = Math.round(t2.kcal); $('mP').textContent = Math.round(t2.pro) + 'g'; } };
  if ($('mCooked')) { $('mCooked').oninput = () => { per(); touch(); }; per(); }
  $('addIng').onclick = () => {
    keep(); delete d.pendingCode; if (d.touched) saveDraft(d);
    pick = { label: 'Add to meal', onDone: (f, q, u) => { draft = d; delete d.pendingCode; d.touched = true; d.items.push({ food: f, qty: q, unit: u }); back(); } };
    openSearch();
  };
  $('ingList').onclick = e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { keep(); const prev = d.items.slice(), gone = d.items[+rm.dataset.rm]; d.touched = true; d.items.splice(+rm.dataset.rm, 1); back();
      undoIng(`Removed ${gone.food.name}`, prev); return; }
    const b = e.target.closest('[data-ing]'); if (!b) return;
    keep(); const i = +b.dataset.ing, it = d.items[i];
    pick = { label: 'Update ingredient', onDone: (f, q, u) => { draft = d; const prev = d.items.slice(); d.touched = true; d.items[i] = { food: f, qty: q, unit: u }; back();
      if (q !== it.qty || u !== it.unit || f.id !== it.food.id) undoIng(`${f.name}: now ${fmtQty(q)} ${unitWord(f, u, q)}`, prev); } };
    openAmount(it.food, { qty: it.qty, unit: it.unit });
  };
  if ($('fromDay')) $('fromDay').onclick = () => {
    keep();
    es.forEach(e => d.items.push({ food: entryFood(e), qty: e.food ? e.qty : 1, unit: e.food ? e.unit : 'serving' }));
    d.touched = true; back();
  };
  $('mSave').onclick = () => { keep(); if (saveMealFrom(d)) { openMeals(); toast('Meal saved'); } };
  if ($('mDelete')) $('mDelete').onclick = () => {
    const i = S.meals.findIndex(x => x.id === d.id); if (i < 0) return;
    const [gone] = S.meals.splice(i, 1); clearDraft(); touchMeta(); openMeals();
    toast(`Deleted ${gone.name}`, { label: 'Undo', fn: () => { S.meals.splice(i, 0, gone); touchMeta(); if (SH.open && $('sheetTitle').textContent === 'My meals') openMeals(); } });
  };
}

/* =================== CLOUD SYNC (Firebase) =================== */
const Sync = { ready: false, auth: null, db: null, user: null, unsub: [], state: 'local', flushing: false, timer: null };
function setSync(state) { Sync.state = state; renderSync(); }
function renderAcct() {
  if (!$('acctText')) return;
  const cfg = window.FIREBASE_CONFIG;
  $('acctState').textContent = $('syncText').textContent;
  $('acctText').textContent = !cfg?.apiKey ? 'Everything is saved on this phone.'
    : Sync.user && Sync.state === 'denied' ? `Signed in as ${Sync.user.email}, but this email isn't on the invite list yet. Your log is saved on this phone.`
    : Sync.user ? `Signed in as ${Sync.user.email}. Your log syncs to the cloud and your other devices.`
    : 'Sign in to back up your log and use it on your laptop too.';
  $('acctBtn').textContent = Sync.user ? 'Manage account' : 'Sign in';
}
function renderSync() {
  const b = $('syncBtn'); if (!b) return;
  const map = {
    local: ['', 'This phone'], loading: ['busy', 'Connecting…'], signedout: ['bad', 'Sign in to sync'],
    syncing: ['busy', 'Saving…'], synced: ['ok', 'Synced'], offline: ['bad', 'Offline'], error: ['bad', 'Sync paused'], denied: ['bad', 'Not invited'],
  };
  const [cls, txt] = map[Sync.state] || map.local;
  b.className = 'sync ' + cls; $('syncText').textContent = txt; renderAcct();
}
function dayDoc(d) { return { entries: S.log[d] || [], weight: S.weights[d] ?? null, waist: S.waist?.[d] ?? null, updatedAt: S.stamps.days[d] || Date.now() }; }
function metaDoc() { return { targets: S.targets, meals: S.meals, foods: S.foods, recent: S.recent, theme: S.theme || 'cobalt', slotPref: S.slotPref || {}, name: S.name || '', scale: S.scale || 'daily', units: S.units || 'imperial', startWeight: S.startWeight ?? null, milestones: S.milestones || {}, msInit: !!S.msInit, updatedAt: S.stamps.meta || Date.now() }; }
function applyDay(id, data) {
  if (data.entries && data.entries.length) S.log[id] = data.entries; else delete S.log[id];
  if (data.weight != null) S.weights[id] = data.weight; else delete S.weights[id];
  S.waist ||= {}; if (data.waist != null) S.waist[id] = data.waist; else delete S.waist[id];
  S.stamps.days[id] = data.updatedAt || 0;
  S.dirty = S.dirty.filter(k => k !== 'd:' + id);
}
function applyMeta(data) {
  ['targets', 'meals', 'foods', 'recent', 'theme', 'slotPref', 'name', 'scale', 'units', 'startWeight', 'milestones', 'msInit'].forEach(k => { if (data[k] !== undefined) S[k] = data[k]; });
  S.onboarded = true; delete S.metaUnsynced;   // this account was already set up somewhere
  S.targets = Object.assign({ mode: 'lose' }, S.targets); S.milestones ||= {};
  applyTheme(); if (typeof hideOnboarding === 'function') hideOnboarding();
  S.stamps.meta = data.updatedAt || 0;
  S.dirty = S.dirty.filter(k => k !== 'meta');
}
/* Merge one remote document: newer side wins. Returns true when local data changed. */
function mergeRemote(kind, id, data) {
  if (kind === 'meta' && S.metaUnsynced && data) { applyMeta(data); return true; }
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
    Sync.flushing = false;
    if (e?.code === 'permission-denied') { setSync('denied'); return; }
    setSync(navigator.onLine ? 'error' : 'offline');
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
    new Set([...Object.keys(S.log), ...Object.keys(S.weights), ...Object.keys(S.waist || {})]).forEach(d => { if (!seenDays.has(d)) { S.stamps.days[d] ||= Date.now(); markDirty('d:' + d); } });
    if (!seenMeta) { S.stamps.meta ||= Date.now(); markDirty('meta'); }
    delete S.metaUnsynced;
    persist(); renderAll(); flush();
  };
  const seenDays = new Set(); let seenMeta = false;
  Sync.unsub.push(base.collection('meta').doc('main').onSnapshot(snap => {
    if (snap.metadata.hasPendingWrites) return;
    if (snap.exists) { seenMeta = true; if (mergeRemote('meta', 'main', snap.data())) { persist(); renderAll(); } }
    if (!gotMeta) { gotMeta = true; firstDone(); }
  }, e => setSync(e?.code === 'permission-denied' ? 'denied' : 'error')));
  Sync.unsub.push(base.collection('days').onSnapshot(qs => {
    let changed = false;
    qs.docChanges().forEach(c => {
      if (c.type === 'removed' || c.doc.metadata.hasPendingWrites) return;
      seenDays.add(c.doc.id);
      if (mergeRemote('day', c.doc.id, c.doc.data())) changed = true;
    });
    if (changed) { persist(); renderAll(); }
    if (!gotDays) { gotDays = true; firstDone(); }
  }, e => setSync(e?.code === 'permission-denied' ? 'denied' : 'error')));
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
      if (SH.open && $('sheetTitle').textContent === 'Cloud sync') openAccount();
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
  if (Sync.user && Sync.state === 'denied') {
    openSheet('Cloud sync', `<div class="acct"><strong>This email isn't on the invite list yet</strong>
      <span class="hint">You're signed in as ${esc(Sync.user.email)}, but syncing is limited to invited friends. Ask the person who shared the app to add this email. Your log is still saved on this phone and will sync as soon as you're added.</span></div>
      <button class="btn" id="retryInv">Check again</button>
      <button class="btn ghost" id="signOut">Sign out</button>`);
    $('retryInv').onclick = () => { closeSheet(); const u = Sync.user; stopUser(); startUser(u); };
    $('signOut').onclick = () => Sync.auth.signOut();
    return;
  }
  if (Sync.user) {
    const ver = Sync.auth.currentUser?.emailVerified !== false;   // v63
    openSheet('Cloud sync', `<div class="acct"><span class="hint">Signed in as</span><strong>${esc(Sync.user.email)}</strong>
      <span class="hint" id="aVer">${ver ? 'Email confirmed ✓' : 'Email not confirmed yet. Confirming it keeps anyone else from signing up with your address.'}</span>
      <span class="hint">${S.dirty.length ? `${S.dirty.length} change${S.dirty.length > 1 ? 's' : ''} waiting to upload.` : 'Everything is backed up.'}</span></div>
      <button class="btn" id="syncNow">Sync now</button>
      <button class="btn ghost" id="signOut">Sign out</button>
      <p class="hint">Signing out keeps your data on this phone. Sign in on your laptop with the same email to see everything there too.</p>`);
    $('syncNow').onclick = () => { flush(); toast('Syncing'); };
    verifyButtons(ver);
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
  $('aUp').onclick = async () => { busy(true); err(''); try { await Sync.auth.createUserWithEmailAndPassword(...creds()); closeSheet(); toast('Account created. Your log is backing up.');
    try { await Sync.auth.currentUser?.sendEmailVerification(); setTimeout(() => toast('Check your email to confirm your address.'), 2800); } catch (e) {} } catch (e) { err(authError(e)); } busy(false); };
  $('aReset').onclick = async () => {
    const em = $('aEmail').value.trim(); if (!em) { err('Type your email first.'); return; }
    try { await Sync.auth.sendPasswordResetEmail(em); err(''); toast('Reset email sent'); } catch (e) { err(authError(e)); }
  };
}

/* v63: email confirmation, step 1. Nothing is blocked yet: the account panel shows whether the address is confirmed and can
   send the link. Step 2 (only after Kan and his friends are confirmed) is a rules change he pastes into Firebase, adding
   request.auth.token.email_verified == true to invited(), so a stranger can't sign up with an invited friend's address first. */
function verifyButtons(ver) {
  const box = $('aVer'); if (!box || ver) return;
  box.closest('.acct').insertAdjacentHTML('afterend', `<button class="btn ghost" id="aSendVer">Send confirmation email</button><button class="btn ghost" id="aCheckVer">I've confirmed it</button>`);
  $('aSendVer').onclick = async () => {
    try { await Sync.auth.currentUser.sendEmailVerification(); toast('Sent. Open the link in the email.'); }
    catch (e) { toast(/too-many/.test(e?.code || '') ? 'Already sent. Check your inbox (and junk).' : 'Couldn’t send it. Try again later.'); }
  };
  $('aCheckVer').onclick = async () => {
    try {
      const u = Sync.auth.currentUser; await u.reload(); await u.getIdToken(true);      // fresh sign-in token that carries the confirmation
      if (Sync.auth.currentUser.emailVerified) { toast('Email confirmed ✓'); openAccount(); } else toast('Not confirmed yet. Tap the link in the email first.');
    } catch (e) { toast('Couldn’t check. Are you online?'); }
  };
}

/* =================== TRENDS =================== */
let range = 30, tab = 'today', chartAnim = false;
function dayTotals(d) {
  const es = S.log[d]; if (!es || !es.length) return null;
  return { kcal: es.reduce((a, e) => a + e.kcal, 0), pro: es.reduce((a, e) => a + e.pro, 0) };
}
/* v59: the weekly rate comes from the trend line (each weigh-in's 7-day average), not the raw dots, and only once the
   weigh-ins used span a week. Kan's first few days (210.0 to 212.6) were read as +1.7 lb/week from the raw dots, which set off
   "not moving toward your goal". The fit looks back at least 14 days so the 7-day view has enough to go on. */
const RATE_MIN_SPAN = 7, RATE_MIN_DAYS = 14;
function trendPts(pts, arr) { return pts.map(p => ({ date: p.date, lb: avgBetween(arr, shift(p.date, -6), p.date) })); }
function trendRate(to, days) {
  const arr = weightsArr(), from = shift(to, -(Math.max(days, RATE_MIN_DAYS) - 1));
  const pts = arr.filter(w => w.date >= from && w.date <= to);
  if (pts.length < 3 || daysBetween(pts[0].date, pts[pts.length - 1].date) < RATE_MIN_SPAN) return null;
  return slopePerWeek(trendPts(pts, arr));
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
    svg += `<rect class="bar" style="animation-delay:${Math.min(i * 14, 420)}ms;cursor:pointer" data-day="${days[i]}" x="${x.toFixed(1)}" y="${Y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(H - B - Y(v)).toFixed(1)}" rx="${Math.min(3, w / 2)}" fill="${col}"/>`;
  });
  if (opts.line != null) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(opts.line)}" y2="${Y(opts.line)}" stroke="var(--protein)" stroke-width="2" stroke-dasharray="5 4"/>`;
  svg += `<text x="${L}" y="${H - 6}" ${TXT}>${parseIso(days[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" ${TXT}>Today</text></svg>`;
  return svg;
}
function weightChart(from, to) {
  const arr = weightsArr().map(w => ({ date: w.date, lb: toW(w.lb) })), pts = arr.filter(w => w.date >= from && w.date <= to);
  const G = S.targets.goal ? toW(S.targets.goal) : null;
  if (pts.length < 2) return '<p class="empty">Two or more weigh-ins in this range will draw your trend here.</p>';
  const W = 520, H = 180, L = 40, R = 12, T = 12, B = 24;
  const t0 = parseIso(from).getTime(), t1 = parseIso(to).getTime();
  const lbs = pts.map(p => p.lb).concat(G != null && G >= Math.min(...pts.map(p => p.lb)) - 3 ? [G] : []);
  const lo = Math.floor(Math.min(...lbs) - 1), hi = Math.ceil(Math.max(...lbs) + 1);
  const X = s => L + (parseIso(s).getTime() - t0) / (t1 - t0) * (W - L - R), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const av = pts.map(p => [X(p.date), Y(avgBetween(arr, shift(p.date, -6), p.date))]);
  const line = av.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight trend"><defs><linearGradient id="twg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`;
  niceTicks(lo, hi).forEach(v => { svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" ${TXT}>${v}</text>`; });
  if (G != null && G >= lo && G <= hi) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(G)}" y2="${Y(G)}" stroke="var(--protein)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W - R}" y="${Y(G) - 5}" text-anchor="end" font-size="11" fill="var(--protein)" font-family="Barlow, system-ui, sans-serif">Goal ${fWs(S.targets.goal)}</text>`;
  svg += `<polygon points="${av[0][0].toFixed(1)},${H - B} ${line} ${av[av.length - 1][0].toFixed(1)},${H - B}" fill="url(#twg)"/>`;
  pts.forEach(p => { svg += `<circle cx="${X(p.date)}" cy="${Y(p.lb)}" r="3" fill="var(--muted)" opacity=".5"/>`; });
  const last = av[av.length - 1];
  svg += `<polyline class="draw" pathLength="1" points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/><circle class="dot-end" cx="${last[0]}" cy="${last[1]}" r="5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
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
  const need = { days: 10, weighs: scale() === 'daily' ? 7 : 3, span: 14 };
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
  if (!e.ready && scale() === 'none' && e.have.weighs < e.need.weighs) {
    conf.textContent = 'Needs weigh-ins'; conf.className = 'conf';
    box.innerHTML = `<p class="hint">Your real burn is worked out from what you eat and how your weight moves, so it needs a weigh-in about once a week. A gym or pharmacy scale is enough. Switch to "Once a week" in the You tab if you can.</p>`;
    return;
  }
  if (!e.ready) {
    conf.textContent = 'Learning'; conf.className = 'conf';
    const bar = (h, n) => `<div class="prog"><i style="width:${Math.min(100, h / n * 100)}%"></i></div>`;
    box.innerHTML = `<p class="hint">After about two weeks of logging food and weighing in, this shows how many calories you actually burn a day, worked out from what you eat and how your weight moves. No watch needed.</p>
      <div class="learn">
        <div><span>Days of food logged</span><b>${e.have.days}/${e.need.days}</b>${bar(e.have.days, e.need.days)}</div>
        <div><span>${scale() === 'daily' ? 'Morning weigh-ins' : 'Weigh-ins'}</span><b>${e.have.weighs}/${e.need.weighs}</b>${bar(e.have.weighs, e.need.weighs)}</div>
        <div><span>Days of weight history</span><b>${e.have.span}/${e.need.span}</b>${bar(e.have.span, e.need.span)}</div>
      </div>`;
    return;
  }
  conf.textContent = e.conf + ' confidence'; conf.className = 'conf ' + (e.conf === 'High' ? 'ok' : '');
  const m = mode();
  const [dLo, dHi, label] = m === 'lose' ? [-750, -500, `For ${PACE().lose} a week`] : m === 'gain' ? [200, 400, 'For a lean gain'] : [-150, 150, 'To hold steady'];
  const lo = Math.max(1200, r50(e.burn + dLo)), hi = Math.max(lo + 100, r50(e.burn + dHi));
  const T = S.targets, same = T.calLo === lo && T.calHi === hi;
  const lossTxt = e.perWeek < -0.05 ? `lost ${fW(Math.abs(e.perWeek))} ${wU()} a week` : e.perWeek > 0.05 ? `gained ${fW(e.perWeek)} ${wU()} a week` : 'held your weight steady';
  box.innerHTML = `
    <div class="burn-n"><span class="num" id="burnNum">${r50(e.burn).toLocaleString()}</span><span class="u">kcal a day</span></div>
    <p class="hint">Over the last 4 weeks you ate about ${Math.round(e.intake).toLocaleString()} kcal a day and ${lossTxt}. That works out to this daily burn, including your training.</p>
    <div class="suggest">
      <div><span class="k">${label}</span><span class="v">${lo.toLocaleString()}–${hi.toLocaleString()}<small>kcal</small></span></div>
      <div><span class="k">Your target now</span><span class="v">${T.calLo.toLocaleString()}–${T.calHi.toLocaleString()}<small>kcal</small></span></div>
    </div>
    ${same ? '<p class="hint">Your target already matches. Nothing to change.</p>' : `<button class="btn" id="useBurn">Use ${lo.toLocaleString()}–${hi.toLocaleString()} as my target</button>`}
    <p class="hint">Only as accurate as your logging: days with forgotten snacks make your burn look lower than it is.</p>`;
  if ($('viewTrends').classList.contains('anim') || chartAnim) { const n = $('burnNum'); n._v = 0; animateNum(n, r50(e.burn), undefined, 800); }
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
  const rate = trendRate(to, range);
  const now = avgBetween(arr, shift(to, -6), to);
  $('tRate').textContent = rate == null ? '–' : (rate > 0 ? '+' : rate < 0 ? '−' : '') + fW(Math.abs(rate));
  $('tNow').textContent = now ? fW(now) : '–';
  $('tChange').textContent = inR.length >= 2 ? ((d => (d > 0 ? '+' : d < 0 ? '−' : '') + fW(Math.abs(d)))(avgBetween(arr, shift(to, -6), to) - avgBetween(arr, inR[0].date, shift(inR[0].date, 6)))) : '–';
  $('tGoalK').textContent = T.goal ? `Reach ${fWs(T.goal)}` : 'Reach goal';
  const read = $('tRead'); read.className = 'status';
  const dir = mode() === 'lose' ? -1 : mode() === 'gain' ? 1 : 0;
  const reached = T.goal && now && ((dir < 0 && now <= T.goal) || (dir > 0 && now >= T.goal));
  if (rate == null) { $('tEta').textContent = '–'; read.textContent = scale() === 'daily' ? `Weigh in most mornings. After about a week, your weekly rate${T.goal ? ' and goal date' : ''} show up here.`
      : scale() === 'weekly' ? `Weigh in once a week. After three weigh-ins, your weekly rate${T.goal ? ' and goal date' : ''} show up here.`
      : 'No weigh-ins yet. Your waist on the Today tab tracks progress without a scale.'; }
  else if (reached) {
    $('tEta').textContent = 'Reached'; read.className = 'status ok';
    read.textContent = `You've reached ${fWs(T.goal)} ${wU()} on your 7-day average. Switch to Maintaining in the You tab to hold it.`;
  }
  else if (dir === 0) {
    $('tEta').textContent = T.goal ? 'At goal' : '–';
    if (Math.abs(rate) <= 0.3) { read.className = 'status ok'; read.textContent = `Holding steady at ${rate > 0 ? '+' : rate < 0 ? '−' : ''}${fW(Math.abs(rate))} ${wU()} a week. Nicely maintained.`; }
    else { read.className = 'status hi'; read.textContent = `${rate < 0 ? 'Losing' : 'Gaining'} ${fW(Math.abs(rate))} ${wU()} a week. ${rate < 0 ? 'Add' : 'Trim'} about 200 kcal a day to hold steady.`; }
  } else {
    const towards = dir * rate;      // positive = moving toward goal
    if (towards > 0.05) {
      const weeks = Math.abs(now - T.goal) / Math.abs(rate), eta = new Date(); eta.setDate(eta.getDate() + Math.round(weeks * 7));
      $('tEta').textContent = eta.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const r = Math.abs(rate), verb = dir < 0 ? 'Losing' : 'Gaining';
      const [slow, fast] = dir < 0 ? [0.5, 1.6] : [0.2, 0.8];
      if (r < slow) read.textContent = `${verb} ${fW(r)} ${wU()} a week, which is slow. ${dir < 0 ? 'Trimming' : 'Adding'} about 200 kcal a day would speed it up.`;
      else if (r <= fast) { read.className = 'status ok'; read.textContent = `${verb} ${fW(r)} ${wU()} a week, a steady pace${dir < 0 ? ' that protects your strength' : ' for lean gains'}.`; }
      else { read.className = 'status hi'; read.textContent = `${verb} ${fW(r)} ${wU()} a week, on the fast side. ${dir < 0 ? 'Adding' : 'Trimming'} 200–300 kcal a day would ease the pace.`; }
    } else { $('tEta').textContent = '–'; read.className = 'status hi'; read.textContent = `Your weight isn't moving toward your goal over this range. Check that you're logging everything, and aim for the ${dir < 0 ? 'low' : 'high'} end of your calorie range.`; }
  }
  renderBurn(); renderMilestones(); safe(renderCheckin);
  $('tWeightChart').innerHTML = weightChart(from, to);
  $('tWHist').hidden = arr.length < 2; $('tCalHist').hidden = !firstLogDay();   // v55
  $('viewTrends').classList.toggle('anim', chartAnim); chartAnim = false;
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
  safe(() => renderFibChart(days));
  $('tProNote').textContent = logged.length ? `Dashed line is your ${T.protein}g target.` : '';
  const inRange = logged.filter(t => t.kcal >= T.calLo && t.kcal <= T.calHi).length, hit = logged.filter(t => t.pro >= T.protein).length;
  $('tDays').textContent = `last ${range} days`;
  $('tInRange').textContent = logged.length ? `${inRange}/${logged.length}` : '–';
  $('tProHit').textContent = logged.length ? `${hit}/${logged.length}` : '–';
  $('tLogged').textContent = `${logged.length}/${range}`;
  $('tWeighed').textContent = inR.length;
}
function showTab(t) {
  const changed = tab !== t; tab = t;
  $('viewToday').hidden = t !== 'today'; $('viewTrends').hidden = t !== 'trends'; $('viewYou').hidden = t !== 'you';
  if (changed) { replay({ today: $('viewToday'), trends: $('viewTrends'), you: $('viewYou') }[t], 'view-in'); if (t === 'trends') chartAnim = true; haptic(); }
  document.querySelectorAll('.tabbar button').forEach(b => b.dataset.tab === t ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (t === 'trends') renderTrends();
  $('scroller').scrollTo(0, 0);
}
document.querySelector('.tabbar').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };
$('range').onclick = e => {
  const b = e.target.closest('[data-r]'); if (!b) return;
  range = +b.dataset.r; [...$('range').children].forEach((c, i) => { c.setAttribute('aria-pressed', c === b); if (c === b) $('range').style.setProperty('--i', i); });
  chartAnim = true; haptic(); renderTrends();
};
$('viewTrends').addEventListener('click', e => {
  const r = e.target.closest('rect[data-day]'); if (!r) return;
  day = r.dataset.day; showTab('today'); renderDay(); renderTotals(); renderRows();
});

/* =================== MILESTONES =================== */
const MS_STREAKS = [3, 7, 14, 30, 60, 100], PRO_STREAKS = [7, 30];
function runLength(test) {             // consecutive days ending today (or yesterday, if today isn't done yet)
  let d = todayIso(); if (!test(d)) d = shift(d, -1);
  let n = 0; while (n < 1000 && test(d)) { n++; d = shift(d, -1); }
  return n;
}
const logStreak = () => runLength(d => entriesFor(d).length > 0);
const proStreak = () => runLength(d => { const t = dayTotals(d); return !!t && t.pro >= S.targets.protein; });
function trendNow() {
  const t = todayIso(), w = weightsArr().filter(x => x.date >= shift(t, -6));
  if (w.length >= 3) return w.reduce((a, x) => a + x.lb, 0) / w.length;
  if (scale() !== 'daily') { const r = weightsArr().filter(x => x.date >= shift(t, -13)); if (r.length) return r[r.length - 1].lb; }   // weekly: latest weigh-in
  return null;
}
function waistProgress() { const z = waistArr(); return z.length >= 2 ? { first: z[0].v, now: z[z.length - 1].v, prog: toL(z[0].v - z[z.length - 1].v) } : null; }   // prog in inches or cm
const waistStep = () => metric() ? 2 : 1;
const waistName = k => metric() ? `Waist down ${k} cm` : `Waist down ${k} inch${k > 1 ? 'es' : ''}`;
const startW = () => S.startWeight ?? weightsArr()[0]?.lb ?? null;
const stepLb = () => metric() ? (mode() === 'gain' ? 1 : 2) : (mode() === 'gain' ? 2.5 : 5);   // in display units
function weightProgress() {
  const now = trendNow(), s = startW(), m = mode();
  if (now == null || s == null || m === 'maintain') return null;
  const dir = m === 'lose' ? -1 : 1;
  // progress in display units (lb or kg)
  return { now, s, dir, prog: toW((now - s) * dir), total: S.targets.goal ? toW((S.targets.goal - s) * dir) : null };
}
function earnedNow() {
  const out = [], m = mode(), T = S.targets;
  if (Object.keys(S.log).some(d => entriesFor(d).length)) out.push({ id: 'first-log', title: 'First food logged', sub: 'The hardest part is starting. Keep it going tomorrow.' });
  if (weightsArr().length) out.push({ id: 'first-weigh', title: 'First weigh-in', sub: 'Your trend line starts here. Weigh in each morning.' });
  const ls = logStreak();
  MS_STREAKS.forEach(n => { if (ls >= n) out.push({ id: 'streak-' + n, title: `${n}-day logging streak`, sub: `You've logged food ${n} days in a row.` }); });
  const ps = proStreak();
  PRO_STREAKS.forEach(n => { if (ps >= n) out.push({ id: 'protein-' + n, title: `Protein goal ${n} days running`, sub: `${T.protein}g or more every day for ${n} days.` }); });
  const wp = weightProgress();
  if (wp) {
    const step = stepLb(), u = wU(), toGo = T.goal ? ` · ${fW(Math.abs(wp.now - T.goal))} ${u} to go` : '';
    for (let k = step; k <= wp.prog + 1e-9; k += step)
      out.push({ id: metric() ? `w-${m}-kg-${k}` : `w-${m}-${k}`, title: `${m === 'lose' ? 'Down' : 'Up'} ${k} ${u}`, sub: `Your average is ${fW(wp.now)} ${u}${toGo}.` });
    if (wp.total != null && wp.total >= 4) {
      if (wp.prog >= wp.total / 2) out.push({ id: `half-${m}-${T.goal}`, title: `Halfway to ${fWs(T.goal)} ${wU()}`, sub: `${Math.max(0, wp.total - wp.prog).toFixed(1)} ${wU()} to go. Keep going.` });
      if (wp.prog >= wp.total) out.push({ id: `goal-${m}-${T.goal}`, title: `Goal reached: ${fWs(T.goal)} ${wU()}`, sub: 'Switch to Maintaining in the You tab to hold it, or set a new goal.' });
    }
  }
  if (waistArr().length) out.push({ id: 'first-waist', title: 'First waist measurement', sub: 'Measure again in a week or two to see it move.' });
  const zp = waistProgress();
  if (zp && m === 'lose') for (let k = waistStep(); k <= zp.prog + 1e-9; k += waistStep())
    out.push({ id: metric() ? `waist-down-cm-${k}` : `waist-down-${k}`, title: waistName(k), sub: `From ${fmtIn(zp.first)} to ${fmtIn(zp.now)}. That's fat coming off.` });
  if (m === 'maintain' && T.goal) {
    const t = todayIso(), w = weightsArr().filter(x => x.date >= shift(t, -13));
    if (w.length >= 7 && (parseIso(t) - parseIso(w[0].date)) / 864e5 >= 10 && w.every(x => Math.abs(x.lb - T.goal) <= 2.5))
      out.push({ id: `hold-14-${T.goal}`, title: 'Held steady for 2 weeks', sub: `Every weigh-in within ${metric() ? '1.1 kg' : '2.5 lb'} of ${fWs(T.goal)} ${wU()}.` });
  }
  return out;
}
let msBusy = false, msSilent = false;
const celQueue = [];
function checkMilestones(silent) {
  if (msBusy) return; msBusy = true;
  try {
    const got = earnedNow().filter(x => !S.milestones[x.id]);
    if (!got.length) return;
    const d = todayIso();
    got.forEach(x => { S.milestones[x.id] = { d, t: x.title }; });
    touchMeta();
    if (!silent && !msSilent) { celQueue.push(...got.slice(-2)); setTimeout(showNextCel, 450); }
    if (tab === 'trends') renderMilestones();
  } finally { msBusy = false; }
}
function showNextCel() {
  const c = $('celebrate'); if (!c.hidden || !celQueue.length) return;
  const x = celQueue.shift();
  $('celTitle').textContent = x.title; $('celSub').textContent = x.sub;
  c.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => c.classList.add('in')));
  haptic(); confetti();
}
$('celOk').onclick = () => {
  const c = $('celebrate'); c.classList.remove('in');
  setTimeout(() => { c.hidden = true; showNextCel(); }, 320);
};
function confetti() {
  if (REDUCED) return;
  const cv = $('confetti'), ctx = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.scale(dpr, dpr);
  const cs = getComputedStyle(document.documentElement);
  const cols = ['--accent', '--protein', '--ring-cal', '--ring-pro', '--warn'].map(v => cs.getPropertyValue(v).trim()).filter(Boolean);
  const P = Array.from({ length: 130 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 60, y: innerHeight * .42,
    vx: (Math.random() - .5) * 11, vy: -Math.random() * 13 - 4, r: Math.random() * 6 + 4,
    a: Math.random() * 6.3, va: (Math.random() - .5) * .35, c: cols[Math.floor(Math.random() * cols.length)],
  }));
  const t0 = performance.now();
  const frame = now => {
    const t = now - t0; ctx.clearRect(0, 0, innerWidth, innerHeight);
    P.forEach(p => { p.vy += .32; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - t / 2200); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore(); });
    if (t < 2200) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  requestAnimationFrame(frame);
}
let msAll = false;
function renderMilestones() {
  const box = $('msBody'); if (!box) return;
  const list = Object.entries(S.milestones || {}).map(([id, v]) => ({ id, ...v })).sort((x, y) => (x.d < y.d ? 1 : x.d > y.d ? -1 : 0));
  $('msCount').textContent = list.length ? `${list.length} earned` : '';
  const nexts = [];
  const wp = weightProgress(), step = stepLb();
  if (wp) {
    const k = Math.floor(Math.max(0, wp.prog) / step + 1e-9) * step + step;
    const capped = wp.total != null && wp.total > 0 && k > wp.total;
    const label = capped ? `Goal: ${fWs(S.targets.goal)} ${wU()}` : `${mode() === 'lose' ? 'Down' : 'Up'} ${k} ${wU()}`;
    const left = capped ? wp.total - wp.prog : k - wp.prog;
    nexts.push({ label, meta: `${Math.max(0, left).toFixed(1)} ${wU()} to go`, frac: 1 - Math.max(0, left) / step });
  } else if (mode() !== 'maintain' && scale() !== 'none') nexts.push({ label: 'Weight milestones', meta: scale() === 'daily' ? 'Weigh in 3 mornings this week to start' : 'Log a weigh-in to start', frac: scale() === 'daily' ? Math.min(1, weightsArr().filter(x => x.date >= shift(todayIso(), -6)).length / 3) : 0 });
  if (mode() === 'lose' && (scale() === 'none' || waistArr().length)) {
    const zp = waistProgress();
    if (!zp) nexts.push({ label: 'Waist milestones', meta: waistArr().length ? 'Measure again in a week or two' : 'Log your waist to start', frac: waistArr().length ? 0.5 : 0 });
    else { const st = waistStep(), k = Math.floor(Math.max(0, zp.prog) / st + 1e-9) * st + st, left = k - zp.prog;
      nexts.push({ label: waistName(k), meta: `${metric() ? left.toFixed(1) + ' cm' : left.toFixed(2).replace(/0$/, '') + '″'} to go`, frac: 1 - left / st }); }
  }
  const ls = logStreak(), ns = MS_STREAKS.find(n => n > ls);
  if (ns) nexts.push({ label: `${ns}-day logging streak`, meta: `${ns - ls} day${ns - ls > 1 ? 's' : ''} to go`, frac: ls / ns });
  const shown = msAll ? list : list.slice(0, 4);
  box.innerHTML = `
    ${nexts.length ? `<div class="ms-next">${nexts.map(n => `<div><div class="ms-nh"><span>Next: ${esc(n.label)}</span><b>${esc(n.meta)}</b></div><div class="prog"><i style="width:${Math.round(Math.max(0.03, Math.min(1, n.frac)) * 100)}%"></i></div></div>`).join('')}</div>` : ''}
    ${list.length ? `<div class="ms-list">${shown.map(m => `<div class="ms-item"><span class="ms-ic"><svg><use href="#i-medal"/></svg></span><span class="ms-t">${esc(m.t)}</span><span class="ms-d">${parseIso(m.d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div>`).join('')}</div>
      ${list.length > 4 ? `<button class="btn ghost" id="msMore">${msAll ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}`
      : '<p class="empty">Log food and weigh in to earn your first milestone.</p>'}`;
  if ($('msMore')) $('msMore').onclick = () => { msAll = !msAll; renderMilestones(); };
}

/* =================== FIRST-RUN SETUP =================== */
const OB = { units: 'imperial', scale: 'daily', sex: 'male', age: '', hu: 'ft', cm: '', ft: '', inch: '', lb: '', act: 'active', goal: 'lose', goalLb: '' };
const ACTS = [
  ['low', 'Mostly sitting', 'Desk job, little exercise', 1.2],
  ['light', 'Lightly active', 'On your feet some, or 1–2 workouts a week', 1.375],
  ['active', 'Active', 'Train 3–5 times a week', 1.55],
  ['very', 'Very active', 'Hard training 6+ days, or a physical job', 1.725],
];
function obSeg(id, opts, val) { return `<div class="seg2" id="${id}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === val}">${l}</button>`).join('')}</div>`; }
function showOnboarding(step = 1) {
  const o = $('onboard'), b = $('obBody');
  if (o.hidden) { o.hidden = false; requestAnimationFrame(() => o.classList.add('in')); }
  if (step === 1) {
    b.innerHTML = `<div class="ob-hero"><span class="ob-mark" aria-hidden="true"></span><h1>Cut Log</h1>
        <p>Track calories and protein in seconds. Scan a barcode, snap a label, or tap a saved meal, and see your real weight trend.</p></div>
      <div class="ob-actions"><button class="btn" id="obStart">Get started</button>
      ${window.FIREBASE_CONFIG?.apiKey ? '<button class="btn ghost" id="obSignIn">I already have an account</button>' : ''}</div>`;
    $('obStart').onclick = () => showOnboarding(2);
    if ($('obSignIn')) $('obSignIn').onclick = () => openAccount();
  }
  if (step === 2) {
    b.innerHTML = `<div class="ob-step"><span class="ob-n">Step 1 of 2</span><h2>About you</h2><p class="hint">Your age, height and sex are used once to suggest your starting targets and aren't saved.</p></div>
      <div class="ob-form">
        <label>Units ${obSeg('obUnits', [['imperial', 'lb · ft · in'], ['metric', 'kg · cm']], OB.units)}</label>
        <label>Your first name<input id="obName" maxlength="30" value="${esc(OB.name || '')}" placeholder="What should the app call you?" autocomplete="given-name"></label>
        <label>Sex (for the calorie formula)${obSeg('obSex', [['male', 'Male'], ['female', 'Female']], OB.sex)}</label>
        <label>Age<input id="obAge" type="number" inputmode="numeric" min="14" max="100" value="${OB.age}" placeholder="e.g. 27"></label>
        <label>Height ${obSeg('obHu', [['ft', 'ft / in'], ['cm', 'cm']], OB.hu)}
          <div class="grid2" id="obFt" ${OB.hu === 'cm' ? 'hidden' : ''}><input id="obFeet" type="number" inputmode="numeric" placeholder="ft" value="${OB.ft}" aria-label="Feet"><input id="obIn" type="number" inputmode="decimal" placeholder="in" value="${OB.inch}" aria-label="Inches"></div>
          <input id="obCm" type="number" inputmode="decimal" placeholder="cm" value="${OB.cm}" aria-label="Centimetres" ${OB.hu === 'ft' ? 'hidden' : ''}></label>
        <label>Current weight (${OB.units === 'metric' ? 'kg' : 'lb'})<input id="obLb" type="number" inputmode="decimal" step="0.1" value="${OB.lb}" placeholder="${OB.units === 'metric' ? 'e.g. 84' : 'e.g. 185'}"></label>
        <button type="button" class="linkbtn est-open" id="obEstBtn">Don't know your weight? Estimate it</button><div id="obEst" hidden></div>
        <div class="ob-label">How active are you?</div>
        <div class="ob-cards" id="obAct">${ACTS.map(([v, t, s]) => `<button type="button" class="ob-card" data-v="${v}" aria-pressed="${v === OB.act}"><strong>${t}</strong><span>${s}</span></button>`).join('')}</div>
        <label>Your goal ${obSeg('obGoal', [['lose', 'Lose fat'], ['maintain', 'Maintain'], ['gain', 'Build']], OB.goal)}</label>
        <label>How often can you weigh yourself? ${obSeg('obScale', [['daily', 'Every morning'], ['weekly', 'Once a week'], ['none', 'No scale']], OB.scale)}</label>
        <label id="obGoalW" ${OB.goal === 'maintain' ? 'hidden' : ''}>Goal weight (${OB.units === 'metric' ? 'kg' : 'lb'})<input id="obGoalLb" type="number" inputmode="decimal" step="0.1" value="${OB.goalLb}" placeholder="${OB.units === 'metric' ? 'e.g. 79' : 'e.g. 175'}"></label>
        <p class="err" id="obErr" hidden></p>
      </div>
      <div class="ob-actions"><button class="btn" id="obNext">See my targets</button><button class="btn ghost" id="obBack">Back</button></div>`;
    const seg = (id, key, after) => $(id).onclick = e => { const t = e.target.closest('[data-v]'); if (!t) return; OB[key] = t.dataset.v; haptic();
      [...$(id).children].forEach(c => c.setAttribute('aria-pressed', c === t)); after && after(); };
    const keep = () => { OB.name = $('obName').value.trim(); OB.age = $('obAge').value; OB.ft = $('obFeet').value; OB.inch = $('obIn').value; OB.cm = $('obCm').value; OB.lb = $('obLb').value; OB.goalLb = $('obGoalLb').value; };
    seg('obSex', 'sex'); seg('obHu', 'hu', () => { $('obFt').hidden = OB.hu === 'cm'; $('obCm').hidden = OB.hu === 'ft'; });
    seg('obGoal', 'goal', () => { $('obGoalW').hidden = OB.goal === 'maintain'; });
    seg('obAct', 'act'); seg('obScale', 'scale');
    seg('obUnits', 'units', () => { keep(); OB.hu = OB.units === 'metric' ? 'cm' : 'ft'; showOnboarding(2); });
    $('obBack').onclick = () => { keep(); showOnboarding(1); };
    $('obEstBtn').onclick = () => { haptic(); $('obEstBtn').hidden = true; $('obEst').hidden = false;
      estBox($('obEst'), 'ob', () => { keep(); return { metric: OB.units === 'metric', sex: OB.sex, cm: OB.hu === 'cm' ? +OB.cm : (+OB.ft * 12 + (+OB.inch || 0)) * 2.54 }; },
        est => { OB.est = est; $('obLb').value = OB.units === 'metric' ? Math.round(est.mid * KG * 10) / 10 : est.mid; OB.lb = $('obLb').value; replay($('obLb'), 'fade-in'); });
      replay($('obEst'), 'fade-in'); };
    $('obNext').onclick = () => {
      keep();
      const toLb = v => OB.units === 'metric' ? v / KG : v;
      const cm = OB.hu === 'cm' ? +OB.cm : (+OB.ft * 12 + (+OB.inch || 0)) * 2.54, lb = toLb(+OB.lb), age = +OB.age, g = toLb(+OB.goalLb);
      const err = m => { $('obErr').textContent = m; $('obErr').hidden = false; };
      if (!(age >= 14 && age <= 100)) return err('Enter your age.');
      if (!(cm >= 120 && cm <= 230)) return err('Enter your height.');
      const unitName = OB.units === 'metric' ? 'kilograms' : 'pounds';
      if (!(lb >= 80 && lb <= 600)) return err(`Enter your current weight in ${unitName}.`);
      if (OB.goal !== 'maintain' && !(g >= 80 && g <= 600)) return err(`Enter your goal weight in ${unitName}.`);
      if (OB.goal === 'lose' && g >= lb) return err('For fat loss, your goal weight should be below your current weight.');
      if (OB.goal === 'gain' && g <= lb) return err('To build, your goal weight should be above your current weight.');
      OB.calc = suggestTargets(cm, lb, age, g);
      showOnboarding(3);
    };
  }
  if (step === 3) {
    const c = OB.calc;
    b.innerHTML = `<div class="ob-step"><span class="ob-n">Step 2 of 2</span><h2>Your starting targets</h2>
        <p class="hint">Based on an estimated burn of about ${c.tdee.toLocaleString()} kcal a day. Adjust anything you like.</p>
        ${estUsed() ? `<p class="est-note">Your weight is an estimate, so treat these as a starting point. Weigh in once in the next two weeks (a pharmacy, gym or a friend's scale) and log it; the app will remind you.</p>` : ''}</div>
      <div class="ob-sum"><div><span class="num">${c.lo.toLocaleString()}–${c.hi.toLocaleString()}</span><small>kcal a day</small></div><div class="pro"><span class="num">${c.pro}g</span><small>protein</small></div></div>
      <div class="ob-form grid2">
        <label>Calories low<input id="obLo" type="number" inputmode="numeric" value="${c.lo}"></label>
        <label>Calories high<input id="obHi" type="number" inputmode="numeric" value="${c.hi}"></label>
        <label>Protein (g)<input id="obPro" type="number" inputmode="numeric" value="${c.pro}"></label>
        <label>Goal weight (${OB.units === 'metric' ? 'kg' : 'lb'})<input id="obG" type="number" inputmode="decimal" step="0.1" value="${c.goalShown}"></label>
      </div>
      <p class="hint">${OB.goal === 'lose' ? `This aims for about ${OB.units === 'metric' ? '0.5–0.7 kg' : '1–1.5 lb'} a week. ` : OB.goal === 'gain' ? `This aims for a slow, lean gain of about ${OB.units === 'metric' ? '0.25 kg' : '0.5 lb'} a week. ` : ''}After two weeks of logging, the "Your real burn" card on Trends works out your actual burn from your own data and can fine-tune these.</p>
      <p class="err" id="obErr" hidden></p>
      <div class="ob-actions"><button class="btn" id="obDone">Start logging</button><button class="btn ghost" id="obBack">Back</button></div>`;
    $('obBack').onclick = () => showOnboarding(2);
    $('obDone').onclick = () => {
      const lo = +$('obLo').value, hi = +$('obHi').value, pr = +$('obPro').value, g = OB.units === 'metric' ? Math.round(+$('obG').value / KG * 100) / 100 : r1(+$('obG').value);
      if (!(lo > 0 && hi >= lo && pr > 0 && g > 0)) { $('obErr').textContent = 'Check the numbers: the low calories must be below the high.'; $('obErr').hidden = false; return; }
      S.targets = { calLo: lo, calHi: hi, protein: pr, goal: g, mode: OB.goal };
      S.units = OB.units || 'imperial';
      const guessed = estUsed();
      S.name = (OB.name || '').slice(0, 30); S.startWeight = guessed ? null : rW(OB.calc.lbNow); S.scale = OB.scale || 'daily';
      if (guessed) saveEst(OB.est); else clearEst();     // an estimate is never a starting weight (milestones count from a real weigh-in)
      S.onboarded = true; S.msInit = true; if (!Sync.user) S.metaUnsynced = true;
      touchMeta(); hideOnboarding(); renderAll(); haptic();
      const hi5 = S.name ? `, ${S.name}` : '';
      setTimeout(() => toast(Sync.user || !window.FIREBASE_CONFIG?.apiKey ? `You're set${hi5}. Log your first food.` : `You're set${hi5}. Tap the pill to sync.`), 400);
    };
  }
  replay(b, 'swap-in'); $('onboard').scrollTop = 0;
}
function suggestTargets(cm, lb, age, goalLb) {
  const tdee = mifflinTdee(OB.sex, age, cm, lb, OB.act), floor = OB.sex === 'male' ? 1500 : 1200;
  let lo, hi;
  if (OB.goal === 'lose') { lo = tdee - 750; hi = tdee - 500; }
  else if (OB.goal === 'gain') { lo = tdee + 200; hi = tdee + 400; }
  else { lo = tdee - 150; hi = tdee + 150; }
  lo = Math.max(floor, Math.round(lo / 50) * 50); hi = Math.max(lo + 100, Math.round(hi / 50) * 50);
  const goal = OB.goal === 'maintain' ? lb : goalLb;          // in lb
  const pro = Math.min(250, Math.max(90, Math.round((OB.goal === 'lose' ? goal : lb) * 0.8 / 5) * 5));
  const shown = v => String(Math.round((OB.units === 'metric' ? v * KG : v) * 10) / 10);
  return { tdee, lo, hi, pro, goal, goalShown: shown(goal), lbNow: lb };
}
function hideOnboarding() {
  const o = $('onboard'); if (o.hidden) return;
  o.classList.remove('in'); setTimeout(() => { o.hidden = true; }, 380);
}

/* =================== GOAL SUGGESTIONS (inside the Goal edit form) ===================
   Once Trends has about 2 weeks of data, suggestions come from your real burn.
   Before that, 4 quick answers (sex, age, height, activity) give an estimate.
   Those answers live in memory for this visit only and are never saved or synced. */
const GS = { sex: 'male', age: '', ft: '', inch: '', cm: '', lb: '', act: 'active', open: false, calc: null };
const GOAL_DELTA = { lose: [-750, -500], maintain: [-150, 150], gain: [200, 400] };
function mifflinTdee(sex, age, cm, lb, act) {
  const kg = lb * 0.4536, f = ACTS.find(a => a[0] === act)[3];
  const bmr = 10 * kg + 6.25 * cm - 5 * age + (sex === 'male' ? 5 : -161);
  return Math.round(bmr * f / 50) * 50;
}
function loggedLb() {                 // best guess at today's weight from what's logged (lb)
  const n = trendNow(); if (n != null) return n;
  const t = todayIso(), recent = weightsArr().filter(w => w.date >= shift(t, -30) && w.date <= t);
  if (recent.length) return recent[recent.length - 1].lb;
  return S.startWeight ?? null;
}
const currentLb = () => loggedLb() ?? GS.lbLb ?? null;
const pendingMode = () => $('pMode').dataset.pending || mode();
function formGoalLb() { const v = parseFloat($('tGoal').value); return v > 0 ? fromW(v) : null; }
function goalSuggestion(m) {
  const e = estimateBurn();
  let burn, src, floor = 1200;
  if (e.ready) { burn = e.burn; src = 'burn'; }
  else if (GS.calc) { burn = GS.calc.tdee; src = 'formula'; floor = GS.calc.sex === 'male' ? 1500 : 1200; }
  else return null;
  const [dLo, dHi] = GOAL_DELTA[m];
  const lo = Math.max(floor, r50(burn + dLo)), hi = Math.max(lo + 100, r50(burn + dHi));
  return { burn, src, lo, hi };
}
function suggestPro(m, cur, goal) {
  const base = m === 'lose' && goal ? goal : cur;
  return base ? Math.min(250, Math.max(90, Math.round(base * 0.8 / 5) * 5)) : null;
}
function roughDate(d) {
  const n = d.getDate(), mo = d.toLocaleDateString(undefined, { month: 'long' });
  const far = (d - new Date()) / 864e5 > 300 ? ` ${d.getFullYear()}` : '';
  return (n <= 10 ? `early ${mo}` : n <= 20 ? `mid-${mo}` : `late ${mo}`) + far;
}
function goalEta(m, cur, goal, sug) {
  if (m === 'maintain') return cur ? `This should hold your weight steady around ${fWs(cur)} ${wU()}.` : '';
  if (cur == null || !goal) return '';
  if (m === 'lose' ? goal >= cur : goal <= cur) return '';
  const perWeek = Math.abs(sug.burn - (sug.lo + sug.hi) / 2) * 7 / KCAL_PER_LB;   // lb a week
  if (perWeek < 0.05) return '';
  const d = new Date(); d.setDate(d.getDate() + Math.round(Math.abs(cur - goal) / perWeek * 7));
  return `At about ${fW(perWeek)} ${wU()} a week, you'd reach ${fWs(goal)} ${wU()} around ${roughDate(d)}.`;
}
function goalWarning(m, cur, goal) {
  if (cur == null || !goal) return '';
  const c = `${fWs(cur)} ${wU()}`;
  if (m === 'lose' && goal >= cur) return `Your goal weight isn't below your current weight (about ${c}). For Cutting, set a lower goal.`;
  if (m === 'gain' && goal <= cur) return `Your goal weight isn't above your current weight (about ${c}). For Building, set a higher goal.`;
  if (m === 'maintain' && Math.abs(goal - cur) > 5) return `Maintaining holds you near your current weight (about ${c}), but your goal is ${fW(Math.abs(goal - cur))} ${wU()} away. Set it close to ${c}, or pick ${goal < cur ? 'Cutting' : 'Building'}.`;
  return '';
}
function renderGoalSuggest() {
  const box = $('gSug'); if (!box || $('goalForm').hidden) return;
  const m = pendingMode(), cur = currentLb(), goal = formGoalLb();
  const w = goalWarning(m, cur, goal); $('gWarn').textContent = w; $('gWarn').hidden = !w;
  const sug = goalSuggestion(m);
  const head = `<div class="gsug-h"><b>Suggested for ${MODES[m]}</b>${sug ? `<span class="gsug-src${sug.src === 'burn' ? ' ok' : ''}">${sug.src === 'burn' ? 'Real burn' : 'Estimate'}</span>` : ''}</div>`;
  if (!sug && !GS.open) {
    box.innerHTML = `${head}<p class="hint">Your real burn on Trends takes about 2 weeks of logging. Until then, answer 4 quick questions for an estimate. Nothing is saved.</p>
      <button type="button" class="btn ghost" id="gsAsk">Suggest targets for me</button>`;
    $('gsAsk').onclick = () => { GS.open = true; haptic(); renderGoalSuggest(); replay($('gSug'), 'fade-in'); };
    return;
  }
  if (!sug) {
    const needW = loggedLb() == null;
    const hIn = metric() ? `<input id="gsCm" type="number" inputmode="decimal" placeholder="cm" value="${esc(GS.cm)}" aria-label="Height in centimetres">`
      : `<div class="grid2"><input id="gsFt" type="number" inputmode="numeric" placeholder="ft" value="${esc(GS.ft)}" aria-label="Feet"><input id="gsIn" type="number" inputmode="decimal" placeholder="in" value="${esc(GS.inch)}" aria-label="Inches"></div>`;
    box.innerHTML = `${head}<p class="hint">Used once for this estimate and not saved.</p>
      <div class="gsug-q">
        <label>Sex (for the calorie formula)${obSeg('gsSex', [['male', 'Male'], ['female', 'Female']], GS.sex)}</label>
        <label>Age<input id="gsAge" type="number" inputmode="numeric" min="14" max="100" value="${esc(GS.age)}" placeholder="e.g. 27"></label>
        <label>Height${hIn}</label>
        ${needW ? `<label>Current weight (${wU()})<input id="gsLb" type="number" inputmode="decimal" step="0.1" value="${esc(GS.lb)}" placeholder="${metric() ? 'e.g. 84' : 'e.g. 185'}"></label>
          <button type="button" class="linkbtn est-open" id="gsEstBtn">Don't know your weight? Estimate it</button><div id="gsEst" hidden></div>` : ''}
        <div class="ob-label">How active are you?</div>
        <div class="ob-cards" id="gsAct">${ACTS.map(([v, t, s]) => `<button type="button" class="ob-card" data-v="${v}" aria-pressed="${v === GS.act}"><strong>${t}</strong><span>${s}</span></button>`).join('')}</div>
        <p class="err" id="gsErr" hidden></p>
        <button type="button" class="btn" id="gsGo">Show my suggestion</button>
      </div>`;
    const keep = { gsAge: 'age', gsCm: 'cm', gsFt: 'ft', gsIn: 'inch', gsLb: 'lb' };   // typed answers survive a redraw
    Object.entries(keep).forEach(([id, k]) => { if ($(id)) $(id).oninput = () => { GS[k] = $(id).value; }; });
    const seg = (id, k) => $(id).onclick = e => { const t = e.target.closest('[data-v]'); if (!t) return; GS[k] = t.dataset.v; haptic();
      [...$(id).children].forEach(c => c.setAttribute('aria-pressed', c === t)); };
    seg('gsSex', 'sex'); seg('gsAct', 'act');
    if ($('gsEstBtn')) $('gsEstBtn').onclick = () => { haptic(); $('gsEstBtn').hidden = true; $('gsEst').hidden = false;
      estBox($('gsEst'), 'gs', () => ({ metric: metric(), sex: GS.sex, cm: metric() ? +GS.cm : (+GS.ft * 12 + (+GS.inch || 0)) * 2.54 }),
        est => { $('gsLb').value = metric() ? Math.round(est.mid * KG * 10) / 10 : est.mid; GS.lb = $('gsLb').value; saveEst(est); replay($('gsLb'), 'fade-in'); }); };
    $('gsGo').onclick = () => {
      const err = t => { $('gsErr').textContent = t; $('gsErr').hidden = false; };
      const age = +GS.age, cm = metric() ? +GS.cm : (+GS.ft * 12 + (+GS.inch || 0)) * 2.54;
      if (!(age >= 14 && age <= 100)) return err('Enter your age.');
      if (!(cm >= 120 && cm <= 230)) return err('Enter your height.');
      if (needW) { const lb = fromW(+GS.lb); if (!(lb >= 80 && lb <= 600)) return err(`Enter your current weight in ${metric() ? 'kilograms' : 'pounds'}.`); GS.lbLb = lb; }
      GS.calc = { tdee: mifflinTdee(GS.sex, age, cm, currentLb(), GS.act), sex: GS.sex };
      GS.open = false; haptic(); renderGoalSuggest(); replay($('gSug'), 'fade-in');
    };
    return;
  }
  const pro = suggestPro(m, cur, goal), eta = goalEta(m, cur, goal, sug);
  const L = +$('tLo').value, H = +$('tHi').value, P = +$('tPro').value, T = S.targets;
  const filled = L === sug.lo && H === sug.hi && (!pro || P >= pro);
  const saved = T.calLo === sug.lo && T.calHi === sug.hi && (!pro || T.protein >= pro) && m === mode();
  const src = sug.src === 'burn' ? `Worked out from your real burn of about ${r50(sug.burn).toLocaleString()} kcal a day over the last 4 weeks.`
    : `Based on an estimated burn of about ${sug.burn.toLocaleString()} kcal a day. Once Trends has about 2 weeks of your logging, your real burn takes over.`;
  box.innerHTML = `${head}
    <div class="gsug-n"><span>${sug.lo.toLocaleString()}–${sug.hi.toLocaleString()}<small>kcal</small></span>${pro ? `<span class="gsug-pro">${pro}g+<small>protein</small></span>` : ''}</div>
    ${eta ? `<p class="gsug-eta">${esc(eta)}</p>` : ''}
    <p class="hint">${src}</p>
    ${filled ? `<p class="gsug-ok">${saved ? 'Your targets already match this suggestion.' : 'Filled in below. Tap Save to keep them.'}</p>` : '<button type="button" class="btn ghost" id="gsUse">Use these</button>'}
    ${sug.src === 'formula' ? '<button type="button" class="linkbtn" id="gsRedo">Change my answers</button>' : ''}`;
  if ($('gsUse')) $('gsUse').onclick = () => {
    $('tLo').value = sug.lo; $('tHi').value = sug.hi;
    if (pro && !(+$('tPro').value >= pro)) $('tPro').value = pro;      // only ever raises protein
    haptic(); renderGoalSuggest(); replay($('tForm'), 'fade-in');
  };
  if ($('gsRedo')) $('gsRedo').onclick = () => { GS.calc = null; GS.open = true; renderGoalSuggest(); };
}
['tLo', 'tHi', 'tPro', 'tGoal'].forEach(id => $(id).addEventListener('input', renderGoalSuggest));

/* =================== v41: PROTEIN NUDGE, FIBRE, NUTRI-SCORE =================== */
/* Protein nudge: only on today, only when calories are well along and protein is clearly behind them.
   It disappears by itself once protein catches up, so a normal day never shows it. */
const FIB_LO = 25, FIB_HI = 38;          // general adult guideline range (g a day); nothing about the user is stored
function nudgeFor(cal, pro, T) {
  if (!(T.protein > 0) || pro >= T.protein) return null;
  const calFrac = cal / T.calHi, proFrac = pro / T.protein;
  if (calFrac < 0.5 || proFrac >= calFrac - 0.2) return null;
  const proLeft = Math.round(T.protein - pro), kLeft = Math.round(T.calHi - cal);
  const lead = `Protein is behind your calories: ${Math.round(pro)}g of ${T.protein}g with ${kc(cal)} of ${kc(T.calHi)} kcal used.`;
  if (kLeft < 100) return `${lead} Get some protein in if you're still eating, and put protein first at each meal tomorrow.`;
  if (proLeft / kLeft * 100 > 20) return `${lead} ${proLeft}g in ${kc(kLeft)} kcal is more than even lean foods can fit. Get what you can, and lead with protein tomorrow.`;
  return `${lead} The ${proLeft}g left needs to fit in ${kc(kLeft)} kcal: lean picks like chicken breast, egg whites, Greek yogurt or a shake.`;
}
function renderNudge() {
  const el = $('nudge'), es = entriesFor(day);
  const cal = es.reduce((a, e) => a + e.kcal, 0), pro = es.reduce((a, e) => a + e.pro, 0);
  const msg = day === todayIso() && es.length ? nudgeFor(cal, pro, S.targets) : null;
  const was = !el.hidden; el.hidden = !msg; if (!msg) return;
  el.textContent = msg; if (!was) replay(el, 'fade-in');
}
/* More nutrients on Today: fibre, counted only from foods that have fibre data, and saying how many that is */
function renderNut() {
  const box = $('nutBox'), es = entriesFor(day); box.hidden = !es.length; if (!es.length) return;
  const f = dayFib(day), g = Math.round(f.g);
  const any = f.known || f.part, pm = f.part > 1 ? `${f.part} meals` : 'a meal';
  $('nutSum').textContent = any ? `${f.known < f.total ? 'at least ' : ''}${g}g fibre` : 'no fibre data';
  const cover = f.known === f.total ? `From all ${f.total} food${f.total > 1 ? 's' : ''} logged.`
    : f.part ? `${f.known ? `From ${f.known} of ${f.total} foods, plus` : 'From'} the ingredients that have fibre data in ${pm}. Some ingredients don't have it yet, so the real total is higher.`
    : f.known ? `From ${f.known} of ${f.total} foods. The other ${f.total - f.known} ${f.total - f.known > 1 ? "don't" : "doesn't"} have fibre data, so the real total is higher.`
    : "None of these foods have fibre data yet. Scanned packaged foods and the built-in whole foods usually do.";
  $('nutBody').innerHTML = `<div class="nut-row"><span>Fibre</span><b>${any ? (f.known < f.total ? '≥ ' : '') + g + 'g' : '–'}</b></div>
    <div class="prog"><i style="width:${Math.round(Math.min(1, f.g / FIB_HI) * 100)}%"></i></div>
    <p class="hint">Most adults do well with about ${FIB_LO}–${FIB_HI}g a day. Fibre comes from vegetables, fruit, beans, oats and whole grains, and it helps keep you full. ${cover}</p>
    ${missingFibHtml(es)}`;
}
/* v46: which of the day's foods have no fibre data, and a one-tap way to add it for saved foods */
function missingFib(es) {
  const fix = new Map(), other = new Map();
  es.forEach(e => {
    if (entryFib(e) != null) return;
    const f = e.food, saved = f && S.foods.find(x => x.id === (f.cookOf || f.id));   // v61: a cooked entry's fix is its package
    if (saved) { fix.set(saved.id, saved); return; }
    const m = f?.source === 'meal' && S.meals.find(x => 'meal-' + x.id === f.id);
    if (m && m.items?.length) {   // v49: name the ingredients that hold the meal back, with the same one-tap fix
      const gaps = m.items.filter(it => itemFib(it) == null);
      gaps.forEach(it => { const s2 = S.foods.find(x => x.id === it.food.id);
        if (s2 && !hasFib(s2)) fix.set(s2.id, s2); else other.set('mi' + it.food.id, `${it.food.name} (in ${m.name})`); });
      if (gaps.length) return;
      other.set((f?.id || 'q') + e.name, `${e.name} (the meal has changed since this was logged)`); return;
    }
    other.set((f?.id || 'q') + e.name, `${e.name}${!f ? ' (quick add)' : f.source === 'meal' ? ' (meal: add fibre to its ingredients)' : ''}`);
  });
  return { fix: [...fix.values()], other: [...other.values()] };
}
function missingFibHtml(es) {
  const m = missingFib(es); if (!m.fix.length && !m.other.length) return '';
  return `<div class="nut-miss">
    ${m.fix.length ? `<span class="nut-miss-k">No fibre data yet. Tap one to add it from its label:</span>
      <div class="chips wrap" id="fibFix">${m.fix.map(f => `<button class="chip" data-fib="${esc(f.id)}">${esc(f.name)} <small>+ fibre</small></button>`).join('')}</div>` : ''}
    ${m.other.length ? `<p class="hint">${m.fix.length ? 'Also' : 'No fibre data'}: ${esc(m.other.join(', '))}.</p>` : ''}</div>`;
}
$('nutBody').addEventListener('click', e => { const b = e.target.closest('[data-fib]'); if (b) { haptic(); openAddFibre(b.dataset.fib); } });
/* add fibre to a saved food without touching its calories, so earlier entries of it start counting too */
function openAddFibre(id) {
  const f = S.foods.find(x => x.id === id); if (!f) return;
  const perServ = f.kcalServ != null || f.servingG;
  openSheet('Add fibre', `
    <div class="food-head"><strong>${esc(f.name)}</strong><span>${esc([f.brand, perLine(f)].filter(Boolean).join(' · '))}</span></div>
    <label>Fibre per ${perServ ? `serving${f.servingG ? ` (${esc(servLabel(f))})` : ''}` : '100 g'}, in grams<input id="afIn" type="number" inputmode="decimal" min="0" step="0.1" placeholder="e.g. 3"></label>
    <p class="hint">On the Nutrition Facts table it's the "Fibre / Fibres" line, just under Carbohydrate. Enter 0 if it says 0.</p>
    <button class="btn" id="afSave">Save fibre</button>`);
  setTimeout(() => $('afIn')?.focus(), 350);
  $('afSave').onclick = () => {
    const v = parseFloat($('afIn').value);
    if (!(v >= 0 && v < 100)) { toast('Enter the grams of fibre from the label.'); return; }
    if (perServ) { f.fibServ = v; if (f.servingG) f.fib100 = v / f.servingG * 100; } else f.fib100 = v;
    touchMeta(); renderTotals(); closeSheet(); haptic();
    toast(`Fibre added to ${f.name}. Earlier entries of it count now too.`);
  };
}

/* Trends fibre card: hidden until a day in the range has fibre data */
function renderFibChart(days) {
  const vals = days.map(d => { const f = dayFib(d); return f.known || f.part ? f.g : null; }), have = vals.filter(v => v != null);
  $('fibCard').hidden = !have.length; if (!have.length) return;
  let known = 0, total = 0; days.forEach(d => { const f = dayFib(d); known += f.known; total += f.total; });
  $('tFibAvg').textContent = `avg ${Math.round(have.reduce((a, b) => a + b, 0) / have.length)}g`;
  $('tFibChart').innerHTML = barChart(days, vals, { lo: FIB_LO, hi: FIB_HI, ticks: [10, 20, 30, 40, 50, 60], label: 'Daily fibre',
    colorFor: v => v >= FIB_LO ? 'var(--protein)' : 'var(--accent)' });
  $('tFibNote').textContent = `Green band is the ${FIB_LO}–${FIB_HI}g most adults aim for. Counted from ${known} of ${total} foods logged in this range that have fibre data${known < total ? ', so real totals are higher' : ''}.`;
}

/* =================== v44: HOW TO USE CUT LOG =================== */
/* A plain-language guide in the You tab (and a one-time banner on Today for new people). Seen/first-shown live on
   this device only (localStorage cutlog.guide), not in saved or synced data. */
const GUIDE = [
  ['Getting started', `
    <p>Put Cut Log on your home screen: in Safari, tap Share, then <b>Add to Home Screen</b>. It works offline and saves everything on your phone first.</p>
    <p>Your goal and daily targets (a calorie range and a protein target) are in <b>You → Goal</b>. Change them any time.</p>
    <p>To back up and sync with a laptop, tap the pill at the top right and sign in. Syncing works once your email has been added to the invite list, so ask the person who shared the app. Until then, everything still works on your phone.</p>`],
  ['Logging food', `
    <p><b>Scan barcode</b> for packaged food. If it isn't in the free database, snap the label once and the app remembers that barcode next time.</p>
    <p><b>Snap label</b> reads a Nutrition Facts photo on your phone. Check the numbers it found before saving.</p>
    <p><b>Search</b> covers whole foods, Nigerian and Canadian dishes, your saved foods, and packaged foods online. Nothing fits? Use <b>Enter a food by hand</b>, or <b>Quick add</b> for just calories and protein (good for samples or a meal out).</p>
    <p>On <b>How much?</b> pick an amount in pieces, servings, grams, cups or spoons. No scale? Use your hand: a <b>palm</b> of meat (about 100 g), a <b>fist</b> of rice or pasta (about a cup), a <b>cupped hand</b> of snacks, a <b>thumb</b> of oil or peanut butter. Dishes come in <b>small, regular and large</b> plates or bowls, with a picture guide.</p>
    <p>Staples like chicken, rice and pasta have a <b>Raw weight / Cooked</b> switch: pick how it was when you measured it. Your own packs of chicken, beef, fish, rice, pasta and oats get it too: the package numbers are for raw or dry food, and Cooked works out what they come to after cooking (it opens cooked next time if that's how you logged it last). Food you cook yourself asks <b>Cooked with oil or butter?</b> Oil is the most common hidden source of calories.</p>
    <p>Packaged foods may show a <b>Nutri-Score</b> letter from A (most nutritious) to E (least).</p>
    <p>Food is grouped into Breakfast, Lunch, Dinner and Snacks, and the app learns where you usually put each food. <b>Tap any entry</b> to change the amount, move it to another meal or day, or remove it (with Undo). <b>Copy from yesterday</b> repeats a whole day or one meal.</p>`],
  ['My meals', `
    <p>Build a meal once from its ingredients and log it with one tap after that. Set how many servings it makes.</p>
    <p>Cooking a big pot? Weigh the whole pot once it's cooked (without the pot) and enter the <b>cooked weight</b>. Then log whatever you dish out by grams or by hand portion.</p>
    <p>If the app closes while you're building a meal, it keeps your progress. My meals shows <b>Finish your unsaved meal</b>.</p>`],
  ['The Today screen', `
    <p>The left ring is calories, with a small mark where your range starts. The right ring is protein.</p>
    <p>Below the rings: how your day is going, a <b>protein nudge</b> if protein falls behind your calories, <b>What fits</b> (foods from your own list that fit what's left) and <b>This week</b> (calories banked or over across the week, and how much you can eat today and stay on budget). Only days you logged count; days with nothing logged are named underneath so you know they're left out.</p>
    <p>Open This week and tap <b>See past weeks and months</b> for your <b>History</b>: a calendar of each month with every day's calories (green in range, orange over, blue under), what each week banked, and every month's averages. Swipe it for other months, and tap a day to open it.</p>
    <p><b>More nutrients</b>, under your food list, shows fibre. It only counts foods that have fibre data, so it says "at least" when some don't. A meal counts the ingredients that have it. Foods missing it are listed there; tap one to add the number from its label.</p>`],
  ['Weigh-ins and waist', `
    <p>Pick <b>Every morning</b>, <b>Once a week</b> or <b>No scale</b> in You → Weigh-ins. Weigh after the bathroom, before food or water.</p>
    <p>Daily weight jumps around by a few pounds from water, salt and carbs. The <b>7-day average</b> is the number that matters.</p>
    <p>Don't know your weight and no scale? In setup (or in Goal suggestions) tap <b>Don't know your weight? Estimate it</b>. It's a rough guess from your clothing sizes (a formula built from 507 measured adults), used only for your starting targets. After two weeks the app asks for one real weigh-in, at a pharmacy, gym or a friend's place.</p>
    <p>Tap the weight chart, or <b>See full weight history</b>, to see every weigh-in back to your first: 1 month to all time, your goal line, monthly averages, and drag along the chart to read any day.</p>
    <p>Measure your <b>waist</b> at the belly button, relaxed, every two weeks. A shrinking waist is one of the clearest signs of fat loss, and it works without a scale.</p>`],
  ['Trends', `
    <p><b>Weight trend</b> shows how fast you're losing or gaining each week, and the date you'd reach your goal. It appears after about a week of weigh-ins.</p>
    <p>The <b>weekly check-in</b> sums up last week every Monday: average calories and protein, weight change, and a one-line verdict.</p>
    <p><b>Your real burn</b> works out how many calories you actually burn from what you eat and how your weight moves. It takes about two weeks of logging and weighing in, then it can suggest better targets.</p>
    <p>Charts for calories, protein and fibre: tap a bar to open that day. <b>See calendar by month</b> under Calories opens your History. Plus consistency stats and <b>milestones</b> with a little celebration.</p>`],
  ['Your settings', `
    <p>In <b>You</b>: your name, goal (Cutting, Maintaining or Building) with suggested targets, weigh-in frequency, lb or kg, eight app colours (Cobalt, Ember, Teal, Violet, Rose, Gold, Graphite, Sky), Light or Dark, your saved foods, and a backup file you can keep in iCloud Drive.</p>
    <p>Your age, height and sex are only used to suggest targets. They're never saved.</p>`],
  ['What to expect', `
    <p><b>First week:</b> your weight will bounce around. That's water, not fat. Keep logging and weighing.</p>
    <p><b>After about a week:</b> your weekly rate and goal date show up on Trends.</p>
    <p><b>After about two weeks:</b> your real burn is ready and can fine-tune your targets.</p>
    <p>Hand portions, plate sizes and dishes are estimates. Being consistent matters more than being exact, because your real burn adjusts to how you log.</p>
    <p>A steady cut is about 0.5–1% of your body weight a week. Hitting your protein target most days helps keep muscle while you lose fat.</p>
    <p>A day over your range is fine. The weekly trend decides your progress.</p>`],
];
const GUIDE_KEY = 'cutlog.guide', GUIDE_DAYS = 7;
function guideState() { try { return JSON.parse(localStorage.getItem(GUIDE_KEY)) || {}; } catch (e) { return {}; } }
function setGuide(x) { try { localStorage.setItem(GUIDE_KEY, JSON.stringify({ ...guideState(), ...x })); } catch (e) {} }
function openGuide() {
  setGuide({ seen: 1 }); $('guideBanner').hidden = true;
  openSheet('How to use Cut Log', `<p class="hint">Tap a topic to open it.</p>
    <div class="guide">${GUIDE.map(([t, h], i) => `<details class="guide-s"${i === 0 ? ' open' : ''}><summary>${t}</summary><div class="guide-b">${h}</div></details>`).join('')}</div>`);
}
/* Banner on Today: once per device, until the guide is opened, for up to a week */
function renderGuideBanner() {
  const b = $('guideBanner'); if (!b) return;
  const g = guideState();
  if (!g.seen && !g.first && S.onboarded) setGuide({ first: Date.now() });
  const first = guideState().first;
  b.hidden = !!g.seen || !S.onboarded || day !== todayIso() || !first || Date.now() - first > GUIDE_DAYS * 864e5;
}
$('guideBtn').onclick = () => { haptic(); openGuide(); };
$('guideBanner').onclick = () => { haptic(); openGuide(); };

/* =================== v45/v46: WEIGHT ESTIMATE WITHOUT A SCALE ===================
   A rough range from height and clothing sizes, only used to set starting targets: never saved as a weigh-in or a starting
   weight. v46 replaced the v45 rules of thumb with formulas fitted to real measured people:
   - Data: Heinz et al. (2003), "Exploring Relationships in Body Dimensions", Journal of Statistics Education 11(2):
     507 physically active adults (247 men, 260 women, ages 18-67, median 27) with measured weight, height and girths.
   - Clothing size -> body measurement: women's numeric sizes from ASTM D5585-11e1 (misses, straight figure: waist, hip);
     tops from Nike's published size charts (men's chest, women's bust; men's XS and women's 3XL extended by one step).
   - Each person's real measurements were turned into the size they'd buy, and weight was fitted (least squares, per sex)
     on height + those sizes, so the stated error includes the coarseness of sizes. 10-fold cross-validated error below.
   - "Do you lift?": average gap between real and predicted weight by muscularity (flexed arm girth / waist) in the same data:
     men -4 / +1.5 / +7 lb, women -1.5 / 0 / +3 lb for No / A bit / Yes. Very muscular lifters can be heavier still,
     so "Yes" widens the top of the range by the study's top-10% gap (men +10 lb). */
const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const TOP_IN = { male: [33.5, 36, 39.25, 42.5, 46.25, 51, 55.75], female: [31, 34, 36.75, 39.5, 42.75, 46.5, 50.5] };   // chart midpoints, inches
const ASTM_NUM = { '00': [25.375, 33.25], '0': [26.125, 33.875], '2': [26.875, 35.125], '4': [27.625, 36.375], '6': [28.5, 37.5], '8': [29.5, 38.5],
  '10': [30.5, 39.5], '12': [32.25, 41], '14': [34, 42.5], '16': [36, 44.25], '18': [38.25, 46], '20': [40.5, 48] };   // waist, hip inches
const NUM_ORDER = ['00', '0', '2', '4', '6', '8', '10', '12', '14', '16', '18', '20'];   // object keys like '2' sort before '00', so keep the order here
const EST_MODEL = {                          // kg = b0 + b1*height_cm + ...girths in cm; p80 = 80% of people within ± (lb)
  male: { both: { b: [-98.519, 0.5654, 0.05172, 0.83748], p80: 13 }, waist: { b: [-95.43217, 0.56772, 0.85935], p80: 13 }, top: { b: [-80.35437, 0.74446, 0.25311], p80: 23 } },
  female: { both: { b: [-101.66441, 0.36639, 0.23856, 1.07057, 0.04444], p80: 8 }, num: { b: [-96.33003, 0.37187, 1.24826, 0.06026], p80: 8 }, top: { b: [-103.98038, 0.4308, 1.08713], p80: 14 } },
};
const BUILD_ADJ = { male: { no: -4, bit: 1.5, yes: 7, yesTop: 10 }, female: { no: -1.5, bit: 0, yes: 3, yesTop: 3 } };   // lb
/* women's jeans sold by waist inches -> nearest ASTM numeric size by waist */
const numFromWaist = w => Object.keys(ASTM_NUM).reduce((a, k) => Math.abs(ASTM_NUM[k][0] - w) < Math.abs(ASTM_NUM[a][0] - w) ? k : a, '8');
function estimateWeight({ cm, sex, top, waistIn, num, build }) {
  if (!(cm >= 120 && cm <= 230)) return null;
  const sx = sex === 'female' ? 'female' : 'male', IN = 2.54, ti = SIZES.indexOf(top), M = EST_MODEL[sx];
  const topCm = ti >= 0 ? TOP_IN[sx][ti] * IN : null;
  let kg, p80;
  if (sx === 'male') {
    const w = waistIn >= 20 && waistIn <= 70 ? Math.round(waistIn) * IN : null;
    if (topCm && w) { const b = M.both.b; kg = b[0] + b[1] * cm + b[2] * topCm + b[3] * w; p80 = M.both.p80; }
    else if (w) { const b = M.waist.b; kg = b[0] + b[1] * cm + b[2] * w; p80 = M.waist.p80; }
    else if (topCm) { const b = M.top.b; kg = b[0] + b[1] * cm + b[2] * topCm; p80 = M.top.p80; }
    else return null;
  } else {
    const n = ASTM_NUM[num] ? num : waistIn >= 20 && waistIn <= 50 ? numFromWaist(waistIn) : null;
    const nw = n ? ASTM_NUM[n][0] * IN : null, nh = n ? ASTM_NUM[n][1] * IN : null;
    if (topCm && n) { const b = M.both.b; kg = b[0] + b[1] * cm + b[2] * topCm + b[3] * nw + b[4] * nh; p80 = M.both.p80; }
    else if (n) { const b = M.num.b; kg = b[0] + b[1] * cm + b[2] * nw + b[3] * nh; p80 = M.num.p80; }
    else if (topCm) { const b = M.top.b; kg = b[0] + b[1] * cm + b[2] * topCm; p80 = M.top.p80; }
    else return null;
  }
  const adj = BUILD_ADJ[sx], bd = adj[build] != null ? build : 'no';
  const mid = kg / KG + adj[bd], r5 = x => Math.round(x / 5) * 5;
  const lo = Math.max(80, r5(mid - p80)), hi = r5(mid + p80 + (bd === 'yes' ? adj.yesTop : 0));
  return { lo, hi, mid: Math.max(80, r5(mid)), beyond: mid > 250 };       // the study's heaviest person was 256 lb
}
/* the "Estimate my weight" panel, shared by setup and Goal suggestions. ctx() gives {metric, sex, cm}; done(est) fills the weight box */
function estBox(el, p, ctx, done) {
  const st = { top: null, num: null, build: 'no' }, c0 = ctx(), fem = c0.sex === 'female';
  el.innerHTML = `<div class="est">
    <p class="hint">A rough guess from your clothing sizes, using a formula built from 507 measured adults. It's only used for your starting targets. For most people it lands within about ${fem ? (c0.metric ? '4 kg' : '8 lb') : (c0.metric ? '6 kg' : '13 lb')}, so weigh in once when you can.</p>
    <div class="ob-label">Your usual ${fem ? 'top' : 'shirt'} size</div>
    <div class="chips wrap" id="${p}Shirt">${SIZES.map(z => `<button type="button" class="chip" data-z="${z}" aria-pressed="false">${z}</button>`).join('')}</div>
    ${fem ? `<div class="ob-label">Pants size, if you know it</div>
      <div class="chips wrap" id="${p}Num">${NUM_ORDER.map(z => `<button type="button" class="chip" data-n="${z}" aria-pressed="false">${z}</button>`).join('')}</div>
      <label>Or jeans sold by waist (${c0.metric ? 'cm' : 'inches, like 28'})<input id="${p}Waist" type="number" inputmode="decimal" placeholder="${c0.metric ? 'e.g. 71' : 'e.g. 28'}"></label>`
    : `<label>Jeans waist size, optional (${c0.metric ? 'cm' : 'the inches number, like 34'})<input id="${p}Waist" type="number" inputmode="decimal" placeholder="${c0.metric ? 'e.g. 86' : 'e.g. 34'}"></label>`}
    <div class="ob-label">Do you lift, or have a muscular build?</div>
    ${obSeg(p + 'Build', [['no', 'No'], ['bit', 'A bit'], ['yes', 'Yes']], 'no')}
    <p class="err" id="${p}EErr" hidden></p>
    <button type="button" class="btn ghost" id="${p}EGo">Estimate my weight</button>
    <p class="est-out" id="${p}EOut" hidden></p></div>`;
  const chipRow = (id, key, attr) => { if ($(id)) $(id).onclick = e => { const b = e.target.closest(`[data-${attr}]`); if (!b) return; haptic(); st[key] = st[key] === b.dataset[attr] ? null : b.dataset[attr];
    [...$(id).children].forEach(x => x.setAttribute('aria-pressed', x.dataset[attr] === st[key])); }; };
  chipRow(p + 'Shirt', 'top', 'z'); chipRow(p + 'Num', 'num', 'n');
  $(p + 'Build').onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; haptic(); st.build = b.dataset.v;
    [...$(p + 'Build').children].forEach(x => x.setAttribute('aria-pressed', x === b)); };
  $(p + 'EGo').onclick = () => {
    const c = ctx(), err = t => { $(p + 'EErr').textContent = t; $(p + 'EErr').hidden = !t; };
    const w = parseFloat($(p + 'Waist').value), waistIn = w > 0 ? (c.metric ? w / 2.54 : w) : null;
    if (!(c.cm >= 120 && c.cm <= 230)) return err('Enter your height above first.');
    if (!st.top && !st.num && !waistIn) return err(fem ? 'Pick a top size or a pants size.' : 'Pick a shirt size or enter your jeans waist.');
    if (waistIn && !(waistIn >= 20 && waistIn <= (fem ? 50 : 70))) return err(c.metric ? 'Enter the waist in centimetres, like 86.' : 'Enter the inches number from your jeans, like 34.');
    err('');
    const est = estimateWeight({ cm: c.cm, sex: c.sex, top: st.top, waistIn, num: st.num, build: st.build });
    if (!est) return err(fem ? 'Pick a top size or a pants size.' : 'Pick a shirt size or enter your jeans waist.');
    const show = v => c.metric ? `${Math.round(v * KG)} kg` : `${v} lb`;
    $(p + 'EOut').textContent = `About ${show(est.lo).replace(/ (kg|lb)$/, '')}–${show(est.hi)}. We've put ${show(est.mid)} in your weight box. Change it if you know better.`
      + (st.build === 'yes' ? ' Very muscular people can weigh more than any size-based guess shows.' : '')
      + (est.beyond ? ' This is above the weights the formula was built from, so treat it as very rough.' : '');
    $(p + 'EOut').hidden = false; haptic(); done(est);
  };
}
const EST_KEY = 'cutlog.est', EST_DAYS = 14;
function loadEst() { try { return JSON.parse(localStorage.getItem(EST_KEY)); } catch (e) { return null; } }
function saveEst(e) { try { localStorage.setItem(EST_KEY, JSON.stringify({ at: Date.now(), lo: e.lo, hi: e.hi, mid: e.mid })); } catch (er) {} }
function clearEst() { try { localStorage.removeItem(EST_KEY); } catch (e) {} }
/* was the weight in setup the estimate (not typed over)? */
const estUsed = () => !!OB.est && !!OB.calc && Math.abs(OB.calc.lbNow - OB.est.mid) < 1;
/* Two weeks after an estimate, if there's still no weigh-in, Today asks for one real weigh-in */
function renderEstBanner() {
  const b = $('estBanner'); if (!b) return;
  const e = loadEst();
  if (e && weightsArr().length) { clearEst(); b.hidden = true; return; }     // a real weigh-in replaces the guess
  b.hidden = !e || !S.onboarded || day !== todayIso() || Date.now() - e.at < EST_DAYS * 864e5;
}
function openEstReminder() {
  const e = loadEst(); if (!e) return;
  const v = x => metric() ? `${Math.round(x * KG)} kg` : `${x} lb`;
  openSheet('Time for one real weigh-in', `
    <p>Your starting targets came from an estimate of about ${v(e.lo).replace(/ (kg|lb)$/, '')}–${v(e.hi)}. One real weigh-in makes your targets and your progress much more accurate.</p>
    <p class="hint">No scale at home? Pharmacies, gyms and some grocery stores have one, or borrow a friend's. Weigh in the morning if you can, before food.</p>
    <button class="btn" id="estLog">Log my weight</button>
    <button class="btn ghost" id="estLater">Remind me next week</button>`);
  $('estLog').onclick = () => {
    closeSheet(); showTab('today'); day = todayIso(); renderAll();
    if (scale() === 'none') $('haveScale').click();
    setTimeout(() => { $('wForm').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); $('wIn').focus(); }, 380);
  };
  $('estLater').onclick = () => {      // shows again in 7 days
    try { localStorage.setItem(EST_KEY, JSON.stringify({ ...e, at: Date.now() - (EST_DAYS - 7) * 864e5 })); } catch (er) {}
    closeSheet(); renderEstBanner(); toast("OK, I'll ask again next week"); };
}
$('estBanner').onclick = () => { haptic(); openEstReminder(); };

/* =================== v40: WEEK VIEW, CHECK-IN, WHAT FITS, MOVE DAY, APPEARANCE =================== */
const weekStart = d => shift(d, -((parseIso(d).getDay() + 6) % 7));     // weeks run Monday to Sunday
const kc = n => Math.round(n).toLocaleString();
const rangeTxt = (a, b) => { const A = parseIso(a), B = parseIso(b), f = { month: 'short', day: 'numeric' };
  return `${A.toLocaleDateString(undefined, f)}–${A.getMonth() === B.getMonth() ? B.getDate() : B.toLocaleDateString(undefined, f)}`; };

/* Weekly budget: finished days this week (today is still in progress, so it isn't counted) */
function weekStatus(d) {
  const T = S.targets, t = todayIso(), ws = weekStart(d), m = mode(), done = [];
  for (let i = 0; i < 7; i++) { const x = shift(ws, i); if (x >= t) break; const tt = dayTotals(x); if (tt) done.push(tt.kcal); }
  if (!done.length) return null;
  const sum = done.reduce((s, k) => s + k, 0), avg = sum / done.length;
  // cutting/maintaining: room under the top of the range; building: how far above the bottom
  const bank = m === 'gain' ? sum - T.calLo * done.length : T.calHi * done.length - sum;
  const current = ws === weekStart(t), left = current ? 7 - ((parseIso(t).getDay() + 6) % 7) : 0;   // days left including today
  return { ws, done: done.length, avg, bank, current, left, m };
}
/* v51: finished days this week with nothing logged (they aren't counted, so the line says so).
   Days before the first day anything was ever logged don't count as missing (a new user's first week). */
function weekMissing(w) {
  const t = todayIso(), first = Object.keys(S.log).filter(k => S.log[k] && S.log[k].length).sort()[0], out = [];
  for (let i = 0; i < 7; i++) { const x = shift(w.ws, i); if (x >= t) break; if (first && x < first) continue; if (!dayTotals(x)) out.push(x); }
  return out;
}
function wkOpen(v) { try { if (v === undefined) return localStorage.getItem('cutlog.wkOpen') === '1'; localStorage.setItem('cutlog.wkOpen', v ? '1' : '0'); } catch (e) { return false; } }
function renderWeek() {
  const el = $('wk'), w = weekStatus(day); el.hidden = !w; if (!w) return;
  const T = S.targets, good = w.bank >= 0, one = w.left === 1, live = w.current && w.left > 0;
  const span = one ? 'today' : `a day for the ${w.left} days left (including today)`;
  const short = one ? 'today' : `a day for ${w.left} days`;
  let v, s = `From ${w.done} day${w.done > 1 ? 's' : ''} logged, avg ${kc(w.avg)} kcal.`, line = '';
  if (w.m === 'gain') v = good ? `${kc(w.bank)} kcal above your minimum` : `${kc(-w.bank)} kcal short this week`;
  else v = good ? `${kc(w.bank)} kcal banked` : `${kc(-w.bank)} kcal over this week`;
  if (live && w.m !== 'gain' && good && w.bank >= 100) { const x = kc(T.calHi + w.bank / w.left);
    s += ` You can eat up to ${x} ${span} and stay on budget for the week.`; line = `Up to <b>${x}</b> ${short}`; }
  else if (live && w.m !== 'gain' && !good) { const aim = T.calHi + w.bank / w.left;
    if (aim >= T.calLo) { s += ` About ${kc(aim)} ${span} brings it back.`; line = `Aim for about <b>${kc(aim)}</b> ${short}`; }
    else { s += ' Aim for the low end of your range for the rest of the week.'; line = 'Low end of your range for the rest of the week'; } }
  else if (live && w.m === 'gain' && !good) { const x = kc(T.calLo - w.bank / w.left); s += ` About ${x} ${span} catches up.`; line = `About <b>${x}</b> ${short} catches up`; }
  if (!line) line = `avg <b>${kc(w.avg)}</b> kcal over ${w.done} day${w.done > 1 ? 's' : ''}`;
  const miss = weekMissing(w), names = miss.map(x => parseIso(x).toLocaleDateString(undefined, { weekday: 'short' }));
  const warn = miss.length ? `<span class="wk-dot" aria-hidden="true">·</span><span class="wk-warn">${miss.length} day${miss.length > 1 ? 's' : ''} not logged</span>` : '';
  // Mon-Sun strip: logged days with their calories, missing days flagged, today ringed, days ahead faint
  const t = todayIso(), first = Object.keys(S.log).filter(k => S.log[k] && S.log[k].length).sort()[0];
  const cells = Array.from({ length: 7 }, (_, i) => { const x = shift(w.ws, i), tt = dayTotals(x), d = parseIso(x);
    const cls = x === t ? 'now' : x > t ? 'ahead' : tt ? 'ok' : (first && x < first) ? 'pre' : 'miss';
    const n = cls === 'now' ? 'today' : tt ? kc(tt.kcal) : cls === 'miss' ? 'none' : '';
    return `<span class="wkc ${cls}" title="${esc(d.toLocaleDateString(undefined, { weekday: 'long' }))}"><i>${esc(d.toLocaleDateString(undefined, { weekday: 'narrow' }))}</i><b></b><em>${n}</em></span>`; }).join('');
  const m = miss.length ? `<p class="wk-s wk-m" id="wkMiss">${esc(names.join(', '))} not logged, so ${miss.length > 1 ? 'they’re' : 'it’s'} not counted.</p>` : '';
  el.innerHTML = `<details class="wkd" id="wkD"${wkOpen() ? ' open' : ''}><summary><span class="wk-k">${w.current ? 'This week' : 'That week'}</span><span class="wk-v ${good ? 'ok' : 'hi'}">${v}</span><svg class="wk-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg><span class="wk-line" id="wkLine"><span>${line}</span>${warn}</span></summary><div class="wk-body"><div class="wk-days" id="wkDays">${cells}</div><p class="wk-s">${esc(s)}</p>${m}<button class="wk-more" id="wkMore" type="button">See past weeks and months${CHEV_R}</button></div></details>`;
  $('wkMore').onclick = () => openHistory(ym(day));   // v55
  $('wkD').addEventListener('toggle', e => { wkOpen(e.target.open); if (e.target.open && typeof haptic === 'function') try { haptic(); } catch (x) {} });
}

/* =================== v55: HISTORY (calendar by month) AND FULL WEIGHT HISTORY ===================
   Two pages (panels) that only read what's already saved. Nothing new is stored: the month and range being looked at
   live in memory. History opens from This week ("See past weeks and months") and Trends → Calories; the weight page
   opens by tapping a weight chart (Today or Trends) or "See full weight history". */
const ym = d => d.slice(0, 7);
const monthName = (m, short) => parseIso(m + '-01').toLocaleDateString(undefined, short ? { month: 'short', year: 'numeric' } : { month: 'long', year: 'numeric' });
const addMonth = (m, n) => { const d = parseIso(m + '-01'); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 7); };
function monthDays(m) { const out = []; for (let x = m + '-01'; ym(x) === m; x = shift(x, 1)) out.push(x); return out; }
function firstLogDay() { return Object.keys(S.log).filter(k => S.log[k] && S.log[k].length).sort()[0] || null; }
function historyStart() { const a = [firstLogDay(), weightsArr()[0]?.date].filter(Boolean).sort()[0]; return ym(a && a < todayIso() ? a : todayIso()); }
const signed = (n, f = kc) => (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n));
/* a day's colour, same as the Trends calorie bars: over the range, in it, or under it */
function dayClass(x, tt, t, first) {
  if (x > t) return 'ahead';
  if (x === t) return 'now';
  if (tt) return tt.kcal > S.targets.calHi ? 'over' : tt.kcal >= S.targets.calLo ? 'ok' : 'under';
  return first && x >= first ? 'miss' : 'pre';
}
/* a month's numbers, from finished days only (today is still in progress) */
function monthStats(m) {
  const T = S.targets, t = todayIso(), first = firstLogDay(), days = monthDays(m).filter(x => x < t);
  const tots = days.map(dayTotals).filter(Boolean), n = tots.length, avg = k => n ? tots.reduce((a, x) => a + x[k], 0) / n : null;
  const ws = weightsArr().filter(w => ym(w.date) === m).map(w => w.lb);
  return { m, n, kcal: avg('kcal'), pro: avg('pro'), inRange: tots.filter(x => x.kcal >= T.calLo && x.kcal <= T.calHi).length,
    proHit: tots.filter(x => x.pro >= T.protein).length, miss: days.filter(x => first && x >= first && !dayTotals(x)).length,
    wavg: ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : null, weighs: ws.length, wlo: ws.length ? Math.min(...ws) : null, whi: ws.length ? Math.max(...ws) : null };
}
const monthList = () => { const out = [], s = historyStart(); for (let m = ym(todayIso()); m >= s; m = addMonth(m, -1)) out.push(m); return out; };
/* laptop: these two panels get a wider window. The class comes off when the panel closes (after it has faded) or is replaced. */
let wideTok = 0;
function wideSheet() {
  const tok = ++wideTok; sheetEl.classList.add('wide');
  return () => queueMicrotask(() => { if (wideTok !== tok) return; if (SH.open) sheetEl.classList.remove('wide');
    else setTimeout(() => { if (wideTok === tok && !SH.open) sheetEl.classList.remove('wide'); }, 380); });
}
const CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>', CHEV_R = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

/* ---- History: a calendar for one month, with each week's bank, and every month listed underneath ---- */
const HS = { m: null };
function openHistory(m) {
  HS.m = m && m >= historyStart() && m <= ym(todayIso()) ? m : ym(todayIso());
  openSheet('History', '<div class="hs" id="hsWrap"></div>', wideSheet());
  renderHistory();
  sheetBody.onclick = e => {
    const d = e.target.closest('[data-hd]'), mm = e.target.closest('[data-hm]'), nav = e.target.closest('[data-hn]');
    if (d && !d.disabled) { if (HS.swiped) return; closeSheet(); day = d.dataset.hd; showTab('today'); renderAll(); return; }
    if (mm) { HS.m = mm.dataset.hm; haptic(); renderHistory(); sheetBody.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' }); return; }
    if (nav && !nav.disabled) historyMove(+nav.dataset.hn);
  };
}
function historyMove(n) {
  const m = addMonth(HS.m, n); if (m < historyStart() || m > ym(todayIso())) return;
  HS.m = m; haptic(); renderHistory(n);
}
function historyCal(m) {
  const T = S.targets, t = todayIso(), first = firstLogDay(), days = monthDays(m), last = days[days.length - 1];
  let h = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(x => `<span class="hs-dh" aria-hidden="true">${x}</span>`).join('') + '<span class="hs-dh hs-dw" aria-hidden="true">Week</span>';
  for (let w = weekStart(days[0]); w <= last; w = shift(w, 7)) {
    for (let i = 0; i < 7; i++) {
      const x = shift(w, i); if (ym(x) !== m) { h += '<span class="hc out"></span>'; continue; }
      const tt = dayTotals(x), c = dayClass(x, tt, t, first), pro = tt && tt.pro >= T.protein, dt = parseIso(x);
      const say = `${dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}: ${tt ? `${kc(tt.kcal)} kcal, ${Math.round(tt.pro)}g protein` : c === 'miss' ? 'not logged' : 'nothing logged'}`;
      h += `<button class="hc ${c}" data-hd="${x}"${c === 'ahead' ? ' disabled' : ''} aria-label="${esc(say)}"><i>${dt.getDate()}</i><em>${tt ? kc(tt.kcal) : c === 'miss' ? '–' : ''}</em><s${pro ? ' class="on"' : ''}></s></button>`;
    }
    const st = w < t ? weekStatus(w) : null;   // the week's finished, logged days, measured like This week
    h += st ? `<span class="hw ${st.bank >= 0 ? 'ok' : 'hi'}" title="${st.bank >= 0 ? (st.m === 'gain' ? 'Above your minimum' : 'Banked') : (st.m === 'gain' ? 'Short' : 'Over')} that week">${signed(st.bank)}</span>` : '<span class="hw"></span>';
  }
  return h;
}
function renderHistory(dir) {
  const box = $('hsWrap'); if (!box) return;
  const m = HS.m, s = monthStats(m), prev = monthStats(addMonth(m, -1)), T = S.targets, cur = m === ym(todayIso());
  const wch = s.wavg != null && prev.wavg != null ? s.wavg - prev.wavg : null;
  const tile = (v, k, id) => `<div${id ? ` id="${id}"` : ''}><span class="v">${v}</span><span class="k">${k}</span></div>`;
  const note = s.n ? `${s.n} day${s.n > 1 ? 's' : ''} logged${s.miss ? `, ${s.miss} not logged` : ''}${cur ? ' so far (today isn’t counted until it’s over)' : ''}. Protein target hit on ${s.proHit} of them.`
    : cur ? 'Nothing logged yet this month (today isn’t counted until it’s over).' : 'Nothing logged this month.';
  const rows = monthList().map(x => { const a = monthStats(x), b = monthStats(addMonth(x, -1)), d = a.wavg != null && b.wavg != null ? a.wavg - b.wavg : null;
    const sub = a.n ? `${a.n} day${a.n > 1 ? 's' : ''} · avg ${kc(a.kcal)} kcal · ${Math.round(a.pro)}g protein · ${a.inRange} in range` : 'No food logged';
    const right = a.wavg != null ? `<span class="r"><b>${fW(a.wavg)}</b><small class="${d == null ? '' : goodness(d)}">${d == null ? `avg ${wU()}` : `${signed(d, fW)} ${wU()}`}</small></span>` : '<span class="r"></span>';
    return `<button class="hm" data-hm="${x}"${x === m ? ' aria-current="true"' : ''}><b>${esc(monthName(x))}</b>${right}<small>${esc(sub)}</small></button>`; }).join('');
  box.innerHTML = `<div class="hs-nav"><button type="button" data-hn="-1" aria-label="Earlier month"${m <= historyStart() ? ' disabled' : ''}>${CHEV_L}</button><b id="hsMonth">${esc(monthName(m))}</b><button type="button" data-hn="1" aria-label="Later month"${cur ? ' disabled' : ''}>${CHEV_R}</button></div>`
    + `<div class="hs-sum" id="hsSum">${tile(s.kcal != null ? kc(s.kcal) : '–', 'avg kcal')}${tile(s.pro != null ? Math.round(s.pro) + '<small>g</small>' : '–', 'avg protein')}${tile(s.n ? `${s.inRange}<small>/${s.n}</small>` : '–', 'days in range')}${tile(s.wavg != null ? fW(s.wavg) : '–', wch != null ? `avg ${wU()}, <span class="${goodness(wch)}">${signed(wch, fW)}</span>` : `avg ${wU()}`)}</div>`
    + `<p class="hint" id="hsNote">${esc(note)}</p>`
    + `<div class="hs-cal" id="hsCal" role="group" aria-label="${esc(monthName(m))}">${historyCal(m)}</div>`
    + `<div class="hs-leg"><span><i class="ok"></i>In range</span><span><i class="over"></i>Over</span><span><i class="under"></i>Under</span><span><i class="miss"></i>Not logged</span><span><i class="dot"></i>Protein hit</span></div>`
    + `<p class="hint">Tap a day to open it. <b>Week</b> is what that week banked (green) or went over (orange) against ${kc(mode() === 'gain' ? T.calLo : T.calHi)} a day, counting only days you logged, like This week. Swipe the calendar for other months.</p>`
    + `<h3 class="hs-h">By month</h3><div class="hs-months" id="hsMonths">${rows}</div>`;
  if (dir && !REDUCED) { const c = $('hsCal'); c.style.setProperty('--dx', dir > 0 ? '24px' : '-24px'); replay(c, 'hs-in'); }
  // swipe the calendar left or right for the next or previous month
  const cal = $('hsCal'); let x0 = null, y0 = 0;
  cal.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; HS.swiped = false; });
  cal.addEventListener('pointerup', e => { if (x0 == null) return; const dx = e.clientX - x0, dy = e.clientY - y0; x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 2 * Math.abs(dy)) { HS.swiped = true; setTimeout(() => { HS.swiped = false; }, 350); historyMove(dx < 0 ? 1 : -1); } });
  cal.addEventListener('pointercancel', () => { x0 = null; });
}

/* ---- Full weight history: every weigh-in, the trend line, the goal, drag to read any day, and monthly averages ---- */
const WH_R = [['1m', '1M', 30], ['3m', '3M', 91], ['6m', '6M', 182], ['1y', '1Y', 365], ['all', 'All', 0]];
const WH = { r: '3m', pts: null };
function openWeightHistory() {
  openSheet('Weight history', `<div class="chips wh-r" id="whRange" role="group" aria-label="Range">${WH_R.map(([k, l]) => `<button class="chip" data-wr="${k}" aria-pressed="${k === WH.r}">${l}</button>`).join('')}</div><div class="wh" id="whWrap"></div>`, wideSheet());
  renderWeightHistory();
  sheetBody.onclick = e => { const b = e.target.closest('[data-wr]'); if (!b || b.dataset.wr === WH.r) return;
    WH.r = b.dataset.wr; [...$('whRange').children].forEach(c => c.setAttribute('aria-pressed', c === b)); haptic(); renderWeightHistory(); };
}
function whRead(i) {
  const p = WH.pts && WH.pts[i]; if (!p) return;
  $('whRead').innerHTML = `<span class="dt">${esc(parseIso(p.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}${i === WH.pts.length - 1 ? ' · latest' : ''}</span><span class="n">${p.lb.toFixed(1)}<small>${wU()}</small></span><span class="tr">trend ${p.avg.toFixed(1)}</span>`;
  const cur = $('whCur'); if (cur) { cur.setAttribute('transform', `translate(${p.x.toFixed(1)},0)`); $('whCurD').setAttribute('cy', p.y.toFixed(1)); cur.style.opacity = 1; }
  WH.i = i;
}
function renderWeightHistory() {
  const box = $('whWrap'); if (!box) return;
  const t = todayIso(), all = weightsArr().map(w => ({ date: w.date, lb: toW(w.lb) }));
  const r = WH_R.find(x => x[0] === WH.r), from = r[2] ? shift(t, -(r[2] - 1)) : (all[0] ? all[0].date : t);
  const pts = all.filter(w => w.date >= from);
  if (pts.length < 2) {
    WH.pts = null;
    box.innerHTML = `<p class="empty" id="whEmpty">${all.length < 2 ? 'Two or more weigh-ins will draw your full history here.' : 'Fewer than two weigh-ins in this range. Try a longer one.'}</p>`;
    return;
  }
  const W = Math.max(280, Math.round(box.clientWidth || sheetBody.clientWidth - 36)), H = Math.round(Math.min(260, Math.max(190, W * 0.5))), L = 34, R = 10, T0 = 12, B = 24;
  const G = S.targets.goal ? toW(S.targets.goal) : null, vals = pts.map(p => p.lb);
  const withG = G != null && G >= Math.min(...vals) - 3 && G <= Math.max(...vals) + 3;
  const lo = Math.floor(Math.min(...vals, ...(withG ? [G] : [])) - 1), hi = Math.ceil(Math.max(...vals, ...(withG ? [G] : [])) + 1);
  const t0 = parseIso(from).getTime(), t1 = Math.max(parseIso(t).getTime(), t0 + 864e5);
  const X = s => L + (parseIso(s).getTime() - t0) / (t1 - t0) * (W - L - R), Y = v => T0 + (hi - v) / (hi - lo) * (H - T0 - B);
  WH.pts = pts.map(p => { const avg = avgBetween(all, shift(p.date, -6), p.date); return { ...p, avg, x: X(p.date), y: Y(p.lb), ya: Y(avg) }; });
  const line = WH.pts.map(p => `${p.x.toFixed(1)},${p.ya.toFixed(1)}`).join(' ');
  const txt = 'font-size="11" fill="var(--muted)" font-family="Barlow, system-ui, sans-serif"';
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Weight from ${esc(shortDate(from))} to today"><defs><linearGradient id="whg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".2"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`;
  niceTicks(lo, hi).forEach(v => { svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" ${txt}>${v}</text>`; });
  // month starts along the bottom (labels skipped where they'd crowd)
  let lastX = -99; const mk = [];
  for (let m = addMonth(ym(from), 1); m <= ym(t); m = addMonth(m, 1)) mk.push(m);
  if (r[2] && r[2] <= 30) mk.length = 0;
  mk.forEach(m => { const x = X(m + '-01'); svg += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${T0}" y2="${H - B}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
    if (x - lastX >= 30 && x > L + 26 && x < W - R - 30) { const d = parseIso(m + '-01'); svg += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" ${txt}>${esc(d.toLocaleDateString(undefined, d.getMonth() === 0 ? { month: 'short', year: '2-digit' } : { month: 'short' }))}</text>`; lastX = x; } });
  if (!mk.length) svg += `<text x="${L}" y="${H - 6}" ${txt}>${esc(parseIso(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</text>`;
  svg += `<text x="${W - R}" y="${H - 6}" text-anchor="end" ${txt}>Today</text>`;
  if (withG) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(G)}" y2="${Y(G)}" stroke="var(--protein)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${L + 4}" y="${Y(G) - 5}" font-size="11" fill="var(--protein)" font-family="Barlow, system-ui, sans-serif">Goal ${fWs(S.targets.goal)}</text>`;
  const p0 = WH.pts[0], pn = WH.pts[WH.pts.length - 1];
  svg += `<polygon points="${p0.x.toFixed(1)},${H - B} ${line} ${pn.x.toFixed(1)},${H - B}" fill="url(#whg)"/>`;
  const rd = WH.pts.length > 120 ? 2 : 3;
  WH.pts.forEach(p => { svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rd}" fill="var(--muted)" opacity=".5"/>`; });
  svg += `<polyline class="draw" pathLength="1" points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  svg += `<g id="whCur" style="opacity:0"><line x1="0" x2="0" y1="${T0}" y2="${H - B}" stroke="var(--ink)" stroke-opacity=".35" stroke-width="1.5"/><circle id="whCurD" cx="0" cy="0" r="5.5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/></g>`;
  svg += `<rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/></svg>`;
  // the range in numbers
  const rate = WH.pts.length >= 3 && daysBetween(p0.date, pn.date) >= RATE_MIN_SPAN ? slopePerWeek(WH.pts.map(p => ({ date: p.date, lb: p.avg }))) : null, ch = pn.avg - p0.avg, low = WH.pts.reduce((a, p) => p.lb < a.lb ? p : a), Gd = G != null ? pn.avg - G : null;
  const tile = (v, k, cls) => `<div><span class="v${cls ? ' ' + cls : ''}">${v}</span><span class="k">${k}</span></div>`;
  const stats = tile(signed(ch, n => n.toFixed(1)), `trend change, ${wU()}`, goodness(fromW(ch))) + tile(rate == null ? '–' : signed(rate, n => n.toFixed(1)), `${wU()} a week`, rate == null ? '' : goodness(fromW(rate)))
    + tile(low.lb.toFixed(1), `lowest, ${esc(parseIso(low.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}`) + tile(Gd == null ? '–' : Math.abs(Gd).toFixed(1), Gd == null ? 'to goal' : mode() === 'maintain' ? `${wU()} from goal` : `${wU()} to goal`);
  // months, newest first
  const months = []; all.forEach(w => { const m = ym(w.date), x = months[months.length - 1]; if (x && x.m === m) x.v.push(w.lb); else months.push({ m, v: [w.lb] }); });
  const mrows = months.map((x, i) => { const a = x.v.reduce((s, v) => s + v, 0) / x.v.length, b = i ? months[i - 1].v.reduce((s, v) => s + v, 0) / months[i - 1].v.length : null, d = b == null ? null : a - b;
    return `<div class="whm"><b>${esc(monthName(x.m))}</b><span class="r"><b>${a.toFixed(1)}</b><small class="${d == null ? '' : goodness(fromW(d))}">${d == null ? `avg ${wU()}` : `${signed(d, n => n.toFixed(1))} ${wU()}`}</small></span><small>${x.v.length} weigh-in${x.v.length > 1 ? 's' : ''} · ${Math.min(...x.v).toFixed(1)}–${Math.max(...x.v).toFixed(1)}</small></div>`; }).reverse().join('');
  box.innerHTML = `<div class="wh-read" id="whRead" aria-live="polite"></div><div class="wh-chart" id="whChart">${svg}</div>`
    + `<p class="hint">Dots are weigh-ins; the line is your 7-day average${withG ? ' and the dashed line your goal' : ''}. Drag along the chart to read any day.</p>`
    + `<div class="hs-sum wh-stats" id="whStats">${stats}</div>`
    + `<h3 class="hs-h">By month</h3><div class="hs-months" id="whMonths">${mrows}</div>`;
  whRead(WH.pts.length - 1);
  // drag (or tap) along the chart to read the nearest weigh-in; arrow keys step through them
  const svgEl = $('whChart').querySelector('svg'), at = e => { const b = svgEl.getBoundingClientRect(), x = (e.clientX - b.left) * W / b.width;
    let k = 0; WH.pts.forEach((p, j) => { if (Math.abs(p.x - x) < Math.abs(WH.pts[k].x - x)) k = j; }); if (k !== WH.i) { whRead(k); } };
  let down = false;
  svgEl.addEventListener('pointerdown', e => { down = true; try { svgEl.setPointerCapture(e.pointerId); } catch (x) {} at(e); });
  svgEl.addEventListener('pointermove', e => { if (down || e.pointerType === 'mouse') at(e); });
  ['pointerup', 'pointercancel'].forEach(n => svgEl.addEventListener(n, () => { down = false; }));
  svgEl.setAttribute('tabindex', '0');
  svgEl.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); whRead(Math.max(0, Math.min(WH.pts.length - 1, WH.i + (e.key === 'ArrowLeft' ? -1 : 1)))); } });
}

/* ways in: the weight charts (tap them), "See full weight history" and "See calendar by month" */
const openWH = () => { if (weightsArr().length >= 2) openWeightHistory(); };
$('chart').addEventListener('click', openWH); $('tWeightChart').addEventListener('click', openWH);
$('wHist').onclick = openWH; $('tWHist').onclick = openWH;
$('tCalHist').onclick = () => openHistory();

/* What fits: picks from your own meals, recent and saved foods, most protein per calorie first */
function fitsCandidates() {
  const seen = new Set(), out = [];
  const add = (f, qty, unit) => { if (!f || seen.has(f.id)) return; const v = calc(f, qty, unit); if (!(v.kcal >= 20)) return; seen.add(f.id); out.push({ f, qty, unit, kcal: v.kcal, pro: v.pro }); };
  S.meals.forEach(m => add(mealFood(m), 1, 'serving'));
  S.recent.forEach(r => add(freshFood(r.food), r.qty, r.unit));
  S.foods.forEach(f => { const us = unitsFor(f), u = us.find(x => x.key === 'serving') || us.find(x => x.key === 'piece') || us.find(x => x.key === 'g'); if (u) add(f, u.key === 'g' ? 100 : 1, u.key); });
  return out;
}
function pickFits(left) {
  const c = fitsCandidates().filter(x => x.kcal <= left).sort((p, q) => q.pro / q.kcal - p.pro / p.kcal || q.pro - p.pro);
  const picks = []; let k = left;
  for (const x of c) { if (picks.length >= 2) break; if (x.kcal <= k) { picks.push(x); k -= x.kcal; } }
  return picks;
}
let fitPicks = [];
function renderFits() {
  const el = $('fits'), T = S.targets, es = entriesFor(day);
  const cal = es.reduce((s, e) => s + e.kcal, 0), pro = es.reduce((s, e) => s + e.pro, 0), left = Math.round(T.calHi - cal);
  fitPicks = day === todayIso() && es.length && left >= 150 ? pickFits(left) : [];
  el.hidden = !fitPicks.length; if (!fitPicks.length) return;
  const proLeft = Math.max(0, Math.round(T.protein - pro));
  el.innerHTML = `<span class="fits-k">Fits the ${kc(left)} kcal${proLeft ? ` and ${proLeft}g protein` : ''} left</span>
    <div class="fits-row">${fitPicks.map((x, i) => `<button class="fit" data-fit="${i}"><b>${esc(x.f.name)}</b><small>${Math.round(x.kcal)} kcal · ${fmtG(x.pro)}g protein</small></button>`).join('')}</div>`;
}
$('fits').onclick = e => { const b = e.target.closest('[data-fit]'); if (!b) return; const x = fitPicks[+b.dataset.fit]; if (x) { haptic(); openAmount(x.f, { qty: x.qty, unit: x.unit }); } };

/* Weekly check-in: last full week (Monday to Sunday) */
function lastWeek() {
  const T = S.targets, ws = shift(weekStart(todayIso()), -7), we = shift(ws, 6);
  const days = Array.from({ length: 7 }, (_, i) => dayTotals(shift(ws, i))).filter(Boolean);
  const arr = weightsArr(), wNow = avgBetween(arr, ws, we), wPrev = avgBetween(arr, shift(ws, -7), shift(ws, -1));
  return { ws, we, n: days.length, avgK: days.length ? days.reduce((s, x) => s + x.kcal, 0) / days.length : null,
    avgP: days.length ? days.reduce((s, x) => s + x.pro, 0) / days.length : null,
    inRange: days.filter(x => x.kcal >= T.calLo && x.kcal <= T.calHi).length, proHit: days.filter(x => x.pro >= T.protein).length,
    wChange: wNow != null && wPrev != null ? wNow - wPrev : null };
}
function renderCheckin() {
  const box = $('ciBody'); if (!box) return;
  const w = lastWeek(), T = S.targets, m = mode();
  $('ciWhen').textContent = rangeTxt(w.ws, w.we);
  try { localStorage.setItem('cutlog.checkin', w.ws); } catch (e) {}      // seen, so the Today banner goes away
  $('ciBanner').hidden = true;
  if (!w.n) { box.innerHTML = '<p class="empty">Log food on a few days this week. Every Monday, your check-in sums up the week before.</p>'; return; }
  const wc = w.wChange, wTxt = wc == null ? '–' : (wc > 0 ? '+' : wc < 0 ? '−' : '') + fW(Math.abs(wc));
  let verdict;
  if (w.n < 4) verdict = `Only ${w.n} day${w.n > 1 ? 's' : ''} logged, so take this week's numbers with a pinch of salt. Aim for at least 5.`;
  else if (wc == null) verdict = `${w.inRange} of ${w.n} logged days in your calorie range. Weigh in a few mornings a week to see how your weight responded.`;
  else {
    const moving = m === 'lose' ? wc < -0.2 : m === 'gain' ? wc > 0.1 : Math.abs(wc) <= 0.5;
    const move = m === 'maintain' ? 'your weight held steady' : `${m === 'lose' ? 'down' : 'up'} ${fW(Math.abs(wc))} ${wU()} on the weekly average`;
    verdict = moving ? `Good week: ${move}, with ${w.inRange} of ${w.n} days in your calorie range.`
      : `Your weekly average ${wc > 0.05 ? 'went up' : wc < -0.05 ? 'went down' : 'held steady'} (${wTxt} ${wU()}). One week can be noise from water and salt. If it repeats next week, adjust.`;
  }
  const sug = goalSuggestion(m);
  let adj;
  if (sug && sug.src === 'burn' && (Math.abs(sug.lo - T.calLo) >= 100 || Math.abs(sug.hi - T.calHi) >= 100))
    adj = `<div class="ci-adj"><p class="hint">Your real burn now suggests <b>${kc(sug.lo)}–${kc(sug.hi)} kcal</b> for ${MODES[m]}. You're set to ${kc(T.calLo)}–${kc(T.calHi)}.</p>
      <button class="btn ghost" id="ciUse">Update my targets to ${kc(sug.lo)}–${kc(sug.hi)}</button></div>`;
  else if (sug && sug.src === 'burn') adj = '<p class="hint">Your targets still match your real burn. Nothing to change.</p>';
  else adj = '<p class="hint">After about 2 weeks of logging and weighing in, your check-in can suggest target changes from your real burn.</p>';
  box.innerHTML = `<div class="ci-grid">
      <div><span class="v">${kc(w.avgK)}</span><span class="k">avg kcal</span></div>
      <div><span class="v">${Math.round(w.avgP)}g</span><span class="k">avg protein</span></div>
      <div><span class="v">${wTxt}</span><span class="k">weight (${wU()}) vs week before</span></div>
      <div><span class="v">${w.inRange}/${w.n}</span><span class="k">days in range</span></div>
      <div><span class="v">${w.proHit}/${w.n}</span><span class="k">protein days</span></div>
      <div><span class="v">${w.n}/7</span><span class="k">days logged</span></div>
    </div>
    <p class="ci-verdict">${esc(verdict)}</p>${adj}`;
  if ($('ciUse')) $('ciUse').onclick = () => {
    const old = { ...S.targets };
    S.targets = { ...S.targets, calLo: sug.lo, calHi: sug.hi }; touchMeta(); renderAll(); renderTrends(); haptic();
    toast('Targets updated', { label: 'Undo', fn: () => { S.targets = old; touchMeta(); renderAll(); if (tab === 'trends') renderTrends(); } });
  };
}
function renderCiBanner() {
  const b = $('ciBanner'), t = todayIso(), w = lastWeek();
  let seen = null; try { seen = localStorage.getItem('cutlog.checkin'); } catch (e) {}
  const show = day === t && w.n >= 3 && seen !== w.ws && daysBetween(weekStart(t), t) <= 2;   // Monday to Wednesday
  b.hidden = !show; if (show) $('ciBannerS').textContent = `${rangeTxt(w.ws, w.we)} · ${w.n} days logged`;
}
$('ciBanner').onclick = () => { haptic(); showTab('trends'); requestAnimationFrame(() => $('ciCard').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' })); };

/* Move an entry to another day */
function openMoveDay(id) {
  const from = day, e = entriesFor(from).find(x => x.id === id); if (!e) return;
  const t = todayIso(), name = d => d === t ? 'Today' : d === shift(t, -1) ? 'Yesterday' : shortDate(d);
  const quick = [shift(from, -1), ...(from < t ? [shift(from, 1)] : [])];
  let to = quick[0];
  openSheet('Move to another day', `
    <div class="food-head"><strong>${esc(e.name)}</strong><span>${esc([e.detail, `${Math.round(e.kcal)} kcal`].filter(Boolean).join(' · '))} · now on ${esc(name(from))}</span></div>
    <div class="chips" id="mvQuick">${quick.map(d => `<button class="chip" data-d="${d}" aria-pressed="${d === to}">${esc(name(d))}</button>`).join('')}</div>
    <label>Or pick a date<input type="date" id="mvDate" min="${shift(t, -90)}" max="${t}" value="${to}"></label>
    <button class="btn" id="mvGo">Move to ${esc(name(to))}</button>`);
  const pickD = d => { to = d; $('mvDate').value = d; $('mvGo').textContent = `Move to ${name(d)}`;
    [...$('mvQuick').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.d === d)); };
  $('mvQuick').onclick = ev => { const c = ev.target.closest('[data-d]'); if (c) { haptic(); pickD(c.dataset.d); } };
  $('mvDate').onchange = () => { const d = $('mvDate').value; if (d) pickD(d); };
  $('mvGo').onclick = () => {
    if (!to || to > t) { toast("That date hasn't happened yet."); return; }
    if (daysBetween(to, t) > 90) { toast('Pick a date within the last 3 months.'); return; }
    if (to === from) { toast(`It's already on ${name(from)}.`); return; }
    const list = entriesFor(from), i = list.findIndex(x => x.id === id); if (i < 0) return;
    const [moved] = list.splice(i, 1); if (!list.length) delete S.log[from];
    (S.log[to] ||= []).push(moved); touchDay(from); touchDay(to); renderTotals(); renderRows(); closeSheet(); haptic();
    toast(`Moved to ${name(to)}`, { label: 'Undo', fn: () => {
      const l2 = entriesFor(to), j = l2.findIndex(x => x.id === id); if (j < 0) return;
      l2.splice(j, 1); if (!l2.length) delete S.log[to];
      (S.log[from] ||= []).splice(i, 0, moved); touchDay(from); touchDay(to); renderTotals(); renderRows(); } });
  };
}

/* Appearance: Match phone, Light or Dark. A per-device choice, like brightness; it isn't synced. */
const LOOK_BG = { light: '#F2F4F8', dark: '#0B0E14' };
function look() { try { const v = localStorage.getItem('cutlog.appearance'); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; } }
function applyLook() {
  const v = look(), r = document.documentElement;
  if (v === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', v);
  document.querySelectorAll('meta[name="theme-color"]').forEach(mt => {
    mt.dataset.orig ||= mt.content; mt.content = v === 'auto' ? mt.dataset.orig : LOOK_BG[v];
  });
  [...$('pLook').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.v === v));
}
$('pLook').onclick = e => {
  const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === look()) return;
  try { if (b.dataset.v === 'auto') localStorage.removeItem('cutlog.appearance'); else localStorage.setItem('cutlog.appearance', b.dataset.v); } catch (er) {}
  applyLook(); haptic(); if (tab === 'trends') renderTrends();
  toast({ auto: 'Following your phone’s light or dark setting', light: 'Light, on this device', dark: 'Dark, on this device' }[b.dataset.v]);
};
applyLook();

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
$('acctBtn').onclick = openAccount;
function toggleEdit(view, form, open) {
  $(view).hidden = open; $(form).hidden = !open;
  replay($(open ? form : view), 'fade-in');
}
$('pNameEdit').onclick = () => { $('pName').value = S.name || ''; toggleEdit('pNameView', 'pNameForm', true); $('pName').focus(); };
$('pNameCancel').onclick = () => { toggleEdit('pNameView', 'pNameForm', false); renderSettings(); };
$('pNameSave').onclick = () => {
  S.name = $('pName').value.trim().slice(0, 30); $('pName').blur();
  toggleEdit('pNameView', 'pNameForm', false); touchMeta(); renderSettings(); haptic();
  toast(S.name ? `Nice to meet you, ${S.name}` : 'Name cleared');
};
$('pName').addEventListener('keydown', e => { if (e.key === 'Enter') $('pNameSave').click(); });
function openGoalEdit(open) {
  delete $('pMode').dataset.pending;
  toggleEdit('goalView', 'goalForm', open); $('goalEdit').hidden = open;
  renderSettings(); if (open) renderGoalSuggest();
}
$('goalEdit').onclick = () => openGoalEdit(true);
$('goalCancel').onclick = () => openGoalEdit(false);
$('pUnits').onclick = e => {
  const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === (S.units || 'imperial')) return;
  S.units = b.dataset.v; touchMeta(); renderAll(); if (tab === 'trends') renderTrends(); haptic();
  toast(metric() ? 'Showing kilograms and centimetres' : 'Showing pounds and inches');
};
$('pScale').onclick = e => {
  const b = e.target.closest('[data-v]'); if (!b || b.dataset.v === scale()) return;
  S.scale = b.dataset.v; delete $('wForm').dataset.editing; touchMeta(); renderAll(); haptic();
  toast({ daily: 'Set to daily weigh-ins', weekly: 'Set to weekly weigh-ins', none: 'No scale: track your waist on Today' }[S.scale]);
};
$('pMode').onclick = e => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  $('pMode').dataset.pending = b.dataset.v; haptic();
  [...$('pMode').children].forEach(c => c.setAttribute('aria-pressed', c === b));
  $('pModeHint').textContent = MODE_HINT[b.dataset.v];
  renderGoalSuggest();
};
$('copyBtn').onclick = openCopy;
function slideDay(dir) {
  ['.rings', '#status', '#rows', '#dayLabel'].forEach(s => { const el = document.querySelector(s); el.classList.remove('from-left', 'from-right'); replay(el, dir < 0 ? 'from-left' : 'from-right'); });
  haptic();
}
$('prev').onclick = () => { day = shift(day, -1); renderDay(); renderTotals(); renderRows(); slideDay(-1); };
$('next').onclick = () => { if (day < todayIso()) { day = shift(day, 1); renderDay(); renderTotals(); renderRows(); slideDay(1); } };
$('rows').onclick = e => {
  const r = e.target.closest('.row[data-id]'); if (!r) return;
  const en = entriesFor(day).find(z => z.id === r.dataset.id); if (!en) return;
  openAmount(entryFood(en), en.food ? { qty: en.qty, unit: en.unit, oil: en.oil } : { qty: 1, unit: 'serving' }, { editId: en.id });
};
$('wSave').onclick = () => {
  const v = fromW(parseFloat($('wIn').value)), t = todayIso(), f = $('wForm');
  if (!(v >= 80 && v <= 500)) { toast(`Enter your weight in ${metric() ? 'kilograms' : 'pounds'}.`); return; }
  let d = !$('wDateWrap').hidden && $('wDate').value ? $('wDate').value : (f.dataset.editing === '1' && f.dataset.date) || t;
  if (d > t) { toast("That date hasn't happened yet."); return; }
  if (daysBetween(d, t) > 90) { toast('Pick a date within the last 3 months.'); return; }
  S.weights[d] = rW(v); touchDay(d);
  delete f.dataset.editing; $('wDateWrap').hidden = true; $('wDateBtn').hidden = false; $('wIn').blur(); $('wIn').value = '';
  renderWeights();
  replay($('wDone'), 'done-in'); replay($('avg7'), 'pop'); haptic(); toast(d === t ? 'Weigh-in saved' : `Saved for ${shortDate(d)}`);
};
$('wIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('wSave').click(); });
$('wEdit').onclick = () => {
  const f = $('wForm'), d = f.dataset.date || todayIso();
  f.dataset.editing = '1'; renderWeights();
  if (d !== todayIso()) { $('wDateWrap').hidden = false; $('wDateBtn').hidden = true; $('wDate').value = d; }
  replay(f, 'fade-in'); $('wIn').focus(); $('wIn').select();
};
$('wDateBtn').onclick = () => {
  const t = todayIso();
  $('wDate').max = t; $('wDate').min = shift(t, -90); $('wDate').value = shift(t, -1);
  $('wDateWrap').hidden = false; $('wDateBtn').hidden = true; replay($('wDateWrap'), 'fade-in');
};
$('haveScale').onclick = () => { $('wForm').dataset.editing = '1'; $('wForm').dataset.date = todayIso(); renderWeights(); $('wIn').focus(); };
/* ---------- waist ---------- */
function waistArr() { return Object.entries(S.waist || {}).map(([date, v]) => ({ date, v: +v })).sort((a, b) => (a.date < b.date ? -1 : 1)); }
const WAIST_EVERY = 14;
const fmtIn = v => metric() ? `${fL(v)} cm` : `${fL(v)}″`;
function renderWaist() {
  const z = waistArr(), t = todayIso(), f = $('zForm');
  const last = z[z.length - 1], first = z[0], editing = f.dataset.editing === '1', fresh = f.dataset.fresh === '1';
  const logged = !!last && !editing && !fresh && daysBetween(last.date, t) < WAIST_EVERY;
  f.hidden = logged; $('zDone').hidden = !logged;
  if (logged) {
    $('zNum').textContent = fL(last.v);
    $('zTag').textContent = last.date === t ? 'Logged today' : `Measured ${shortDate(last.date)}`;
    const prev = z[z.length - 2], dl = $('zDelta'); dl.className = 'wdone-delta';
    if (prev) {
      const x = last.v - prev.v, days = daysBetween(prev.date, last.date);
      dl.textContent = Math.abs(x) < 0.01 ? `Same as ${days} days before` : `${x > 0 ? '+' : '−'}${fmtIn(Math.abs(x))} vs ${days} days before`;
      if (mode() === 'lose' && Math.abs(x) >= 0.01) dl.classList.add(x < 0 ? 'good' : 'bad');
    } else dl.textContent = 'Your first measurement. Check again in two weeks.';
    const nd = shift(last.date, WAIST_EVERY);
    $('zNext').textContent = `Next check: ${shortDate(nd)}`;
    $('zNew').hidden = last.date === t;
  } else if (document.activeElement !== $('zIn')) {
    $('zIn').value = editing && last ? fL(last.v) : '';
  }
  $('zStats').hidden = z.length < 2;
  $('zStart').textContent = first ? fmtIn(first.v) : '–';
  const c = $('zChg'); c.className = 'v';
  if (z.length >= 2) { const x = last.v - first.v; c.textContent = Math.abs(x) < 0.01 ? '0″' : `${x > 0 ? '+' : '−'}${fmtIn(Math.abs(x))}`;
    if (mode() === 'lose' && Math.abs(x) >= 0.01) c.classList.add(x < 0 ? 'good' : 'bad'); }
  else c.textContent = '–';
  $('zCount').textContent = `${z.length}×`;
  const due = last && !logged && !editing && !fresh;
  $('zHint').textContent = due ? `Time for your next measurement. It's been ${daysBetween(last.date, t)} days.`
    : scale() === 'none' ? 'Measure at your belly button, relaxed, every two weeks. A shrinking waist is one of the clearest signs of fat loss.'
    : 'Measure at your belly button, relaxed, every two weeks. Waist going down while your weight holds steady means fat loss, not muscle loss.';
}
$('zSave').onclick = () => {
  const v = parseFloat($('zIn').value), t = todayIso(), f = $('zForm');   // entered in inches or cm
  if (!(fromL(v) >= 15 && fromL(v) <= 80)) { toast(`Enter your waist in ${metric() ? 'centimetres' : 'inches'}.`); return; }
  const z = waistArr(), d = f.dataset.editing === '1' && z.length ? z[z.length - 1].date : t;
  S.waist[d] = metric() ? Math.round(fromL(v) * 100) / 100 : Math.round(v * 4) / 4; touchDay(d);
  delete f.dataset.editing; delete f.dataset.fresh; $('zIn').value = ''; $('zIn').blur();
  renderWaist(); replay($('zDone'), 'done-in'); haptic(); toast('Waist saved');
};
$('zEdit').onclick = () => { $('zForm').dataset.editing = '1'; renderWaist(); replay($('zForm'), 'fade-in'); $('zIn').focus(); $('zIn').select(); };
$('zNew').onclick = () => { $('zForm').dataset.fresh = '1'; renderWaist(); replay($('zForm'), 'fade-in'); $('zIn').focus(); };
$('zIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('zSave').click(); });
$('tForm').onsubmit = e => {
  e.preventDefault();
  const lo = +$('tLo').value, hi = +$('tHi').value, pr = +$('tPro').value, g = rW(fromW(+$('tGoal').value)), sw = $('tStart').value.trim();
  if (!(lo > 0 && hi >= lo && pr > 0 && g > 0)) { toast('Check the targets: the low number must be below the high one.'); return; }
  if (sw && !(fromW(+sw) >= 80 && fromW(+sw) <= 600)) { toast(`Starting weight should be in ${metric() ? 'kilograms' : 'pounds'}.`); return; }
  const newMode = $('pMode').dataset.pending || mode(), changed = newMode !== mode();
  S.targets = { ...S.targets, calLo: lo, calHi: hi, protein: pr, goal: g, mode: newMode };
  S.startWeight = sw ? rW(fromW(+sw)) : null;
  document.activeElement?.blur?.(); openGoalEdit(false); touchMeta(); renderAll(); haptic();
  toast(changed ? `Goal set to ${MODES[newMode]}` : 'Goal and targets saved');
};
/* Saved foods open in a panel with a search box, instead of filling the You tab */
const foodRow = f => `<button class="food-row" data-food="${esc(f.id)}"><span>${esc(f.name)}<small>${esc([f.brand, perLine(f)].filter(Boolean).join(' · '))}</small></span>${nsBadge(f)}${icon('i-chev-r')}</button>`;
function openSavedFoods(q = '') {
  openSheet('Saved foods', `
    ${S.foods.length > 5 ? `<input id="fq" type="search" placeholder="Search your ${S.foods.length} foods" aria-label="Search saved foods" autocomplete="off" value="${esc(q)}">` : ''}
    <div class="list mlist" id="fList"></div>
    <p class="hint">Tap a food to log it, fix its numbers or delete it.</p>`);
  const show = () => {
    const words = ($('fq')?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = S.foods.filter(f => words.every(w => (f.name + ' ' + (f.brand || '')).toLowerCase().includes(w)));
    $('fList').innerHTML = list.length ? list.map(foodRow).join('') : '<p class="empty">No saved food matches that.</p>';
  };
  if ($('fq')) $('fq').oninput = () => { holdSheetHeight(); show(); };   // same keyboard fix as Search
  show();
  $('fList').onclick = e => {
    const b = e.target.closest('[data-food]'); if (!b) return;
    const f = S.foods.find(x => x.id === b.dataset.food); if (f) openFoodDetail(f, $('fq')?.value || '');
  };
}
$('foodsBtn').onclick = () => openSavedFoods();
function openFoodDetail(f, fromList) {
  const back = fromList !== undefined;
  const per = f.kcalServ != null ? { k: f.kcalServ, p: f.proServ } : f.servingG ? { k: f.kcal100 * f.servingG / 100, p: (f.pro100 || 0) * f.servingG / 100 } : null;
  openSheet('Saved food', `
    <div class="food-head"><strong>${esc(f.name)}</strong><span>${esc([f.brand, f.barcode ? 'barcode ' + f.barcode : ''].filter(Boolean).join(' · '))}</span>${nsOk(f.nutri) ? `<span class="ns-row">${nsBadge(f, true)}</span>` : ''}</div>
    <div class="result">
      <div><span class="num">${Math.round(per ? per.k : f.kcal100)}</span><small>kcal per ${per ? 'serving' : '100 g'}</small></div>
      <div class="pro"><span class="num">${r1(per ? per.p : f.pro100)}g</span><small>protein</small></div>
    </div>
    ${f.servingG || hasFib(f) ? `<p class="hint">${[f.servingG ? `One serving is ${esc(servLabel(f))}.` : '', hasFib(f) ? `${fmtG(fibPerServ(f, per ? f.servingG : null))}g fibre per ${per ? 'serving' : '100 g'}.` : ''].filter(Boolean).join(' ')}</p>` : ''}
    <button class="btn" id="fdLog">Log this food</button>
    <button class="btn ghost" id="fdEdit">Edit numbers</button>
    <button class="btn danger" id="fdDel">Delete food</button>
    ${back ? '<button class="btn ghost" id="fdBack">Back to saved foods</button>' : ''}`);
  if ($('fdBack')) $('fdBack').onclick = () => openSavedFoods(fromList);
  $('fdLog').onclick = () => openAmount(f, S.recent.find(r => r.food.id === f.id));
  $('fdEdit').onclick = () => {
    openSheet('Edit numbers', '<p class="hint">Enter what the label says for one serving.</p><div id="labelOut"></div>');
    labelForm($('labelOut'), { kcal: per ? Math.round(per.k) : Math.round(f.kcal100), pro: per ? r1(per.p) : r1(f.pro100 || 0), fib: fibPerServ(f, per ? f.servingG : null), servingG: f.servingG || (per ? null : 100) }, '', f.barcode || null, f.name, f.id);
    $('lSave').textContent = 'Save and log it';
  };
  $('fdDel').onclick = () => {
    const i = S.foods.findIndex(x => x.id === f.id); if (i < 0) return;
    const [gone] = S.foods.splice(i, 1), rec = S.recent.slice();
    S.recent = S.recent.filter(r => r.food.id !== f.id); touchMeta(); renderSettings(); haptic();
    if (back && S.foods.length) openSavedFoods(); else closeSheet();
    toast(`Deleted ${gone.name}`, { label: 'Undo', fn: () => { S.foods.splice(i, 0, gone); S.recent = rec; touchMeta(); renderSettings();
      if (SH.open && $('sheetTitle').textContent === 'Saved foods') openSavedFoods($('fq')?.value || ''); } });
  };
}
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
    msSilent = true;
    S = Object.assign(seed(), data); S.onboarded = true; S.slotPref ||= {}; S.milestones ||= {}; S.targets = Object.assign({ mode: 'lose' }, S.targets); S.dirty = []; touchAll();
    setTimeout(() => { msSilent = false; }, 0); hideOnboarding(); renderAll(); toast('Backup restored');
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
if (S.onboarded) { const md = loadDraft(); if (autoResume(md)) { markDraft('resumed', true); setTimeout(() => safe(() => resumeDraft(md.d, true)), 300); } }
if (!S.msInit && S.onboarded) { S.msInit = true; checkMilestones(true); }
if (!S.onboarded) showOnboarding(1);
else if (!REDUCED) document.body.classList.add('launch');
initSync();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
