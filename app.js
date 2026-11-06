/* Cut Log — free calorie & protein tracker.
   Data is saved on the phone first (works offline), then synced to Firebase when signed in. */
'use strict';
/* The page and this script must come from the same update; if a cached copy is mixed in, reload once */
const APP_V = '94';
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
function touchDay(d) { S.stamps.days[d] = Date.now(); markDirty('d:' + d); persist(); scheduleFlush(); queueMicrotask(() => checkMilestones()); alertsKick(); }   // v91: weigh-ins too
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
  [/\b(ground|minced) chicken\b|\bchicken,? (ground|mince)|\bpoulet hache|\bhache de poulet\b/, 'Ground chicken, extra lean (raw)'],
  [/\b(ground|minced) beef\b|\bbeef,? (ground|mince)|\bboeuf hache|\bhache de boeuf\b/, 'Ground beef, extra lean (raw)'],
  [/\bchicken breasts?\b|\bpoitrines? de poulet\b/, 'Chicken breast (raw)'],
  [/\bbasa\b|\bswai\b|\bpangasius\b/, 'Basa / swai fillet (raw)'],
  [/\bsalmon\b|\bsaumon\b/, 'Salmon, Atlantic (raw)'],
  [/\bbrown rice\b|\briz (brun|complet)\b/, 'Brown rice (dry)'],
  [/\brice\b|\briz\b/, 'White rice (dry)'],
  [/\b(pasta|spaghetti|spaghettis|spaghettini|penne|macaroni|fusilli|linguine|rigatoni|rotini|fettuccine|farfalle|orzo|pates|coquillettes)\b/, 'Pasta (dry)'],
  [/\boats\b|\boatmeal\b|\bporridge\b|\bavoine\b|\bgruau\b/, 'Oats, rolled (dry)'],
];
/* v77: Canadian packs often reach Open Food Facts under their French name (Kan's "Filets de saumon rose sauvage"), so names
   are matched in English and French. Accents are taken off first (haché -> hache, bœuf -> boeuf), and the French words for
   cooked, smoked, canned and so on keep ready-to-eat packs out, like the English ones. */
const PKG_NOT = /\b(cooked|roasted|grilled|smoked|canned|tinned|deli|sliced|nuggets?|breaded|fried|strips|cakes?|crackers?|crisps?|crispy|chips|cereal|milk|flour|bran|bars?|sauce|soup|pudding|salad|bowl|drink|granola|cookies?|vinegar|wine|oil|jerky|sushi|dinner|meal|kit|cuite?s?|roties?|rotis?|grillee?s?|fumee?s?|conserve|tranchee?s?|panee?s?|frite?s?|croustillante?s?|pepites|batonnets|galettes?|craquelins?|cereales?|lait|farine|son|barres?|soupe|pouding|salade|bol|boisson|biscuits?|vinaigre|vin|huile|repas|souper|trousse)\b/;
const PKG_FAT_SALMON = 170;      // kcal per 100 g: under this the pack is wild or pink salmon, not fatty farmed Atlantic
const pkgName = n => String(n || '').toLowerCase().replace(/œ/g, 'oe').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function pkgPair(f) {
  if (!f || NOT_SAVED.includes(f.source) || f.source === 'cooked' || f.cookOf || !(f.kcal100 > 0)) return null;
  const low = String(f.name || '').toLowerCase(), nm = pkgName(low);
  if (PKG_NOT.test(nm) || /\bpâtés?\b|pâté/.test(low)) return null;    // pâté (meat spread) isn't pâtes (pasta)
  const hit = PKG_PAIRS.find(([re]) => re.test(nm)); if (!hit) return null;
  const raw = BUILTIN_FOODS.find(x => x.name === hit[1]), cooked = raw && BUILTIN_FOODS.find(x => x.name === raw.twin);
  if (!cooked) return null;
  if (raw.state === 'dry' && Math.abs(f.kcal100 - raw.kcal100) >= Math.abs(f.kcal100 - cooked.kcal100)) return null;   // already cooked
  /* v77: the built-in salmon pair is fatty farmed Atlantic (208 raw, 206 cooked: it loses fat as it loses water, so x0.99).
     Wild and pink salmon are lean and just lose water: USDA pink salmon 127 raw, 153 cooked (dry heat), so x1.2. */
  if (raw.name === 'Salmon, Atlantic (raw)' && f.kcal100 < PKG_FAT_SALMON) return { raw, cooked, k: 153 / 127 };
  return { raw, cooked };
}
const PKG_SEEN = new Map();   // v63: packs opened this session, so a just-scanned pack can be saved when it's logged as Cooked
function cookedOf(p, pp = pkgPair(p)) {
  if (!pp) return null;
  PKG_SEEN.set(p.id, p);
  const k = pp.k || pp.cooked.kcal100 / pp.raw.kcal100;
  const c = { id: p.id + '~cooked', cookOf: p.id, name: `${p.name} (cooked)`, source: 'cooked', state: 'cooked', kcal100: p.kcal100 * k, pro100: (p.pro100 || 0) * k };
  if (p.brand) c.brand = p.brand;
  if (pp.cooked.cook) c.cook = true;
  if (pp.cooked.cup) c.cup = pp.cooked.cup;
  const f100 = p.fib100 != null ? p.fib100 : p.fibServ != null && p.servingG ? p.fibServ / p.servingG * 100 : null;
  if (f100 != null) c.fib100 = f100 * k;
  if (hasMac(p)) { const per = (a, b) => p[a] != null ? p[a] : p[b] / p.servingG * 100;     // v84
    if (p.carb100 != null || p.servingG) { c.carb100 = per('carb100', 'carbServ') * k; c.fat100 = per('fat100', 'fatServ') * k; } }
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
  if (!u || !(qty > 0)) return { kcal: 0, pro: 0, fib: null, carb: null, fat: null };
  /* v84: carbs and fat work like fibre: null when the food doesn't have them */
  const per = (k100, kS) => u.key === 'serving' && f.kcalServ != null
    ? (f[kS] != null ? qty * f[kS] : f[k100] != null && f.servingG ? qty * f.servingG * f[k100] / 100 : null)
    : (f[k100] != null ? qty * u.g * f[k100] / 100 : f[kS] != null && f.servingG ? qty * u.g * f[kS] / f.servingG : null);
  const carb = per('carb100', 'carbServ'), fat = per('fat100', 'fatServ'), both = carb != null && fat != null;
  if (u.key === 'serving' && f.kcalServ != null) {
    const fib = f.fibServ != null ? qty * f.fibServ : f.fib100 != null && f.servingG ? qty * f.servingG * f.fib100 / 100 : null;
    return { kcal: qty * f.kcalServ, pro: qty * (f.proServ || 0), fib, carb: both ? carb : null, fat: both ? fat : null };
  }
  const g = qty * u.g;
  const fib = f.fib100 != null ? g * f.fib100 / 100 : f.fibServ != null && f.servingG ? g * f.fibServ / f.servingG : null;
  return { kcal: g * f.kcal100 / 100, pro: g * (f.pro100 || 0) / 100, fib, carb: both ? carb : null, fat: both ? fat : null };
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
/* =================== v84: CARBS AND FAT =================== */
/* Shown for information only: no target (with calories and protein set, carbs and fat are what's left). Like fibre, unknown
   is never zero. Nothing new is stored on entries: an entry's carbs and fat are worked out from the food it was logged from
   (its own copy first, then the built-in food, the saved food, the saved meal or the home idea as they are now), and only
   while that food still gives the calories that were logged, so a food changed since never rewrites an older day.
   Oil added in cooking counts as fat (9 kcal a gram). Chain menu items have no carb data yet, so Subway extras don't either. */
const hasMac = f => !!f && (f.carb100 != null || f.carbServ != null) && (f.fat100 != null || f.fatServ != null);
const MAC_K = { pro: 4, carb: 4, fat: 9 };
function entryMac(e) {
  const f = e.food; if (!f || !(e.qty > 0) || e.kcal == null || f.source === 'chain' || e.adds?.length) return null;
  const oil = OIL[e.oil]?.k || 0, logged = e.kcal - oil;
  const tryF = s => {
    if (!hasMac(s) || !unitsFor(s).some(u => u.key === e.unit)) return null;
    const v = calc(s, e.qty, e.unit);
    return v.carb != null && Math.abs(v.kcal - logged) <= Math.max(3, logged * 0.03) ? { carb: v.carb, fat: v.fat + oil / 9 } : null;
  };
  const pack = f.cookOf && S.foods.find(x => x.id === f.cookOf), m = mealOf(f);
  const cands = [() => f, () => baseOf(f), () => f.source === 'built-in' && BUILTIN_FOODS.find(b => b.name === f.name),
    () => S.foods.find(x => x.id === f.id), () => pack && cookedOf(pack), () => m && mealFood(m),
    () => f.source === 'idea' && ideaFoods().find(x => x.id === f.id)];
  for (const c of cands) { const r = tryF(c()); if (r) return r; }
  return null;
}
const itemMac = it => it.food ? entryMac({ food: it.food, qty: it.qty, unit: it.unit, kcal: calc(it.food, it.qty, it.unit).kcal }) : null;
/* carbs, fat and protein (from the same foods, so the shares add up) for a day, and how many foods that covers */
/* v85: totals only mean something when the foods with carb data make up most of the day. Kan's first v84 day showed "0g carbs"
   and a 79% protein split from one food (119 of about 2,100 kcal). Below MAC_COVER of the day's calories, it says so instead. */
const MAC_COVER = 0.8;
function dayMac(d) {
  const es = entriesFor(d); let carb = 0, fat = 0, pro = 0, known = 0, knownK = 0, totK = 0;
  es.forEach(e => { const x = entryMac(e); totK += e.kcal || 0; if (x) { carb += x.carb; fat += x.fat; pro += e.pro || 0; known++; knownK += e.kcal || 0; } });
  return { carb, fat, pro, known, total: es.length, knownK, totK, enough: known > 0 && knownK >= MAC_COVER * totK };
}
/* share of calories from protein, carbs and fat (whole percents that add up to 100) */
function macShares(pro, carb, fat) {
  const k = [pro * MAC_K.pro, carb * MAC_K.carb, fat * MAC_K.fat], t = k[0] + k[1] + k[2];
  if (!(t > 0)) return [0, 0, 0];
  const p = k.map(x => x / t * 100), r = p.map(Math.floor);
  let left = 100 - r[0] - r[1] - r[2];
  p.map((x, i) => [x - r[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { r[i]++; left--; } });
  return r;
}
const macPerServ = (f, g) => {
  const v = calc(f, 1, f.kcalServ != null || f.servingG ? 'serving' : 'g');
  if (f.kcalServ == null && !f.servingG) { const w = calc(f, g || 100, 'g'); return w.carb == null ? {} : { carb: r1(w.carb), fat: r1(w.fat) }; }
  return v.carb == null ? {} : { carb: r1(v.carb), fat: r1(v.fat) };
};
function macSplitHtml(pro, carb, fat) {
  const [p, c, f] = macShares(pro, carb, fat);
  return `<div class="mac-split" aria-hidden="true"><i class="m-pro" style="width:${p}%"></i><i class="m-carb" style="width:${c}%"></i><i class="m-fat" style="width:${f}%"></i></div><div class="mac-leg"><span><b class="m-pro"></b>Protein ${p}%</span><span><b class="m-carb"></b>Carbs ${c}%</span><span><b class="m-fat"></b>Fat ${f}%</span></div>`;
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
/* v66: tap the rings to switch between what you've eaten and what's left (remembered on this phone only) */
let ringLeft = (() => { try { return localStorage.getItem('cutlog.ringLeft') === '1'; } catch (e) { return false; } })();
function renderRingNums(cal, pro, T) {
  if (!ringLeft) {
    animateNum($('calNum'), cal); $('calU').textContent = 'kcal';
    animateNum($('proNum'), pro); $('proU').textContent = 'g protein'; return;
  }
  const kl = T.calHi - cal, pl = T.protein - pro;
  animateNum($('calNum'), Math.abs(kl)); $('calU').textContent = kl >= 0 ? 'kcal left' : 'kcal over';
  animateNum($('proNum'), Math.max(0, pl)); $('proU').textContent = pl > 0 ? 'g left' : 'target hit';
}
$('rings').onclick = () => {
  ringLeft = !ringLeft; haptic();
  try { localStorage.setItem('cutlog.ringLeft', ringLeft ? '1' : '0'); } catch (e) {}
  renderTotals(); replay($('rings'), 'swap-in');
};
$('rings').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('rings').click(); } };
function renderTotals() {
  alertsKick();   // v91: the alarm clock's note for today follows the log
  const T = S.targets, es = entriesFor(day);
  const cal = Math.round(es.reduce((a, e) => a + e.kcal, 0));
  const pro = Math.round(es.reduce((a, e) => a + e.pro, 0));
  renderRingNums(cal, pro, T);
  setArc($('calArc'), cal / T.calHi);
  $('calRing').classList.toggle('over', cal > T.calHi);
  const tick = $('calTick'), tl = 1.2;   // short mark where the range starts
  tick.style.strokeDasharray = `${tl} ${RING_C}`; tick.style.strokeDashoffset = -(RING_C * T.calLo / T.calHi) + tl / 2;
  $('calSub').textContent = `of ${T.calLo.toLocaleString()}–${T.calHi.toLocaleString()}`;
  setArc($('proArc'), pro / T.protein);
  $('proSub').textContent = ringLeft ? `of ${T.protein}g protein` : pro >= T.protein ? `${T.protein}g target hit` : `${T.protein - pro}g ${day === todayIso() ? 'to go' : 'short'}`;
  const st = $('status'), before = st.textContent; st.className = 'status';
  queueMicrotask(() => { if (st.textContent !== before) replay(st, 'fade-in'); });
  if (!es.length) st.textContent = 'Scan, snap or search what you eat and the rings fill up.';
  else if (cal < T.calLo && day !== todayIso()) st.textContent = `Finished ${(T.calLo - cal).toLocaleString()} kcal under your range.`;   // v84: past days don't suggest a snack
  else if (cal < T.calLo) st.textContent = mode() === 'gain' ? `${(T.calLo - cal).toLocaleString()} kcal to go to reach your range. Room for another meal.` : `${(T.calLo - cal).toLocaleString()} kcal under your range. Room for a high-protein snack.`;
  else if (cal <= T.calHi) { st.className = 'status ok'; st.textContent = 'In your range for today.'; }
  else { st.className = 'status hi'; st.textContent = `${(cal - T.calHi).toLocaleString()} kcal over your range. One day like this is fine; the weekly trend decides.`; }
  safe(renderFits); safe(renderWeek); safe(renderCiBanner); safe(renderNudge); safe(renderNut); safe(renderGuideBanner); safe(renderEstBanner); safe(renderPlanBtn);
}
let shownRows = { day: null, ids: new Set() };
function renderRows() {
  const es = entriesFor(day), r = $('rows');
  const fresh = shownRows.day === day ? es.filter(e => !shownRows.ids.has(e.id)).map(e => e.id) : [];
  shownRows = { day, ids: new Set(es.map(e => e.id)) };
  $('count').textContent = es.length ? `${es.length} item${es.length > 1 ? 's' : ''}` : '';
  $('rowsHint').hidden = !es.length; renderCopy();
  if (!es.length) { r.innerHTML = '<p class="empty">Nothing logged for this day yet.</p>'; safe(renderShape); return; }
  const rowHtml = e => {
    const time = e.at ? new Date(e.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
    const sub = [e.detail, time].filter(Boolean).join(' · ');
    return `<div class="row${fresh.includes(e.id) ? ' row-in' : ''}" data-id="${esc(e.id)}"><span class="n">${esc(e.name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="c">${Math.round(e.kcal)}<small>kcal</small></span><span class="pill">${fmtG(e.pro)}g</span></div>`;
  };
  r.innerHTML = SLOTS.map(([k, label]) => {
    const g = es.filter(e => slotOf(e) === k); if (!g.length) return '';
    const tk = g.reduce((a, e) => a + e.kcal, 0), tp = g.reduce((a, e) => a + e.pro, 0);
    return `<div class="mgroup"><div class="mg-h"><span><i class="mg-dot s-${k}" aria-hidden="true"></i>${label}</span><span class="mg-t">${Math.round(tk).toLocaleString()} kcal · ${fmtG(tp)}g</span></div>${g.map(rowHtml).join('')}</div>`;
  }).join('');
  safe(renderShape);   // v80
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
  { const mt = mealTimes(); [['tvB', 'breakfast'], ['tvL', 'lunch'], ['tvD', 'dinner'], ['tvE', 'last']].forEach(([id, k]) => { $(id).textContent = hourText(mt[k]); }); }   // v90
  safe(renderAlerts); alertsKick();   // v91
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
  if (PUSH_SLOT && Date.now() < PUSH_SLOT.until) return PUSH_SLOT.slot;   // v91: opened from a meal alert
  if (foodId && S.slotPref?.[foodId]) return S.slotPref[foodId];       // where you usually log this food
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (day === todayIso() && h < 14 && !entriesFor(day).some(e => slotOf(e) === 'breakfast')) return 'breakfast';  // first meal of a late morning
  return timeSlot(Date.now());
}
function slotChips(sel) { return `<div class="chips slots" id="aSlot" role="group" aria-label="Meal">${SLOTS.map(([k, l]) => `<button class="chip" data-s="${k}" aria-pressed="${k === sel}">${l}</button>`).join('')}</div>`; }

/* ---------- log actions ---------- */
function addEntry(name, kcal, pro, detail, src, slot) {
  const e = { id: uid(), name, kcal: r1(kcal), pro: r1(pro), detail: detail || '', at: Date.now(), slot: slot || defaultSlot(src?.food?.id) };
  if (src) { e.food = src.food; e.qty = src.qty; e.unit = src.unit; setFib(e, src.fib); if (src.oil) e.oil = src.oil; if (src.adds?.length) e.adds = src.adds; }
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
const NOT_SAVED = ['built-in', 'meal', 'entry', 'cooked', 'chain', 'idea'];   // v67: chain menu items and home ideas are never saved as foods
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
  if (NOT_SAVED.includes(f.source) && !['built-in', 'cooked', 'chain', 'idea'].includes(f.source)) return;
  f = freshFood(f);
  S.recent = [{ food: f, qty, unit }, ...S.recent.filter(r => r.food.id !== f.id)].slice(0, 12);
}

/* ---------- toast ---------- */
let toastTimer, toastNext = null;
function hideToast() { const t = $('toast'); t.classList.remove('in'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; toastRoom(); if (toastNext) { const [m, a] = toastNext; toastNext = null; setTimeout(() => toast(m, a), 120); } }, 260); }
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
  toastRoom();
}
/* v92: a message shown while a panel is open docks at the panel's bottom edge, and the panel makes room for it (it grows by
   the message's height, or its scrolling part gets that much shorter when it's already full height), so the message never sits on the panel's
   buttons or text. Kan's screenshot: "Dinner left open" landed on the note under Shuffle in Plan my day, because the message
   sat at the height of the hidden tab bar, in the middle of the panel's content. */
function toastRoom() {
  const t = $('toast'), on = SH.open && !t.hidden, root = document.documentElement;
  const had = sheetEl.classList.contains('toast-room');
  if (!on) { root.classList.remove('toast-sheet'); if (had) { const h0 = sheetEl.getBoundingClientRect().height; sheetEl.classList.remove('toast-room'); if (SH.open) glideSheet(h0); } return; }
  const room = Math.ceil(t.getBoundingClientRect().height) + 24;     // the message, 14 px under it and 10 px above it
  const h0 = sheetEl.getBoundingClientRect().height;
  sheetEl.style.setProperty('--toast-room', room + 'px'); sheetEl.classList.add('toast-room');
  const gap = WIDE_Q.matches ? Math.max(0, Math.round((innerHeight - sheetEl.offsetHeight) / 2)) : 0;   // laptop: a centred window
  root.style.setProperty('--sheet-gap', gap + 'px'); root.classList.add('toast-sheet');
  if (!had) glideSheet(h0);
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
  watchAdd(); if (!$('toast').hidden) requestAnimationFrame(toastRoom);   // v92
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
/* v70: How much?'s Add / Save changes button sticks to the bottom of a long panel (v66), with a panel-coloured shadow so
   rows scrolling under it don't show through. That shadow is only drawn while the button is actually stuck (.stuck);
   otherwise it smudged the meal chips above it and covered the top of the button below (Kan: Move to another day). */
let addRO = null;
function stickAdd() {
  const add = $('aAdd');
  if (!add || !add.isConnected || !sheetBody.contains(add)) { if (addRO) { addRO.disconnect(); addRO = null; } return; }
  let p = add.previousElementSibling;
  while (p && !p.getClientRects().length) p = p.previousElementSibling;     // skip hidden rows (spoon note)
  const stuck = !!p && add.getBoundingClientRect().top < p.getBoundingClientRect().bottom + 11;   // 12 px gap when in its own place
  if (add.classList.contains('stuck') !== stuck) add.classList.toggle('stuck', stuck);
}
function watchAdd() {
  if (addRO) { addRO.disconnect(); addRO = null; }
  if (!sheetBody._stickWatch) { sheetBody._stickWatch = true; sheetBody.addEventListener('scroll', stickAdd, { passive: true }); }
  if (!$('aAdd') || !sheetBody.contains($('aAdd'))) return;
  if (typeof ResizeObserver !== 'undefined') {
    addRO = new ResizeObserver(stickAdd); addRO.observe(sheetBody); [...sheetBody.children].forEach(c => addRO.observe(c));
  }
  stickAdd(); requestAnimationFrame(stickAdd);
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
  pick = null; draft = null; PUSH_SLOT = null;   // v91
  if (onSheetClose) { try { onSheetClose(); } catch (e) {} onSheetClose = null; }
  if (!SH.open) return;
  SH.open = false; SH.drag = null; toastRoom();   // v92: the message goes back above the tab bar
  if (adjPending) setTimeout(() => safe(adjCheck), 700);   // v89: the calorie check-in waits for panels to close
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
  const canAdd = !picking && isSubItem(f);                                   // v75: sauce and cheese on Subway subs and salads
  let adds = canAdd ? cleanAdds(f, preset?.adds) : [];
  if (opts.slot) slot = opts.slot;
  openSheet(editing ? 'Edit entry' : 'How much?', `
    <div class="food-head" id="aFood" data-id="${esc(f.id)}"><button type="button" class="pin" id="aPin" aria-pressed="${isPinned(f.cookOf || f.id)}" aria-label="Pin this food">★</button><strong>${esc(f.name)}</strong><span>${esc([f.brand, perLine(f)].filter(Boolean).join(' · '))}</span><span class="ns-row" id="aNs">${nsBadge(f, true)}</span></div>
    ${twin ? `<div class="seg2 st" id="aState" role="group" aria-label="Weighed raw or cooked">${[base, twin].sort((a, b) => stateOf(a) === 'cooked' ? 1 : stateOf(b) === 'cooked' ? -1 : 0).map(x => `<button type="button" data-st="${esc(x.name)}" aria-pressed="${x.name === base.name}">${stateOf(x) === 'dry' ? 'Dry weight' : stateOf(x) === 'raw' ? 'Raw weight' : 'Cooked'}</button>`).join('')}</div>
    <p class="st-hint">Pick how it was when you measured it. Cooking changes the weight, so the numbers differ.${f.cookOf || pkgPair(f) ? ' Cooked is worked out from the package.' : ''}</p>` : ''}
    <div class="stepper">
      <button id="aMinus" aria-label="Less">−</button>
      <input id="aQty" type="number" inputmode="decimal" step="any" min="0" value="${startQty}" aria-label="Amount">
      <button id="aPlus" aria-label="More">+</button>
    </div>
    ${usualHtml(f, startQty, unit)}
    <div class="chips" id="aUnits" role="group" aria-label="Unit">${units.map(u => `<button class="chip" data-u="${u.key}" aria-pressed="${u.key === unit}" title="${esc(u.long || u.label)}">${esc(u.key === 'serving' && f.servingLabel ? 'serving · ' + servLabel(f) : u.label)}</button>`).join('')}</div>
    <div class="result"><div><span class="num" id="aK">0</span><small>kcal</small></div><div class="pro"><span class="num" id="aP">0g</span><small>protein</small></div></div>
    <p class="fib-line" id="aNut" hidden><span id="aM" hidden></span><span id="aF" hidden></span></p>
    ${canOil ? `<div class="oil"><span class="oil-k">Cooked with oil or butter?</span><div class="chips" id="aOil" role="group" aria-label="Cooking oil">${Object.entries(OIL).map(([k, o]) => `<button class="chip" data-oil="${k}" aria-pressed="${k === (oil || 'none')}">${o.t}${o.k ? ` <small>+${o.k}</small>` : ''}</button>`).join('')}</div></div>` : ''}
    ${canAdd ? addsHtml(f, adds) : ''}
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
    ${moreNote(f)}
    <button class="btn" id="aAdd">${esc(cta)}</button>
    ${f.source === 'idea' && !picking && !editing ? '<button class="btn ghost" id="aIdeaMeal">Save as one of my meals</button>' : ''}
    ${NOT_SAVED.includes(f.source) && !f.cookOf ? '' : '<button class="btn ghost" id="aFix">Numbers look wrong? Fix them</button>'}
    ${editing ? '<button class="btn ghost" id="aMove">Move to another day</button><button class="btn danger" id="aDel">Remove from log</button>' : ''}`);
  const upd = () => {
    const v = calc(f, parseFloat($('aQty').value), unit);
    if (oil && v.kcal > 0) v.kcal += OIL[oil].k;
    if (adds.length) { const x = addsVal(f, adds, parseFloat($('aQty').value)); v.kcal += x.kcal; v.pro += x.pro; }
    animateNum($('aK'), v.kcal, undefined, 220); animateNum($('aP'), v.pro, fmtP, 220);
    let fibTxt = v.fib != null && v.fib >= 0.05 ? `${fmtG(v.fib)}g fibre` : null;   // v62: no "0g fibre" on eggs, meat and fish
    if (v.fib == null && v.kcal > 0) {      // v50: a meal with some ingredients missing fibre data
      const pf = mealPartFood(mealOf(f)), pv = pf && calc(pf, parseFloat($('aQty').value), unit);
      if (pv?.fib != null && Math.abs(pv.kcal - v.kcal) <= Math.max(3, pv.kcal * 0.03)) fibTxt = `at least ${fmtG(pv.fib)}g fibre (not every ingredient has fibre data)`;
    }
    $('aF').hidden = !fibTxt || !(v.kcal > 0); if (fibTxt) $('aF').textContent = fibTxt;
    const mFat = v.fat != null ? v.fat + (oil ? OIL[oil].k / 9 : 0) : null;     // v84: oil counts as fat
    $('aM').hidden = v.carb == null || !(v.kcal > 0) || adds.length > 0; if (v.carb != null) $('aM').textContent = `${fmtG(v.carb)}g carbs · ${fmtG(mFat)}g fat`;
    $('aNut').hidden = $('aM').hidden && $('aF').hidden;      // carbs, fat and fibre share one line
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
  $('aPin').onclick = () => { const on = togglePin(f); $('aPin').setAttribute('aria-pressed', on); toast(on ? 'Pinned. It sits at the top of search.' : 'Unpinned'); };
  if ($('aUsual')) $('aUsual').onclick = e => {      // v66: one tap for an amount you usually have
    const b = e.target.closest('[data-q]'); if (!b) return;
    unit = b.dataset.u; $('aQty').value = b.dataset.q; haptic();
    [...$('aUnits').children].forEach(c => c.setAttribute('aria-pressed', c.dataset.u === unit));
    [...$('aUsual').querySelectorAll('[data-q]')].forEach(c => c.setAttribute('aria-pressed', c === b));
    $('aUnits').querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    upd();
  };
  $('aQty').addEventListener('input', () => $('aUsual')?.querySelectorAll('[data-q]').forEach(c => c.setAttribute('aria-pressed', c.dataset.q === $('aQty').value && c.dataset.u === unit)));
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
  if ($('aAdds')) $('aAdds').onclick = e => {
    const b = e.target.closest('[data-add]'); if (!b) return;
    const k = b.dataset.add, a = SUB_ADD[k]; haptic();
    if (k === 'none') adds = adds.filter(x => SUB_ADD[x].t !== 'sauce');
    else if (k === 'nocheese') adds = adds.filter(x => SUB_ADD[x].t !== 'cheese');
    else if (adds.includes(k)) adds = adds.filter(x => x !== k);
    else adds = cleanAdds(f, [...adds.filter(x => a.t === 'sauce' || SUB_ADD[x].t !== 'cheese'), k]);   // any sauces, one cheese
    $('aAdds').querySelectorAll('[data-add]').forEach(c => c.setAttribute('aria-pressed', c.dataset.add === 'none' ? !adds.some(x => SUB_ADD[x].t === 'sauce') : c.dataset.add === 'nocheese' ? !adds.some(x => SUB_ADD[x].t === 'cheese') : adds.includes(c.dataset.add)));
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
  if ($('aIdeaMeal')) $('aIdeaMeal').onclick = () => saveIdeaMeal(f);
  if ($('aFix')) $('aFix').onclick = () => {
    const was = { preset: { qty: parseFloat($('aQty').value) || 1, unit, oil }, opts: { ...opts, slot } };   // v50: come back to the same amount
    if (f.cookOf) {     // v65: on the Cooked view, fix the pack's label numbers, then come back to Cooked
      const pk = S.foods.find(x => x.id === f.cookOf) || PKG_SEEN.get(f.cookOf); if (!pk) return;
      const pg = pk.servingG || null, pp = pk.kcalServ != null ? { kcal: pk.kcalServ, pro: pk.proServ } : pg ? { kcal: pk.kcal100 * pg / 100, pro: (pk.pro100 || 0) * pg / 100 } : { kcal: pk.kcal100, pro: pk.pro100 };
      openSheet('Fix the numbers', `<p class="hint">Enter what the package label says for one serving (the raw or dry numbers). Cooked is worked out from them.</p><div id="labelOut"></div>`);
      labelForm($('labelOut'), { kcal: Math.round(pp.kcal), pro: r1(pp.pro || 0), fib: fibPerServ(pk, pg), ...macPerServ(pk, pg), servingG: pg || (pk.kcalServ == null ? 100 : null) }, '', pk.barcode || null, pk.name, pk.id, { ...was, cooked: true });
      return;
    }
    const g = f.servingG || null;
    const per = f.kcalServ != null ? { kcal: f.kcalServ, pro: f.proServ }
      : g ? { kcal: f.kcal100 * g / 100, pro: (f.pro100 || 0) * g / 100 } : { kcal: f.kcal100, pro: f.pro100 };
    openSheet('Fix the numbers', `<p class="hint">Enter what the label says for one serving. The app will use your numbers for this food from now on.</p><div id="labelOut"></div>`);
    labelForm($('labelOut'), { kcal: Math.round(per.kcal), pro: r1(per.pro || 0), fib: fibPerServ(f, g), ...macPerServ(f, g), servingG: g || (f.kcalServ == null ? 100 : null) }, '', f.barcode || null, f.name, f.id, was);
  };
  $('aAdd').onclick = () => {
    const q = parseFloat($('aQty').value);
    if (!(q > 0)) { toast('Enter how much you had.'); return; }
    const v = calc(f, q, unit), oilD = (oil ? ` · ${OIL[oil].d}` : '') + addsD(adds), detail = `${fmtQty(q)} ${unitWord(f, unit, q)}${oilD}`;
    if (oil) v.kcal += OIL[oil].k;
    if (adds.length) { const x = addsVal(f, adds, q); v.kcal += x.kcal; v.pro += x.pro; }
    if (!(editing && S.foods.some(x => x.id === f.id && x !== f))) rememberFood(f);   // an entry's old copy never overwrites the saved food
    if (f.cookOf && !S.foods.some(x => x.id === f.cookOf) && PKG_SEEN.has(f.cookOf)) rememberFood(PKG_SEEN.get(f.cookOf));   // v63: a new pack logged as Cooked is saved too
    pushRecent(f, q, unit); touchMeta(); renderSettings();
    if (picking) { pick = null; picking.onDone(f, q, unit, v); return; }
    if (editing) {
      const moved = editEntry && slotOf(editEntry) !== slot;
      if (editEntry) { Object.assign(editEntry, { kcal: r1(v.kcal), pro: r1(v.pro), detail, food: f, qty: q, unit, slot }); setFib(editEntry, v.fib); if (oil) editEntry.oil = oil; else delete editEntry.oil; if (adds.length) editEntry.adds = adds; else delete editEntry.adds; }
      if (moved) { S.slotPref[f.id] = slot; touchMeta(); }      // moving a food teaches the app where it usually goes
      touchDay(day); renderTotals(); renderRows(); closeSheet();
      toast(moved ? `Moved to ${SLOTS.find(s => s[0] === slot)[1]}. It'll go there next time too.` : 'Entry updated'); return;
    }
    S.slotPref[f.id] = slot;
    // logging the same thing again in the same meal adds to the existing line
    const same = entriesFor(day).find(x => x.food && x.food.id === f.id && x.unit === unit && slotOf(x) === slot && (x.oil || null) === oil && addsKey(x) === adds.join(','));   // a different oil choice gets its own line
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
    addEntry(f.name, v.kcal, v.pro, detail, { food: f, qty: q, unit, fib: v.fib, oil, adds }, slot);
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
  let kS, pS, fS, cS, tS;
  if (ks != null && ks >= 1 && Math.abs(ks - scaled) > Math.max(2, ks * 0.5)) {
    kS = ks; pS = offNum(n['proteins_serving']) ?? 0; fS = offNum(n['fiber_serving']); cS = offNum(n['carbohydrates_serving']); tS = offNum(n['fat_serving']);
  } else {
    const mass = ['fat_100g', 'carbohydrates_100g', 'proteins_100g'].reduce((s, k) => s + (offNum(n[k]) || 0), 0);
    if (!(sq <= 30 && f.kcal100 >= 1 && scaled < 1 && mass > 0 && Math.abs(mass - sq) <= sq * 0.25)) return false;
    kS = f.kcal100; pS = f.pro100 || 0; fS = offNum(n['fiber_100g']); cS = offNum(n['carbohydrates_100g']); tS = offNum(n['fat_100g']);
  }
  f.kcalServ = kS; f.proServ = pS;
  f.kcal100 = Math.min(kS / sq * 100, MAX_KCAL100); f.pro100 = Math.min(pS / sq * 100, 100);
  delete f.fib100; delete f.fibServ;
  if (fS != null && fS >= 0) { f.fibServ = fS; f.fib100 = Math.min(fS / sq * 100, 100); }
  delete f.carb100; delete f.fat100; delete f.carbServ; delete f.fatServ;      // v84: carbs and fat follow the serving numbers too
  if (cS != null && tS != null && cS >= 0 && tS >= 0) { f.carbServ = cS; f.fatServ = tS; f.carb100 = Math.min(cS / sq * 100, 100); f.fat100 = Math.min(tS / sq * 100, 100); }
  return true;
}
/* fibre and Nutri-Score, when Open Food Facts has them */
function offExtras(f, p) {
  const n = p.nutriments || {};
  if (n['fiber_100g'] != null && n['fiber_100g'] !== '' && +n['fiber_100g'] >= 0) f.fib100 = +n['fiber_100g'];
  else if (f.kcalServ != null && n['fiber_serving'] != null && n['fiber_serving'] !== '' && +n['fiber_serving'] >= 0) f.fibServ = +n['fiber_serving'];
  if (nsOk(p.nutriscore_grade)) f.nutri = p.nutriscore_grade;
  // v84: carbs and fat (both, or neither): per 100 g, or per serving for foods that only have serving numbers
  const c100 = offNum(n['carbohydrates_100g']), ft100 = offNum(n['fat_100g']), cS = offNum(n['carbohydrates_serving']), ftS = offNum(n['fat_serving']);
  if (f.kcal100 != null && c100 != null && ft100 != null && c100 >= 0 && ft100 >= 0) { f.carb100 = Math.min(c100, 100); f.fat100 = Math.min(ft100, 100); }
  else if (f.kcalServ != null && cS != null && ftS != null && cS >= 0 && ftS >= 0) { f.carbServ = cS; f.fatServ = ftS; }
  return f;
}
const OFF_FIELDS = 'product_name,product_name_en,product_name_fr,brands,nutriments,serving_quantity,serving_size,nutriscore_grade';
/* Foods scanned before v41 have no fibre or grade. The first time one is opened, ask Open Food Facts once and add only
   those two things; calories and protein are never touched (they may have been fixed by hand). */
const enrichTried = new Set();
const macTried = new Set();     // v84: foods already asked for carbs and fat this session
async function enrichFood(f) {
  if (!f?.barcode || f.source !== 'scan' || !navigator.onLine) return;
  const needNs = f.nutri === undefined && !hasFib(f) && !enrichTried.has(f.id), needMac = !hasMac(f) && !macTried.has(f.id);   // v84: older scans get carbs and fat once too
  if (!needNs && !needMac) return;
  if (needNs) enrichTried.add(f.id); if (needMac) macTried.add(f.id);
  try {
    const res = await fetch(`${OFF}/api/v2/product/${f.barcode}.json?fields=${needMac ? OFF_FIELDS : 'nutriments,nutriscore_grade'}`);
    if (!res.ok) { macTried.delete(f.id); return; }
    const j = await res.json(); if (j.status !== 1 || !j.product) return;
    const add = offExtras({ kcalServ: f.kcalServ }, j.product);
    const saved = S.foods.find(x => x.id === f.id);
    if (needNs) [f, saved].forEach(t => { if (!t) return; t.nutri = add.nutri || ''; if (add.fib100 != null) t.fib100 = add.fib100; else if (add.fibServ != null && t.kcalServ != null) t.fibServ = add.fibServ; });
    /* carbs and fat only from a reading that gives this food's own calories (so a pack fixed by v60 or by hand isn't mixed up) */
    const fresh = needMac && offToFood(j.product, f.barcode), same = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(1, b * 0.03);
    if (fresh && hasMac(fresh)) {
      const k100 = same(fresh.kcal100, f.kcal100), kS = same(fresh.kcalServ ?? (fresh.kcal100 != null && f.servingG ? fresh.kcal100 * f.servingG / 100 : null), f.kcalServ);
      if (k100 || kS) [f, saved].forEach(t => { if (!t || hasMac(t)) return;
        if (fresh.carb100 != null) { t.carb100 = fresh.carb100; t.fat100 = fresh.fat100; } if (fresh.carbServ != null) { t.carbServ = fresh.carbServ; t.fatServ = fresh.fatServ; } });
    }
    if (!needNs && !hasMac(f)) return;
    touchMeta(); renderTotals();
    if (SH.open && $('sheetTitle').textContent === 'How much?' && $('aFood')?.dataset.id === f.id) { $('aNs').innerHTML = nsBadge(f, true); $('aQty').dispatchEvent(new Event('input')); }
  } catch (e) { macTried.delete(f.id); /* offline or blocked: try again next visit (v85: carbs retry once back online) */ }
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
    if (!editing) setTimeout(() => offerRecount(f.id), 2700);
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
  let kcal = null, pro = null, fib = null, carb = null, fat = null, servingG = null, servingText = '';
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
    if (carb == null && /(carbohydrate|glucides)/.test(low)) {     // v84: "Carbohydrate / Glucides 22 g", "Total Carbohydrate 22g"
      const after = low.slice(low.search(/carbohydrate|glucides/));
      const m = after.match(/(\d{1,3}(?:[.,]\d)?)\s*g/);
      if (m) carb = num(m[1]);
    }
    if (fat == null && /\b(fat|lipides)\b/.test(low) && !/satur|trans|from fat|calories/.test(low)) {   // "Fat / Lipides 7 g", not saturated or trans
      const after = low.slice(low.search(/\b(fat|lipides)\b/));
      const m = after.match(/(\d{1,3}(?:[.,]\d)?)\s*g/);
      if (m) fat = num(m[1]);
    }
    if (servingG == null && /(per|pour|serving|portion|size)/.test(low)) {
      const m = low.match(/\(?\s*(\d{1,4}(?:[.,]\d)?)\s*(g|ml|mℓ)\b/);
      if (m) { servingG = num(m[1]); servingText = l.replace(/\s+/g, ' ').slice(0, 60); }
    }
  }
  if (servingG == null) { const m = text.match(/\(\s*(\d{1,4})\s*(g|ml)\s*\)/i); if (m) { servingG = num(m[1]); servingText = m[0]; } }
  return { kcal, pro, fib, carb, fat, servingG, servingText };
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
    <div class="grid2">
      <label>Carbs per serving (g)<input id="lC" type="number" inputmode="decimal" min="0" value="${p.carb ?? ''}" placeholder="Optional"></label>
      <label>Fat per serving (g)<input id="lFat" type="number" inputmode="decimal" min="0" value="${p.fat ?? ''}" placeholder="Optional"></label>
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
    const cb = parseFloat($('lC').value), ft = parseFloat($('lFat').value);     // v84: carbs and fat count only as a pair
    if (cb >= 0 && cb < 1000 && ft >= 0 && ft < 1000) { f.carbServ = cb; f.fatServ = ft; }
    if (g > 0) { f.servingG = g; f.servingLabel = g + ' g'; f.kcal100 = k / g * 100; f.pro100 = pr / g * 100; if (f.fibServ != null) f.fib100 = fb / g * 100;
      if (f.carbServ != null) { f.carb100 = cb / g * 100; f.fat100 = ft / g * 100; } }
    const old = keepId && (S.foods.find(x => x.id === keepId) || PKG_SEEN.get(keepId)); if (old && nsOk(old.nutri)) f.nutri = old.nutri;   // keep the grade when fixing numbers
    if (old?.brand) f.brand = old.brand;     // v65: and the brand
    rememberFood(f); touchMeta(); renderSettings();
    const to = then?.cooked ? (pkgPair(f) ? cookedOf(f) : f) : f;     // v65: fixed from the Cooked view -> back to Cooked
    const back = then && unitsFor(to).some(u => u.key === then.preset.unit) ? then.preset : to.cookOf ? { qty: 100, unit: 'g' } : { qty: 1, unit: 'serving' };
    openAmount(to, back, { ...(then?.opts || {}), asIs: true });
    if (old) offerRecount(f.id, then?.opts?.editId);
  };
}

/* v66: the amounts you usually log for this food (from the last 90 days), most frequent first, up to 3 */
function usualAmounts(f) {
  const id = f.id, keys = unitsFor(f).map(u => u.key), seen = new Map(), since = shift(todayIso(), -90);
  Object.keys(S.log).filter(d => d >= since).sort().forEach(d => S.log[d].forEach(e => {
    if (!e.food || e.food.id !== id || !(e.qty > 0) || !keys.includes(e.unit)) return;
    const k = `${r1(e.qty)}|${e.unit}`, x = seen.get(k) || { qty: r1(e.qty), unit: e.unit, n: 0, at: '' };
    x.n++; x.at = d; seen.set(k, x);
  }));
  return [...seen.values()].sort((a, b) => b.n - a.n || (a.at < b.at ? 1 : -1)).slice(0, 3);
}
function usualHtml(f, q, u) {
  const list = usualAmounts(f); if (!list.length) return '';
  return `<div class="chips usual" id="aUsual" role="group" aria-label="Your usual amounts"><span class="usual-k">Usual</span>${list.map(x =>
    `<button type="button" class="chip" data-q="${fmtQty(x.qty)}" data-u="${x.unit}" aria-pressed="${fmtQty(x.qty) === String(q) && x.unit === u}">${fmtQty(x.qty)} ${esc(unitWord(f, x.unit, x.qty))}</button>`).join('')}</div>`;
}

/* ---------- search ---------- */
/* v66: pinned foods (S.pins: food ids, saved or built-in; synced in settings, created on the first pin) */
const isPinned = id => !!S.pins?.includes(id);
function togglePin(f) {
  const id = f.cookOf || f.id; S.pins ||= [];
  if (isPinned(id)) S.pins = S.pins.filter(x => x !== id); else S.pins.unshift(id);
  if (!NOT_SAVED.includes(f.source) && !S.foods.some(x => x.id === id)) rememberFood(f);   // a pinned new scan is kept
  touchMeta(); haptic(); return isPinned(id);
}
const pinnedFoods = () => (S.pins || []).map(id => S.foods.find(f => f.id === id) || BUILTIN_FOODS.find(f => f.id === id) || CHAIN_FOODS.find(f => f.id === id) || ideaFoods().find(f => f.id === id)).filter(Boolean);
/* v66: protein per 100 kcal, so the lean choice stands out (chicken breast about 19, oats about 3.5) */
function proPer100(f) {
  const k = f.kcal100 != null ? f.kcal100 : f.kcalServ, p = f.kcal100 != null ? f.pro100 : f.proServ;
  return k > 0 && p != null ? p / k * 100 : null;
}
function ppBadge(f) {
  const v = proPer100(f); if (v == null || v < 1) return '';
  return `<span class="pp${v >= 8 ? ' hi' : ''}" title="grams of protein per 100 kcal">${v >= 10 ? Math.round(v) : r1(v)}g protein / 100 kcal</span>`;
}
function listHtml(items) {
  return items.map((it, i) => `<button class="item" data-i="${i}"><span class="nm">${isPinned(it.f.cookOf || it.f.id) ? '<i class="pin-dot" aria-label="Pinned">★</i>' : ''}${esc(it.f.name)}${it.f.brand ? `<small>${esc(it.f.brand)}</small>` : ''}${ppBadge(it.f)}</span>
    ${nsBadge(it.f)}<span class="meta">${esc(it.meta || (it.f.kcal100 != null ? Math.round(it.f.kcal100) + ' kcal/100g' : Math.round(it.f.kcalServ) + ' kcal/serv'))}</span></button>`).join('');
}
function openSearch() {
  openSheet(pick ? (pick.title || 'Add an ingredient') : 'Search foods', `
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
      const pins = pinnedFoods(), pinIds = new Set(pins.map(f => f.id));
      const lastOf = id => S.recent.find(r => (r.food.cookOf || r.food.id) === id);
      const pItems = pins.map(f => { const r = lastOf(f.id); return r ? { f: r.food.cookOf ? r.food : f, preset: r, meta: `last: ${fmtQty(r.qty)} ${unitWord(r.food, r.unit, r.qty)}` } : { f }; });
      const rItems = S.recent.filter(r => !pinIds.has(r.food.cookOf || r.food.id)).map(r => ({ f: r.food, preset: r, meta: `last: ${fmtQty(r.qty)} ${unitWord(r.food, r.unit, r.qty)}` }));
      items = [...pItems, ...rItems];
      const ph = pItems.length ? '<h3>Pinned</h3>' + listHtml(pItems) : '';
      const rh = rItems.length ? '<h3>Recent</h3>' + listHtml(rItems).replace(/data-i="(\d+)"/g, (m, i) => `data-i="${+i + pItems.length}"`) : '';
      if (items.length) $('results').innerHTML = ph + rh;
      else { items = BUILTIN_FOODS.slice(0, 10).map(f => ({ f })); $('results').innerHTML = '<h3>Common foods</h3>' + listHtml(items); }
      $('online').hidden = true;
    } else {
      const words = q.split(/\s+/);
      const match = f => words.every(w => (f.name + ' ' + (f.brand || '') + ' ' + (f.alias || '')).toLowerCase().includes(w));
      // best matches first: name starts with it, then a word starts with it, then anywhere. Saved foods lead within each group.
      const rank = f => { const n = f.name.toLowerCase(); return n.startsWith(q) ? 0 : n.split(/[^a-z0-9%]+/).some(w => w.startsWith(words[0])) ? 1 : n.includes(words[0]) ? 2 : 3; };
      items = [...S.foods.filter(match), ...BUILTIN_FOODS.filter(match)].map((f, i) => ({ f, r: rank(f), i }))
        .sort((a, b) => (isPinned(b.f.id) - isPinned(a.f.id)) || a.r - b.r || a.i - b.i).slice(0, 30).map(x => ({ f: x.f }));   // v66: pinned first
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
  // v84: carbs and fat the same way, only when every ingredient has them
  const macs = (m.items || []).map(itemMac);
  if (macs.length && macs.every(x => x)) {
    const c = macs.reduce((a, x) => a + x.carb, 0), ft = macs.reduce((a, x) => a + x.fat, 0);
    f.carbServ = c / n; f.fatServ = ft / n; if (m.cookedG > 0) { f.carb100 = c / m.cookedG * 100; f.fat100 = ft / m.cookedG * 100; }
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
function metaDoc() { return { targets: S.targets, meals: S.meals, foods: S.foods, recent: S.recent, theme: S.theme || 'cobalt', slotPref: S.slotPref || {}, name: S.name || '', scale: S.scale || 'daily', units: S.units || 'imperial', startWeight: S.startWeight ?? null, milestones: S.milestones || {}, msInit: !!S.msInit, pins: S.pins || [], updatedAt: S.stamps.meta || Date.now() }; }
function applyDay(id, data) {
  if (data.entries && data.entries.length) S.log[id] = data.entries; else delete S.log[id];
  if (data.weight != null) S.weights[id] = data.weight; else delete S.weights[id];
  S.waist ||= {}; if (data.waist != null) S.waist[id] = data.waist; else delete S.waist[id];
  S.stamps.days[id] = data.updatedAt || 0;
  S.dirty = S.dirty.filter(k => k !== 'd:' + id);
}
function applyMeta(data) {
  ['targets', 'meals', 'foods', 'recent', 'theme', 'slotPref', 'name', 'scale', 'units', 'startWeight', 'milestones', 'msInit', 'pins'].forEach(k => { if (data[k] !== undefined) S[k] = data[k]; });
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
  Sync.user = user; setSync('syncing'); setTimeout(quietVerifyCheck, 3000);   // v64: notice a confirmed email by itself
  setTimeout(() => safe(() => { renderAlerts(); alertsSync(); }), 2000);   // v91: alerts need the sign-in
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
  const busy = on => ['aIn', 'aUp', 'aReset'].forEach(id => { if ($(id)) $(id).disabled = on; });   // v64: the panel may have closed already
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
    const b = $('aCheckVer'); if (b.disabled) return;
    b.disabled = true; b.textContent = 'Checking…'; haptic();
    const r = await checkVerified(8000);
    if ($('aCheckVer')) { $('aCheckVer').disabled = false; $('aCheckVer').textContent = "I've confirmed it"; }
    if (r === 'yes') { toast('Email confirmed ✓'); if (SH.open && $('sheetTitle').textContent === 'Cloud sync') openAccount(); }
    else if (r === 'no') toast('Not confirmed yet. Tap the link in the email first.');
    else if (r === 'slow') toast('Taking too long. Close and reopen Cut Log, it checks again by itself.');
    else toast('Couldn’t check. Are you online?');
  };
}
/* v65: when a saved food's numbers are fixed (Fix them, Edit numbers, the v60 spray repair), entries already logged with it keep
   the numbers they were logged with (v50 rule). This offers to recount them: "Recount 3 earlier logs?" -> Recount, with Undo.
   Covers plain and cooked entries (cooked ones are recounted from the fixed pack), keeps each entry's amount, unit and oil.
   Meals that use the food as an ingredient are left as they are. */
function staleEntries(id, skip) {
  const f = S.foods.find(x => x.id === id); if (!f) return [];
  const out = [];
  Object.entries(S.log).forEach(([d, es]) => es.forEach(e => {
    if (!e.food || e.id === skip || !(e.qty > 0) || (e.food.id !== id && e.food.cookOf !== id)) return;
    const base = e.food.cookOf ? (pkgPair(f) ? cookedOf(f) : null) : f;
    if (!base || !unitsFor(base).some(u => u.key === e.unit)) return;
    const v = calc(base, e.qty, e.unit), k = v.kcal + (OIL[e.oil]?.k || 0);
    if (Math.abs(k - e.kcal) > Math.max(1, e.kcal * 0.02) || Math.abs(v.pro - e.pro) > 0.5) out.push({ d, e, base, k, v });
  }));
  return out;
}
function offerRecount(id, skip) {
  const list = staleEntries(id, skip); if (!list.length) return;
  const n = list.length, word = n === 1 ? 'log' : 'logs';
  toast(`Recount ${n} earlier ${word}?`, { label: 'Recount', fn: () => {
    const prev = list.map(({ e }) => ({ e, was: { kcal: e.kcal, pro: e.pro, food: e.food, fib: e.fib } }));
    list.forEach(({ e, base, k, v }) => { e.kcal = r1(k); e.pro = r1(v.pro); e.food = { ...base }; setFib(e, v.fib); });
    [...new Set(list.map(x => x.d))].forEach(d => touchDay(d)); renderTotals(); renderRows();
    toast(`Recounted ${n} ${word}`, { label: 'Undo', fn: () => {
      prev.forEach(({ e, was }) => { Object.assign(e, { kcal: was.kcal, pro: was.pro, food: was.food }); setFib(e, was.fib); });
      [...new Set(list.map(x => x.d))].forEach(d => touchDay(d)); renderTotals(); renderRows();
    } });
  } }, { wait: true });
}

/* v64: ask Firebase whether the email is confirmed. On Kan's iPhone the check never finished after he came back from
   tapping the link in Safari (likely iOS stalling the home-screen app's storage, which Firebase waits on), so the button
   seemed to do nothing. Now it gives up after a few seconds with a clear message, and the app also checks by itself on
   launch and whenever it comes back to the screen. Returns 'yes', 'no', 'slow' or 'error'. */
let verChecking = null, verSince = 0;
function checkVerified(ms = 8000) {
  const u = Sync.auth?.currentUser; if (!u) return Promise.resolve('error');
  if (u.emailVerified) return Promise.resolve('yes');
  if (!verChecking || Date.now() - verSince > 5000) { verSince = Date.now(); const mine = verChecking = (async () => {
    await null;   // so 'mine' is set before anything below can finish
    try { await u.reload(); const now = Sync.auth.currentUser || u; if (now.emailVerified) { try { await now.getIdToken(true); } catch (e) {} return 'yes'; } return 'no'; }
    catch (e) { return 'error'; } finally { if (verChecking === mine) verChecking = null; }
  })(); }   // a check stuck for over 5 s is replaced by a fresh one, not waited on again
  return Promise.race([verChecking, new Promise(ok => setTimeout(() => ok('slow'), ms))]);
}
async function quietVerifyCheck() {
  const u = Sync.auth?.currentUser; if (!u || u.emailVerified || document.hidden) return;
  const r = await checkVerified(15000);
  if (r === 'yes' && SH.open && $('sheetTitle').textContent === 'Cloud sync') { openAccount(); toast('Email confirmed ✓'); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(quietVerifyCheck, 800); });

/* =================== TRENDS =================== */
let range = 30, tab = 'today', chartAnim = false;
/* v72: a day counts as hitting protein, or being in or over the calorie range, exactly when Today says so. Today shows
   rounded totals (180 g), but these checks used the exact sum (179.7 g), so Kan's 180 g Sunday read "target hit" on Today and
   "0/3 protein days" in the check-in. Only how days are counted changes; nothing stored changes. */
const proHit = (g, T = S.targets) => Math.round(g) >= T.protein;
const kcalOver = (k, T = S.targets) => Math.round(k) > T.calHi;
const kcalIn = (k, T = S.targets) => Math.round(k) >= T.calLo && !kcalOver(k, T);
/* v76: on a cut, a day a little under the range is still a good day. The weekly check-in counts any day up to the top of the
   range as on target, and only flags days that are very low (more than 300 kcal under the range: 1,800 for Kan), since eating
   that little often costs muscle and energy. Maintaining and building still count the range itself. */
const LOW_GAP = 300;
const kcalLow = (k, T = S.targets) => Math.round(k) < T.calLo - LOW_GAP;
const kcalOnTarget = (k, T = S.targets) => mode() === 'lose' ? !kcalOver(k, T) && !kcalLow(k, T) : kcalIn(k, T);
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
/* v76: average calories over the finished, logged days the weekly rate looks at (the last 14 days, today left out). The slow-loss
   tip only says to eat less when that average is above the bottom of the range: telling someone already at 2,050 to cut 200 more
   would push them under it. */
function recentIntake() {
  const t = todayIso(), v = [];
  for (let i = 1; i <= RATE_MIN_DAYS; i++) { const x = dayTotals(shift(t, -i)); if (x) v.push(x.kcal); }
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
/* v71: the goal date shows the year when it isn't this year ("Dec 2027"), so a date over a year away doesn't read as weeks away */
const etaText = d => d.getFullYear() === new Date().getFullYear() ? esc(d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  : `${esc(d.toLocaleDateString(undefined, { month: 'short' }))}<small class="eta-y"> ${d.getFullYear()}</small>`;   // the year smaller, so it fits the tile
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
   burn = average intake − (weight change per day × 3,500 kcal per lb)
   v79 (Kan's Trends, 30 Oct: 2,052 kcal a day and "3.1 lb a week" gave a burn of 3,600 and offered +750 kcal):
   - the weight change comes from the trend line (each weigh-in's 7-day average), like the weekly rate since v59, not the raw dots;
   - the first 2 weeks after your first weigh-in are left out: early loss is mostly water and stored carbs, not fat, and the
     3,500 kcal per lb rule only holds for fat, so it made the burn look far higher than it is. Food is counted over the same days. */
const BURN_WINDOW = 28, KCAL_PER_LB = 3500, BURN_SETTLE = 14;
function burnStart() {                  // the first day the burn may use: 2 weeks after your first weigh-in
  const first = weightsArr()[0]; return first ? shift(first.date, BURN_SETTLE) : null;
}
function estimateBurn() {
  const to = shift(todayIso(), -1), w0 = shift(to, -(BURN_WINDOW - 1));   // today isn't finished, so it's left out of intake
  const settle = burnStart(), from = settle && settle > w0 ? settle : w0, skipped = !!settle && settle > w0;
  const logged = [];
  for (let d = from; d <= to; d = shift(d, 1)) { const t = dayTotals(d); if (t) logged.push(t.kcal); }
  const arr = weightsArr(), wts = arr.filter(w => w.date >= from && w.date <= todayIso());
  const span = wts.length ? (parseIso(wts[wts.length - 1].date) - parseIso(wts[0].date)) / 864e5 : 0;
  const need = { days: 10, weighs: scale() === 'daily' ? 7 : 3, span: 14 };
  const have = { days: logged.length, weighs: wts.length, span: Math.round(span) };
  if (have.days < need.days || have.weighs < need.weighs || have.span < need.span) return { ready: false, need, have, skipped, settle, from };
  const intake = logged.reduce((a, b) => a + b, 0) / logged.length;
  const perWeek = slopePerWeek(trendPts(wts, arr));
  if (perWeek == null) return { ready: false, need, have, skipped, settle, from };
  const burn = intake - (perWeek / 7) * KCAL_PER_LB;
  const conf = have.days >= 21 && have.weighs >= 14 && have.span >= 21 ? 'High' : 'Medium';
  return { ready: true, intake, perWeek, burn, conf, have, skipped, from, days: daysBetween(from, to) + 1 };
}
/* v79: targets move toward the real burn in steps of up to 250 kcal. Even a good estimate has some error, so a big gap is
   closed over a few check-ins, each one confirmed by the next week's weigh-ins (no jumping 750 kcal overnight). */
const BURN_STEP = 250;
function burnStep(lo, hi, T = S.targets) {
  const gap = (lo + hi) / 2 - (T.calLo + T.calHi) / 2;
  if (Math.abs(gap) <= BURN_STEP) return { lo, hi, capped: false };
  const d = Math.sign(gap) * BURN_STEP, nlo = Math.max(1200, T.calLo + d);
  return { lo: nlo, hi: Math.max(nlo + 100, T.calHi + d), capped: true };
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
    const settleTxt = e.skipped ? `<p class="hint" id="bSettle">Your first 2 weeks of weigh-ins are left out, because early weight loss is mostly water, not fat. Counting starts ${esc(parseIso(e.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}.</p>` : '';
    box.innerHTML = `<p class="hint">After about 4 weeks of logging food and weighing in, this shows how many calories you actually burn a day, worked out from what you eat and how your weight moves. No watch needed.</p>${settleTxt}
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
  const T = S.targets, st = burnStep(lo, hi, T), same = T.calLo === st.lo && T.calHi === st.hi;
  const lossTxt = e.perWeek < -0.05 ? `lost ${fW(Math.abs(e.perWeek))} ${wU()} a week` : e.perWeek > 0.05 ? `gained ${fW(e.perWeek)} ${wU()} a week` : 'held your weight steady';
  box.innerHTML = `
    <div class="burn-n"><span class="num" id="burnNum">${r50(e.burn).toLocaleString()}</span><span class="u">kcal a day</span></div>
    <p class="hint">Over the last ${e.days >= BURN_WINDOW ? '4 weeks' : `${e.days} days`} you ate about ${Math.round(e.intake).toLocaleString()} kcal a day and ${lossTxt} on your trend line. That works out to this daily burn, including your training.${e.skipped ? ' Your first 2 weeks of weigh-ins are left out, because early loss is mostly water.' : ''}</p>
    <div class="suggest">
      <div><span class="k">${label}</span><span class="v">${lo.toLocaleString()}–${hi.toLocaleString()}<small>kcal</small></span></div>
      <div><span class="k">Your target now</span><span class="v">${T.calLo.toLocaleString()}–${T.calHi.toLocaleString()}<small>kcal</small></span></div>
    </div>
    ${st.capped && !same ? `<p class="hint" id="bStep">That's a big change, so move there in steps: ${st.lo > T.calLo ? 'up' : 'down'} ${BURN_STEP} kcal now, then check again after a week of weigh-ins.</p>` : ''}
    ${same ? '<p class="hint">Your target already matches. Nothing to change.</p>' : `<button class="btn" id="useBurn">Use ${st.lo.toLocaleString()}–${st.hi.toLocaleString()} as my target</button>`}
    <p class="hint">Only as accurate as your logging: days with forgotten snacks make your burn look lower than it is.</p>`;
  if ($('viewTrends').classList.contains('anim') || chartAnim) { const n = $('burnNum'); n._v = 0; animateNum(n, r50(e.burn), undefined, 800); }
  if ($('useBurn')) $('useBurn').onclick = () => {
    const old = { ...S.targets };
    S.targets = { ...S.targets, calLo: st.lo, calHi: st.hi, adjWk: weekStart(todayIso()) }; touchMeta(); renderAll();   // v89: counts as this week's change
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
  /* v71: the sign only shows when the rounded number isn't zero (no "−0.0") */
  const sgn = d => { const v = fW(Math.abs(d)); return (+v === 0 ? '' : d > 0 ? '+' : '−') + v; };
  $('tRate').textContent = rate == null ? '–' : sgn(rate);
  $('tNow').textContent = now ? fW(now) : '–';
  /* v71: on the 7-day view the old Change compared two windows that almost fully overlap (it sat at 0.0), so it compares this
     week's average with the week before instead. 30 and 90 days are as before. */
  if (range < RATE_MIN_DAYS) {
    const wb = avgBetween(arr, shift(to, -13), shift(to, -7));
    $('tChangeK').textContent = 'Vs last week'; $('tChange').textContent = now != null && wb != null ? sgn(now - wb) : '–';
  } else {
    $('tChangeK').textContent = 'Change';
    $('tChange').textContent = inR.length >= 2 ? sgn(avgBetween(arr, shift(to, -6), to) - avgBetween(arr, inR[0].date, shift(inR[0].date, 6))) : '–';
  }
  /* v71: the rate always looks back at least 14 days, so on the 7-day view say so (otherwise 7 and 30 days look identical for no reason) */
  const src = $('tRateSrc'); src.hidden = rate == null || range >= RATE_MIN_DAYS;
  if (!src.hidden) src.textContent = `Rate from the last ${RATE_MIN_DAYS} days of weigh-ins`;
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
      $('tEta').innerHTML = etaText(eta);
      const r = Math.abs(rate), verb = dir < 0 ? 'Losing' : 'Gaining';
      const [slow, fast] = dir < 0 ? [0.5, 1.6] : [0.2, 0.8];
      const ate = recentIntake(), full = ate != null && (dir < 0 ? Math.round(ate) <= T.calLo : Math.round(ate) >= T.calHi);   // v76
      if (r < slow && full) read.textContent = `${verb} ${fW(r)} ${wU()} a week, which is slow, but you're already eating about ${kc(ate)} kcal a day, ${dir < 0 ? 'at or under the low end' : 'at or over the top'} of your range. Give it another week of full logging before ${dir < 0 ? 'cutting further' : 'eating more'}.`;
      else if (r < slow) read.textContent = `${verb} ${fW(r)} ${wU()} a week, which is slow. ${dir < 0 ? 'Trimming' : 'Adding'} about 200 kcal a day would speed it up.`;
      else if (r <= fast) { read.className = 'status ok'; read.textContent = `${verb} ${fW(r)} ${wU()} a week, a steady pace${dir < 0 ? ' that protects your strength' : ' for lean gains'}.`; }
      else { read.className = 'status hi'; read.textContent = `${verb} ${fW(r)} ${wU()} a week, on the fast side. ${dir < 0 ? 'Adding' : 'Trimming'} 200–300 kcal a day would ease the pace.`; }
    } else { $('tEta').textContent = '–'; read.className = 'status hi'; read.textContent = `Your weight isn't moving toward your goal over this range. Check that you're logging everything, and aim for the ${dir < 0 ? 'low' : 'high'} end of your calorie range.`; }
  }
  renderBurn(); renderMilestones(); safe(renderCheckin);
  $('tWeightChart').innerHTML = weightChart(from, to);
  $('tWHist').hidden = arr.length < 2; $('tCalHist').hidden = !firstLogDay();   // v55
  $('tShape').hidden = shapeDays('all').length < SHAPE_MIN;   // v80
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
    colorFor: v => kcalOver(v) ? 'var(--warn)' : kcalIn(v) ? 'var(--protein)' : 'var(--accent)' }) : empty;
  $('tProChart').innerHTML = logged.length ? barChart(days, tots.map(t => t && t.pro), {
    line: T.protein, ticks: [50, 100, 150, 200, 250], label: 'Daily protein',
    colorFor: v => proHit(v) ? 'var(--protein)' : 'var(--accent)' }) : empty;
  $('tCalNote').textContent = logged.length ? 'Green band is your cut range. Tap a bar to open that day.' : '';
  safe(() => renderFibChart(days)); safe(() => renderMacChart(days));
  $('tProNote').textContent = logged.length ? `Dashed line is your ${T.protein}g target.` : '';
  $('tProHist').hidden = !logged.length;   // v87
  const inRange = logged.filter(t => kcalIn(t.kcal)).length, hit = logged.filter(t => proHit(t.pro)).length;
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
  const r = e.target.closest('rect[data-day]');
  if (!r) { const c = e.target.closest('#tProChart,#tMacChart,#tFibChart');   // v87: the rest of the chart opens its full history
    if (c && c.querySelector('svg')) openNutHistory({ tProChart: 'pro', tMacChart: 'mac', tFibChart: 'fib' }[c.id]); return; }
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
const proStreak = () => runLength(d => { const t = dayTotals(d); return !!t && proHit(t.pro); });
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
  setTimeout(() => { c.hidden = true; showNextCel(); if (c.hidden && adjPending) setTimeout(() => safe(adjCheck), 500); }, 320);
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
      <p class="hint">${OB.goal === 'lose' ? `This aims for about ${OB.units === 'metric' ? '0.5–0.7 kg' : '1–1.5 lb'} a week. ` : OB.goal === 'gain' ? `This aims for a slow, lean gain of about ${OB.units === 'metric' ? '0.25 kg' : '0.5 lb'} a week. ` : ''}After about 4 weeks of logging and weighing in, the "Your real burn" card on Trends works out your actual burn from your own data and can fine-tune these.</p>
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
    box.innerHTML = `${head}<p class="hint">Your real burn on Trends takes about 4 weeks of logging and weigh-ins. Until then, answer 4 quick questions for an estimate. Nothing is saved.</p>
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
  const src = sug.src === 'burn' ? `Worked out from your real burn of about ${r50(sug.burn).toLocaleString()} kcal a day, from your recent weeks of logging and weigh-ins.`
    : `Based on an estimated burn of about ${sug.burn.toLocaleString()} kcal a day. Once Trends has about 4 weeks of your logging and weigh-ins, your real burn takes over.`;
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
  if (!(T.protein > 0) || proHit(pro, T)) return null;
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
/* More nutrients on Today: carbs and fat (v84), then fibre, counted only from foods that have the data, and saying how many that is */
function renderNut() {
  const box = $('nutBox'), es = entriesFor(day); box.hidden = !es.length; if (!es.length) return;
  const f = dayFib(day), g = Math.round(f.g);
  const any = f.known || f.part, pm = f.part > 1 ? `${f.part} meals` : 'a meal';
  const m = dayMac(day), mp = m.known < m.total, ge = mp ? '≥ ' : '';
  $('nutSumC').hidden = !m.enough; $('nutSumC').textContent = m.enough ? `${Math.round(m.carb)}g carbs ·` : '';   // v84 (v85: only with enough data)
  fillMacs(es);
  /* with carbs alongside, "at least" shortens to ≥ (as inside); the carbs part only shows when the summary fits on one line */
  $('nutSum').textContent = any ? `${f.known < f.total ? (m.enough ? '≥ ' : 'at least ') : ''}${g}g fibre` : 'no fibre data';
  const ns = $('nutSum').parentElement; if (m.enough && ns.getBoundingClientRect().height > parseFloat(getComputedStyle(ns).lineHeight || 18) * 1.5) {
    $('nutSumC').hidden = true; if (any && f.known < f.total) $('nutSum').textContent = `at least ${g}g fibre`; }
  /* v86: shorter (Kan, 4 Nov) */
  const cover = f.known === f.total ? `From all ${f.total} food${f.total > 1 ? 's' : ''}.`
    : f.part ? `${f.known ? `From ${f.known} of ${f.total} foods plus` : 'From'} known meal ingredients, so it's likely higher.`
    : f.known ? `From ${f.known} of ${f.total} foods, so it's likely higher.`
    : 'No fibre data for these foods yet.';
  const pc = m.totK > 0 ? Math.round(m.knownK / m.totK * 100) : 0;
  const macHtml = !m.enough ? `<div class="nut-mac" id="nutMac"><div class="nut-row"><span>Carbs and fat</span><b id="nutCarb">–</b></div>
    <p class="hint" id="nutMacNote">${m.known ? `Only ${m.known} of ${m.total} foods have carb data so far (${pc}% of today's calories), too little to add up.` : "None of today's foods have carb data yet."} Totals show once most of the day does.</p>${missingMacHtml(es)}</div>`
    : `<div class="nut-mac" id="nutMac">${macSplitHtml(m.pro, m.carb, m.fat)}
    <div class="nut-row"><span>Carbs</span><b id="nutCarb">${ge}${Math.round(m.carb)}g</b></div>
    <div class="nut-row"><span>Fat</span><b id="nutFat">${ge}${Math.round(m.fat)}g</b></div>
    <p class="hint" id="nutMacNote">${mp ? `From ${m.known} of ${m.total} foods; the rest have no carb data. ` : ''}No target: carbs and fat are what's left after protein. A big carb day can show up as water weight the next morning, not fat.</p>${missingMacHtml(es)}</div>`;
  $('nutBody').innerHTML = `${macHtml}<div class="nut-row"><span>Fibre</span><b>${any ? (f.known < f.total ? '≥ ' : '') + g + 'g' : '–'}</b></div>
    <div class="prog"><i style="width:${Math.round(Math.min(1, f.g / FIB_HI) * 100)}%"></i></div>
    <p class="hint" id="nutFibNote">Aim for ${FIB_LO}–${FIB_HI}g a day. ${cover}</p>
    ${missingFibHtml(es)}`;
}
let nutRz = 0; addEventListener('resize', () => { clearTimeout(nutRz); nutRz = setTimeout(() => safe(renderNut), 150); });   // v84: the summary re-fits on a new width
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
    ${m.fix.length ? `<span class="nut-miss-k">Missing fibre. Tap to add it from the label:</span>
      <div class="chips wrap" id="fibFix">${m.fix.map(f => `<button class="chip" data-fib="${esc(f.id)}" title="${esc(f.name)}"><span>${esc(f.name)}</span> <small>+ fibre</small></button>`).join('')}</div>` : ''}
    ${m.other.length ? `<p class="hint">${m.fix.length ? 'Also' : 'No fibre data'}: ${esc(m.other.join(', '))}.</p>` : ''}</div>`;
}
$('nutBody').addEventListener('click', e => { const b = e.target.closest('[data-fib]'); if (b) { haptic(); openAddFibre(b.dataset.fib); } });
/* v85: which of the day's foods have no carb data, with the same one-tap fix as fibre for saved foods (and meal ingredients) */
function missingMac(es) {
  const fix = new Map(), other = new Map();
  es.forEach(e => {
    if (entryMac(e)) return;
    const f = e.food, saved = f && S.foods.find(x => x.id === (f.cookOf || f.id));
    if (saved) { if (!hasMac(saved)) fix.set(saved.id, saved); else other.set('ch' + e.id, `${e.name} (logged before its numbers changed)`); return; }
    const m = mealOf(f);
    if (m && m.items?.length) {
      const gaps = m.items.filter(it => !itemMac(it));
      gaps.forEach(it => { const s2 = S.foods.find(x => x.id === it.food.id);
        if (s2 && !hasMac(s2)) fix.set(s2.id, s2); else other.set('mi' + it.food.id, `${it.food.name} (in ${m.name})`); });
      if (gaps.length) return;
      other.set('mc' + e.id, `${e.name} (the meal has changed since this was logged)`); return;
    }
    other.set((f?.id || 'q') + e.name, `${e.name}${!f ? ' (quick add)' : f.source === 'chain' || e.adds?.length ? ' (restaurant menus have no carb data yet)' : ''}`);
  });
  return { fix: [...fix.values()], other: [...other.values()] };
}
function missingMacHtml(es) {
  const m = missingMac(es); if (!m.fix.length && !m.other.length) return '';
  return `<div class="nut-miss" id="macMiss">
    ${m.fix.length ? `<span class="nut-miss-k">No carb data yet. Tap one to add it from its label:</span>
      <div class="chips wrap" id="macFix">${m.fix.map(f => `<button class="chip" data-mac="${esc(f.id)}" title="${esc(f.name)}"><span>${esc(f.name)}</span> <small>+ carbs</small></button>`).join('')}</div>` : ''}
    ${m.other.length ? `<p class="hint">${m.fix.length ? 'Also' : 'No carb data'}: ${esc(m.other.join(', '))}.</p>` : ''}</div>`;
}
$('nutBody').addEventListener('click', e => { const b = e.target.closest('[data-mac]'); if (b) { haptic(); openAddMac(b.dataset.mac); } });
/* scanned foods in the day without carbs ask Open Food Facts by themselves (once a session each), no need to open them */
function fillMacs(es) {
  if (!navigator.onLine) return;
  if (!fillMacs.on) { fillMacs.on = 1; addEventListener('online', () => safe(renderNut)); }    // retry when the phone is back online
  const want = new Map();
  es.forEach(e => { const f = e.food; if (!f) return;
    const ids = [f.cookOf || f.id, ...(mealOf(f)?.items || []).map(it => it.food?.id)];
    ids.forEach(id => { const s2 = id && S.foods.find(x => x.id === id); if (s2?.barcode && s2.source === 'scan' && !hasMac(s2) && !macTried.has(s2.id)) want.set(s2.id, s2); }); });
  [...want.values()].slice(0, 8).forEach(f => enrichFood(f));
}
/* add carbs and fat to a saved food without touching its calories, so earlier entries of it start counting too */
function openAddMac(id) {
  const f = S.foods.find(x => x.id === id); if (!f) return;
  const perServ = f.kcalServ != null || f.servingG, per = perServ ? `serving${f.servingG ? ` (${esc(servLabel(f))})` : ''}` : '100 g';
  openSheet('Add carbs and fat', `
    <div class="food-head"><strong>${esc(f.name)}</strong><span>${esc([f.brand, perLine(f)].filter(Boolean).join(' · '))}</span></div>
    <p class="hint">Per ${per}, in grams.</p>
    <div class="grid2">
      <label>Carbs<input id="amC" type="number" inputmode="decimal" min="0" step="0.1" placeholder="e.g. 22"></label>
      <label>Fat<input id="amF" type="number" inputmode="decimal" min="0" step="0.1" placeholder="e.g. 7"></label>
    </div>
    <p class="hint">On the Nutrition Facts table they're the "Carbohydrate / Glucides" and "Fat / Lipides" lines. Enter 0 if it says 0.</p>
    <button class="btn" id="amSave">Save carbs and fat</button>`);
  setTimeout(() => $('amC')?.focus(), 350);
  $('amSave').onclick = () => {
    const c = parseFloat($('amC').value), ft = parseFloat($('amF').value);
    if (!(c >= 0 && c < 1000 && ft >= 0 && ft < 1000)) { toast('Enter both numbers from the label.'); return; }
    if (perServ) { f.carbServ = c; f.fatServ = ft; if (f.servingG) { f.carb100 = c / f.servingG * 100; f.fat100 = ft / f.servingG * 100; } }
    else { f.carb100 = c; f.fat100 = ft; }
    touchMeta(); renderTotals(); closeSheet(); haptic();
    toast(`Added to ${f.name}. Earlier entries count too.`);
  };
}
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

/* v84: Trends carbs and fat card: hidden until a day in the range has carb data; days without it are left out, never zero */
function renderMacChart(days) {
  const ms = days.map(dayMac), vals = ms.map(m => m.enough ? m.carb : null), have = vals.filter(v => v != null);   // v85: days with most food covered
  $('macCard').hidden = !have.length; if (!have.length) return;
  let P = 0, C = 0, F = 0; ms.forEach(m => { if (m.enough) { P += m.pro; C += m.carb; F += m.fat; } });
  $('tMacAvg').textContent = `avg ${Math.round(have.reduce((a, b) => a + b, 0) / have.length)}g carbs`;
  $('tMacChart').innerHTML = barChart(days, vals, { ticks: [50, 100, 150, 200, 250, 300, 400], label: 'Daily carbs', colorFor: () => 'var(--carb)' });
  $('tMacSplit').innerHTML = macSplitHtml(P, C, F);
  const part = ms.some(m => m.enough && m.known < m.total);
  $('tMacNote').textContent = `Average share of calories on the ${have.length} day${have.length > 1 ? 's' : ''} where most food has carb data; other days are left out.${part ? ' Foods without carb data aren\'t counted.' : ''}`;
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
    <p>The <b>New to Cut Log?</b> banner on Today opens this guide; tap its ✕ to hide it. The guide is always here in You → Help.</p>
    <p>After each update, <b>What's new</b> shows once when you open the app. You can read every update any time in You → Help → What's new.</p>
    <p>To back up and sync with a laptop, tap the pill at the top right and sign in. Syncing works once your email has been added to the invite list, so ask the person who shared the app. Until then, everything still works on your phone.</p>`],
  ['Logging food', `
    <p><b>Scan barcode</b> for packaged food. If it isn't in the free database, snap the label once and the app remembers that barcode next time.</p>
    <p><b>Snap label</b> reads a Nutrition Facts photo on your phone. Check the numbers it found before saving.</p>
    <p><b>Search</b> covers whole foods, Nigerian and Canadian dishes, your saved foods, and packaged foods online. Nothing fits? Use <b>Enter a food by hand</b>, or <b>Quick add</b> for just calories and protein (good for samples or a meal out).</p>
    <p>On <b>How much?</b> pick an amount in pieces, servings, grams, cups or spoons. No scale? Use your hand: a <b>palm</b> of meat (about 100 g), a <b>fist</b> of rice or pasta (about a cup), a <b>cupped hand</b> of snacks, a <b>thumb</b> of oil or peanut butter. Dishes come in <b>small, regular and large</b> plates or bowls, with a picture guide.</p>
    <p>Staples like chicken, rice and pasta have a <b>Raw weight / Cooked</b> switch: pick how it was when you measured it. Your own packs of chicken, beef, fish, rice, pasta and oats get it too, whether the name is in English or French: the package numbers are for raw or dry food, and Cooked works out what they come to after cooking (it opens cooked next time if that's how you logged it last). Food you cook yourself asks <b>Cooked with oil or butter?</b> Oil is the most common hidden source of calories.</p>
    <p>Tap the <b>★</b> on a food to pin it: pinned foods sit at the top of search. Under the amount, <b>Usual</b> shows the amounts you log most, one tap each. Search results show <b>protein per 100 kcal</b>; green means a lean, high-protein choice.</p>
    <p>If a food's numbers are wrong, tap <b>Numbers look wrong? Fix them</b> (it works on the Cooked view too, fixing the pack). Food you already logged keeps its old numbers until you tap <b>Recount</b> when Cut Log offers it, so past days never change by surprise.</p>
    <p>Packaged foods may show a <b>Nutri-Score</b> letter from A (most nutritious) to E (least).</p>
    <p>Food is grouped into Breakfast, Lunch, Dinner and Snacks, and the app learns where you usually put each food. <b>Tap any entry</b> to change the amount, move it to another meal or day, or remove it (with Undo). <b>Copy from yesterday</b> repeats a whole day or one meal.</p>`],
  ['My meals', `
    <p>Build a meal once from its ingredients and log it with one tap after that. Set how many servings it makes.</p>
    <p>Cooking a big pot? Weigh the whole pot once it's cooked (without the pot) and enter the <b>cooked weight</b>. Then log whatever you dish out by grams or by hand portion.</p>
    <p>If the app closes while you're building a meal, it keeps your progress. My meals shows <b>Finish your unsaved meal</b>.</p>`],
  ['The Today screen', `
    <p>The left ring is calories, with a small mark where your range starts. The right ring is protein. <b>Tap the rings</b> to switch between what you've eaten and what's <b>left</b> for the day; tap again to switch back.</p>
    <p>Below the rings: how your day is going, a <b>protein nudge</b> if protein falls behind your calories, <b>What fits</b> (foods from your own list that fit what's left, in a row you can swipe; its last tile is <b>More ideas</b>: simple high-protein meals to make at home and McDonald's, Tim Hortons and Subway items that fit, lighter picks first in the evening; Subway subs and salads are counted without sauce or cheese, so pick yours on How much?, and a salad gets a double portion of sauce) and <b>This week</b> (calories banked or over across the week, and how much you can eat today and stay on budget). Only days you logged count; days with nothing logged are named underneath so you know they're left out.</p>
    <p><b>Plan my day</b>, under the logging buttons, builds a day of meals from what you actually eat (your saved meals and the foods you've logged in the last 4 weeks, at your usual amounts) plus a rotating home idea or two, aiming for your calorie range and protein target. <b>Today</b> plans the meals still ahead, following your <b>meal times</b> (You → Meal times; nothing after your latest meal, 8 pm unless you change it). In the hour before your latest meal it keeps what's left <b>light</b> (protein first, up to 450 kcal) however many calories are left, so a late meal doesn't hurt your sleep; the rest stays in your weekly budget. <b>Tomorrow</b> plans a whole day. Not sure what dinner will be yet? Tap <b>Plan later</b>: it's left open, with room kept for it (about your usual dinner), and the rest is planned around it. Log it as usual when you know. Log a meal with one tap, or tap a food to change its amount first. Ate something else? It offers to <b>re-plan the rest</b>. Already made tomorrow's breakfast? <b>Choose breakfast</b> and pick it (your meals, usual foods, home ideas or any food); it's <b>locked</b> in and the rest of the day is planned around it. Lock any planned meal you like the same way. <b>Shuffle</b> changes only what isn't locked and avoids repeating your last few plans. Change your targets and the plan re-plans itself to match. It shows up once you've logged a few days.</p>
    <p>Open This week and tap <b>See past weeks and months</b> for your <b>History</b>: a calendar of each month with every day's calories (green in range, orange over, blue under), what each week banked, and every month's averages. Swipe it for other months, and tap a day to open it.</p>
    <p>Once you've logged two or more meals, the Eaten header shows which meal is the biggest ("Breakfast 48%", or a 🏆 when a meal sets your protein record) with a thin bar under it of how your day splits between breakfast, lunch, dinner and snacks; each meal heading has a dot in its colour. Tap either for <b>When you eat</b>: each meal's share and average over 4 weeks, 3 months or all time, your heaviest and lightest meal, what time you usually finish eating, <b>the morning after</b> (how the next weigh-in moves after bigger vs lighter dinners; that's mostly food and water, not fat) your meal split <b>week by week</b>, <b>records</b>, and <b>badges</b> to earn (like done eating by 8 pm 7 days in a row, or 30g+ protein at every main meal). It's also on Trends under Calories. The morning after waits for about two weeks of daily weigh-ins and only calls it a link when the gap is clearly bigger than your normal day-to-day swing.</p>
    <p><b>More nutrients</b>, under your food list, shows your <b>carbs and fat</b> and how your calories split between protein, carbs and fat. There's no carb target: with calories and protein set, carbs and fat are what's left. A big carb day can show up as water weight the next morning, not fat. Carbs come from packaged foods, the built-in foods and labels you type in (chain menu items don't have them yet); foods without them aren't counted, and it says how many foods it's from. Totals only show once foods with carb data make up most of the day's calories; until then it lists the foods missing them, and a tap adds the numbers from the label (scanned foods fill in by themselves).</p>
    <p>It also shows fibre. It only counts foods that have fibre data, so it says "at least" when some don't. A meal counts the ingredients that have it. Foods missing it are listed there; tap one to add the number from its label.</p>`],
  ['Weigh-ins and waist', `
    <p>Pick <b>Every morning</b>, <b>Once a week</b> or <b>No scale</b> in You → Weigh-ins. Weigh after the bathroom, before food or water.</p>
    <p>Daily weight jumps around by a few pounds from water, salt and carbs. The <b>7-day average</b> is the number that matters.</p>
    <p>Don't know your weight and no scale? In setup (or in Goal suggestions) tap <b>Don't know your weight? Estimate it</b>. It's a rough guess from your clothing sizes (a formula built from 507 measured adults), used only for your starting targets. After two weeks the app asks for one real weigh-in, at a pharmacy, gym or a friend's place.</p>
    <p>Tap the weight chart, or <b>See full weight history</b>, to see every weigh-in back to your first: 1 month to all time, your goal line, monthly averages, and drag along the chart to read any day.</p>
    <p>Measure your <b>waist</b> at the belly button, relaxed, every two weeks. A shrinking waist is one of the clearest signs of fat loss, and it works without a scale.</p>`],
  ['Trends', `
    <p><b>Weight trend</b> shows how fast you're losing or gaining each week, and the date you'd reach your goal (with the year when it's further off). It appears after about a week of weigh-ins. If your loss is slow but you're already eating at the low end of your range, it suggests another week of full logging rather than eating less. The rate always looks back at least 14 days, because a single week of weigh-ins is mostly water; on the 7-day view, <b>Vs last week</b> compares this week's average with the week before.</p>
    <p>The <b>weekly check-in</b> sums up last week every Monday: average calories and protein, weight change, and a one-line verdict. When you're cutting, a day a little under your range still counts as <b>on target</b>; it only flags days more than 300 kcal under it, since eating that little often costs muscle.</p>
    <p><b>Your real burn</b> works out how many calories you actually burn from what you eat and how your weight moves (no watch needed). It uses your weight trend line, and leaves out your first 2 weeks of weigh-ins, because early weight loss is mostly water, so it's ready after about 4 weeks. Then it can suggest better targets. Big changes are offered in steps of up to ${BURN_STEP} kcal, so each one is checked by the next week's weigh-ins.</p>
    <p><b>Calorie check-in pop-up:</b> when your calories should change, Cut Log asks you, at most once a week. It's either your real burn (in steps of up to ${BURN_STEP} kcal) or your weight trend moving much faster than your goal calls for, two weeks in a row (it asks you to log a full week first if too many days are missing). <b>Yes</b> updates your target (with Undo); <b>Not now</b> leaves it until next week.</p>
    <p>Charts for calories, protein, carbs (with your average protein, carbs and fat split) and fibre: tap a bar to open that day. <b>See calendar by month</b> under Calories opens your History. <b>See full protein history</b>, <b>See full carbs and fat history</b> and <b>See full fibre history</b> (or a tap on the chart outside the bars) show every day since you started, with a 7-day average line, drag-to-read, and each month's average. The 3M, 6M and 1Y buttons come on once you've logged longer than the range before them. Plus consistency stats and <b>milestones</b> with a little celebration.</p>`],
  ['Your settings', `
    <p>In <b>You</b>: your name, goal (Cutting, Maintaining or Building) with suggested targets, weigh-in frequency, lb or kg, <b>meal times</b> (when you usually have breakfast, lunch and dinner, and your latest meal; Plan my day plans around them), eight app colours (Cobalt, Ember, Teal, Violet, Rose, Gold, Graphite, Sky), Light or Dark, your saved foods, and a backup file you can keep in iCloud Drive.</p>
    <p><b>Notifications</b> (You → Notifications): a lunch or dinner check that only comes when that meal isn't logged yet, a last call 30 minutes before your latest meal with what's left for today, and a weigh-in reminder at your own time (every morning, or your chosen day if you weigh in weekly). Breakfast and Monday check-in alerts are there too, off to start. They need Cut Log on your Home Screen and Cloud sync sign-in, and they're set separately on each phone. Tap an alert to open the right screen.</p>
    <p>Your age, height and sex are only used to suggest targets. They're never saved.</p>`],
  ['What to expect', `
    <p><b>First week:</b> your weight will bounce around. That's water, not fat. Keep logging and weighing.</p>
    <p><b>After about a week:</b> your weekly rate and goal date show up on Trends.</p>
    <p><b>After about 4 weeks:</b> your real burn is ready and can fine-tune your targets (your first 2 weeks of weigh-ins are left out, because that early drop is mostly water).</p>
    <p>Hand portions, plate sizes and dishes are estimates. Being consistent matters more than being exact, because your real burn adjusts to how you log.</p>
    <p>A steady cut is about 0.5–1% of your body weight a week. Hitting your protein target most days helps keep muscle while you lose fat.</p>
    <p>A day over your range is fine. The weekly trend decides your progress.</p>`],
];
const GUIDE_KEY = 'cutlog.guide', GUIDE_DAYS = 7;
function guideState() { try { return JSON.parse(localStorage.getItem(GUIDE_KEY)) || {}; } catch (e) { return {}; } }
function setGuide(x) { try { localStorage.setItem(GUIDE_KEY, JSON.stringify({ ...guideState(), ...x })); } catch (e) {} }
function openGuide() {
  setGuide({ seen: 1 }); $('guideBanner').hidden = true; $('guideWrap').hidden = true;
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
  $('guideWrap').hidden = b.hidden;      // v68: the banner sits in a wrapper with its ✕
}
$('guideBtn').onclick = () => { haptic(); openGuide(); };
$('guideBanner').onclick = () => { haptic(); openGuide(); };
/* v68: ✕ hides the banner for good on this device, same as having opened the guide */
$('guideX').onclick = () => { setGuide({ seen: 1 }); haptic(); renderGuideBanner(); toast('The guide stays in You → Help'); };

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
  if (tt) return kcalOver(tt.kcal) ? 'over' : kcalIn(tt.kcal) ? 'ok' : 'under';
  return first && x >= first ? 'miss' : 'pre';
}
/* a month's numbers, from finished days only (today is still in progress) */
function monthStats(m) {
  const T = S.targets, t = todayIso(), first = firstLogDay(), days = monthDays(m).filter(x => x < t);
  const tots = days.map(dayTotals).filter(Boolean), n = tots.length, avg = k => n ? tots.reduce((a, x) => a + x[k], 0) / n : null;
  const ws = weightsArr().filter(w => ym(w.date) === m).map(w => w.lb);
  return { m, n, kcal: avg('kcal'), pro: avg('pro'), inRange: tots.filter(x => kcalIn(x.kcal)).length,
    proHit: tots.filter(x => proHit(x.pro)).length, miss: days.filter(x => first && x >= first && !dayTotals(x)).length,
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
      const tt = dayTotals(x), c = dayClass(x, tt, t, first), pro = tt && proHit(tt.pro), dt = parseIso(x);
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
function whSpanTxt(d0) {
  const n = daysBetween(d0, todayIso()) + 1, when = parseIso(d0).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `Change and rate: your trend line, ${when} to today (${n} days).`;
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
  const stats = tile(signed(ch, n => n.toFixed(1)), `${wU()} change`, goodness(fromW(ch))) + tile(rate == null ? '–' : signed(rate, n => n.toFixed(1)), `${wU()} a week`, rate == null ? '' : goodness(fromW(rate)))
    + tile(low.lb.toFixed(1), `lowest, ${esc(parseIso(low.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}`) + tile(Gd == null ? '–' : Math.abs(Gd).toFixed(1), Gd == null ? 'to goal' : mode() === 'maintain' ? `${wU()} from goal` : `${wU()} to goal`);
  // months, newest first
  const months = []; all.forEach(w => { const m = ym(w.date), x = months[months.length - 1]; if (x && x.m === m) x.v.push(w.lb); else months.push({ m, v: [w.lb] }); });
  const mrows = months.map((x, i) => { const a = x.v.reduce((s, v) => s + v, 0) / x.v.length, b = i ? months[i - 1].v.reduce((s, v) => s + v, 0) / months[i - 1].v.length : null, d = b == null ? null : a - b;
    return `<div class="whm"><b>${esc(monthName(x.m))}</b><span class="r"><b>${a.toFixed(1)}</b><small class="${d == null ? '' : goodness(fromW(d))}">${d == null ? `avg ${wU()}` : `avg · ${signed(d, n => n.toFixed(1))} ${wU()}`}</small></span><small>${x.v.length} weigh-in${x.v.length > 1 ? 's' : ''} · ${Math.min(...x.v).toFixed(1)}–${Math.max(...x.v).toFixed(1)}</small></div>`; }).reverse().join('');
  box.innerHTML = `<div class="wh-read" id="whRead" aria-live="polite"></div><div class="wh-chart" id="whChart">${svg}</div>`
    + `<p class="hint">Dots are weigh-ins; the line is your 7-day average${withG ? ' and the dashed line your goal' : ''}. Drag along the chart to read any day.</p>`
    + `<div class="hs-sum wh-stats" id="whStats">${stats}</div>`
    + `<p class="hint" id="whSpan">${whSpanTxt(p0.date)}</p>`
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

/* ===================== v87: NUTRIENT HISTORY ===================== */
/* Kan (4 Nov): tapping protein, carbs and fibre on Trends should open a full history like "See full weight history".
   One panel, three kinds: protein, carbs and fat, fibre. Daily bars (coloured like the Trends cards), a 7-day average line,
   the target (protein) or the 25–38g band (fibre), drag to read any day, the range in numbers and every month underneath.
   Days count the same way as the Trends cards: protein from every logged day, fibre only on days where some food has fibre
   data, carbs and fat only on days where most food has carb data (dayMac().enough). Averages use finished days (today is in
   progress). Read-only: the kind, range and Carbs/Fat choice live in memory; nothing is stored. */
const NH = { k: 'pro', r: '3m', mk: 'carb', pts: null, i: 0 };
const NH_KIND = {
  pro: { title: 'Protein history', name: 'protein' },
  mac: { title: 'Carbs and fat history', name: 'carbs and fat' },
  fib: { title: 'Fibre history', name: 'fibre' }
};
/* one day's value for what's being charted (null = no data that day, never zero) */
function nhVal(k, d, cache) {
  if (k === 'pro') { const t = dayTotals(d); return t ? t.pro : null; }
  if (k === 'fib') { const f = dayFib(d); return f.known || f.part ? f.g : null; }
  const m = cache[d] || (cache[d] = dayMac(d)); return m.enough ? m : null;     // carbs and fat: the whole object
}
const nhHit = (k, v) => k === 'pro' ? proHit(v) : k === 'fib' ? Math.round(v) >= FIB_LO : false;
function nhColor(k, v) {
  if (k === 'pro') return proHit(v) ? 'var(--protein)' : 'var(--accent)';
  if (k === 'fib') return v >= FIB_LO ? 'var(--protein)' : 'var(--accent)';
  return NH.mk === 'fat' ? 'var(--fat)' : 'var(--carb)';
}
function nhStep(max) { for (const s of [5, 10, 20, 25, 50, 100, 200, 250, 500]) if (max / s <= 4.5) return s; return 1000; }
function openNutHistory(k) {
  NH.k = NH_KIND[k] ? k : 'pro';
  const which = NH.k === 'mac' ? `<div class="seg2" id="nhWhich" role="group" aria-label="Show">${[['carb', 'Carbs'], ['fat', 'Fat']].map(([v, l]) => `<button type="button" data-nk="${v}" aria-pressed="${v === NH.mk}">${l}</button>`).join('')}</div>` : '';
  openSheet(NH_KIND[NH.k].title, `<div class="chips wh-r" id="nhRange" role="group" aria-label="Range">${WH_R.map(([kk, l]) => `<button class="chip" data-nr="${kk}" aria-pressed="${kk === NH.r}">${l}</button>`).join('')}</div>${which}<div class="wh" id="nhWrap"></div>`, wideSheet());
  renderNutHistory();
  sheetBody.onclick = e => {
    const b = e.target.closest('[data-nr]'), w = e.target.closest('[data-nk]'), o = e.target.closest('#nhOpen');
    if (o) { const p = NH.pts && NH.pts[NH.i]; if (!p) return; closeSheet(); day = p.date; showTab('today'); renderAll(); return; }
    if (b && !b.disabled && b.dataset.nr !== NH.r) { NH.r = b.dataset.nr; [...$('nhRange').children].forEach(c => c.setAttribute('aria-pressed', c === b)); haptic(); renderNutHistory(); }
    if (w && w.dataset.nk !== NH.mk) { NH.mk = w.dataset.nk; [...$('nhWhich').children].forEach(c => c.setAttribute('aria-pressed', c === w)); haptic(); renderNutHistory(); }
  };
}
const nhG = v => `${Math.round(v)}<small>g</small>`;
function nhRead(i) {
  const p = NH.pts && NH.pts[i]; if (!p) return;
  const k = NH.k, word = k === 'mac' ? (NH.mk === 'fat' ? 'fat' : 'carbs') : NH_KIND[k].name;
  const extra = k === 'mac' ? `<span class="tr2">${NH.mk === 'fat' ? `${Math.round(p.m.carb)}g carbs` : `${Math.round(p.m.fat)}g fat`}</span>` : '';
  $('nhRead').innerHTML = `<span class="dt">${esc(parseIso(p.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}${p.date === todayIso() ? ' · today so far' : ''}</span>`
    + `<span class="n">${Math.round(p.v)}<small>g ${word}</small></span><span class="tr">7-day avg ${Math.round(p.avg)}g</span>${extra}<button class="linkbtn nh-open" id="nhOpen" type="button">Open day</button>`;
  const cur = $('nhCur'); if (cur) { cur.setAttribute('transform', `translate(${p.x.toFixed(1)},0)`); $('nhCurD').setAttribute('cy', p.ya.toFixed(1)); cur.style.opacity = 1; }
  NH.i = i;
}
function renderNutHistory() {
  const box = $('nhWrap'); if (!box) return;
  const k = NH.k, t = todayIso(), cache = {}, first = firstLogDay();
  const val = d => { const v = nhVal(k, d, cache); return v == null ? null : k === 'mac' ? v[NH.mk] : v; };
  // the first day with this kind of data
  let start = null; if (first) for (let d = first; d <= t; d = shift(d, 1)) if (nhVal(k, d, cache) != null) { start = d; break; }
  /* v88: a range only lights up once your data is longer than the range before it (until you've logged more than a month, only
     1M and All); a longer range would show exactly the same days. If the remembered range isn't on yet, the longest one that is is used. */
  const span = start ? daysBetween(start, t) + 1 : 0, rOn = WH_R.map(([kk, , dd], i) => !dd || i === 0 || span > WH_R[i - 1][2]);
  if (!rOn[WH_R.findIndex(x => x[0] === NH.r)]) NH.r = WH_R[rOn.lastIndexOf(true, WH_R.length - 2)][0];
  const rb = $('nhRange'); if (rb) [...rb.children].forEach((c, i) => { c.disabled = !rOn[i]; c.setAttribute('aria-pressed', c.dataset.nr === NH.r);
    c.title = rOn[i] ? '' : `Comes on once you've logged more than ${WH_R[i - 1][1] === '1M' ? 'a month' : WH_R[i - 1][1].replace('M', ' months').replace('1Y', 'a year')}`; });
  const r = WH_R.find(x => x[0] === NH.r), from0 = r[2] ? shift(t, -(r[2] - 1)) : start, from = start && from0 < start ? start : from0;
  const days = []; if (start) for (let d = from; d <= t; d = shift(d, 1)) days.push(d);
  const vals = days.map(val), have = vals.filter(v => v != null).length;
  if (!start || have < 2) {
    NH.pts = null;
    const what = k === 'pro' ? 'Log food on two or more days to see your protein history here.' : k === 'fib' ? 'Two or more days with fibre data will draw your history here.' : 'Two or more days where most food has carb data will draw your history here.';
    box.innerHTML = `<p class="empty" id="nhEmpty">${!start || r[2] === 0 || from === start ? what : 'Fewer than two days with data in this range. Try a longer one.'}</p>`;
    return;
  }
  const W = Math.max(280, Math.round(box.clientWidth || sheetBody.clientWidth - 36)), H = Math.round(Math.min(260, Math.max(190, W * 0.5))), L = 34, R = 10, T0 = 12, B = 24, n = days.length;
  const T = S.targets, line = k === 'pro' ? T.protein : null, band = k === 'fib' ? [FIB_LO, FIB_HI] : null;
  const max = Math.max(line || 0, band ? band[1] : 0, ...vals.map(v => v || 0)) * 1.1 || 1;
  const Y = v => T0 + (1 - v / max) * (H - T0 - B), bw = (W - L - R) / n, X = i => L + (i + 0.5) * bw;
  const txt = 'font-size="11" fill="var(--muted)" font-family="Barlow, system-ui, sans-serif"';
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(NH_KIND[k].title)} from ${esc(shortDate(from))} to today">`;
  const st = nhStep(max); for (let v = st; v < max; v += st) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--line)"/><text x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" ${txt}>${v}</text>`;
  if (band) svg += `<rect x="${L}" width="${W - L - R}" y="${Y(band[1]).toFixed(1)}" height="${(Y(band[0]) - Y(band[1])).toFixed(1)}" fill="var(--protein)" opacity=".12"/>`;
  // month starts along the bottom (labels skipped where they'd crowd), like Weight history
  let lastX = -99; const mk = [];
  for (let m = addMonth(ym(from), 1); m <= ym(t); m = addMonth(m, 1)) mk.push(m);
  if (n <= 31) mk.length = 0;
  mk.forEach(m => { const i = days.indexOf(m + '-01'); if (i < 0) return; const x = L + i * bw;
    svg += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${T0}" y2="${H - B}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
    if (x - lastX >= 30 && x > L + 26 && x < W - R - 30) { const d = parseIso(m + '-01'); svg += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" ${txt}>${esc(d.toLocaleDateString(undefined, d.getMonth() === 0 ? { month: 'short', year: '2-digit' } : { month: 'short' }))}</text>`; lastX = x; } });
  if (!mk.length) svg += `<text x="${L}" y="${H - 6}" ${txt}>${esc(parseIso(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</text>`;
  svg += `<text x="${W - R}" y="${H - 6}" text-anchor="end" ${txt}>Today</text>`;
  const bwd = Math.max(1, bw * (n > 120 ? 0.8 : 0.7));
  vals.forEach((v, i) => { if (v == null) return; svg += `<rect class="bar" x="${(X(i) - bwd / 2).toFixed(1)}" y="${Y(v).toFixed(1)}" width="${bwd.toFixed(1)}" height="${(H - B - Y(v)).toFixed(1)}" rx="${Math.min(3, bwd / 2).toFixed(1)}" fill="${nhColor(k, v)}"${days[i] === t ? ' opacity=".55"' : ''}/>`; });
  if (line) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(line).toFixed(1)}" y2="${Y(line).toFixed(1)}" stroke="var(--protein)" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${L + 4}" y="${(Y(line) - 5).toFixed(1)}" font-size="11" fill="var(--protein)" font-family="Barlow, system-ui, sans-serif">Target ${line}g</text>`;
  // the 7-day average of the days with data, drawn through each one
  NH.pts = []; vals.forEach((v, i) => { if (v == null) return; const w = vals.slice(Math.max(0, i - 6), i + 1).filter(x => x != null);
    NH.pts.push({ date: days[i], v, avg: w.reduce((a, b) => a + b, 0) / w.length, x: X(i), m: k === 'mac' ? nhVal(k, days[i], cache) : null }); });
  NH.pts.forEach(p => { p.ya = Y(p.avg); });
  svg += `<polyline class="draw" pathLength="1" points="${NH.pts.map(p => `${p.x.toFixed(1)},${p.ya.toFixed(1)}`).join(' ')}" fill="none" stroke="var(--ink)" stroke-opacity=".75" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  svg += `<g id="nhCur" style="opacity:0"><line x1="0" x2="0" y1="${T0}" y2="${H - B}" stroke="var(--ink)" stroke-opacity=".35" stroke-width="1.5"/><circle id="nhCurD" cx="0" cy="0" r="5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/></g>`;
  svg += `<rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/></svg>`;
  // the range in numbers: finished days only (today is still in progress)
  const done = NH.pts.filter(p => p.date < t), nD = done.length, av = f => nD ? done.reduce((a, p) => a + f(p), 0) / nD : null;
  const last7 = done.filter(p => p.date >= shift(t, -7)), a7 = last7.length ? last7.reduce((a, p) => a + p.v, 0) / last7.length : null;
  const top = NH.pts.reduce((a, p) => p.v > a.v ? p : a), topD = esc(parseIso(top.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  const tile = (v, kk) => `<div><span class="v">${v}</span><span class="k">${kk}</span></div>`;
  let stats, extra = '', note;
  if (k === 'mac') {
    const aC = av(p => p.m.carb), aF = av(p => p.m.fat);
    stats = tile(aC == null ? '–' : nhG(aC), 'avg carbs') + tile(aF == null ? '–' : nhG(aF), 'avg fat') + tile(nhG(top.v), `most ${NH.mk === 'fat' ? 'fat' : 'carbs'}, ${topD}`) + tile(nD || '–', `day${nD === 1 ? '' : 's'} counted`);
    if (nD) extra = `<div class="mac-wrap" id="nhSplit">${macSplitHtml(av(p => p.m.pro), aC, aF)}</div>`;
    note = `Bars are each day's ${NH.mk === 'fat' ? 'fat' : 'carbs'}; the line is your 7-day average. Only days where most of the food has carb data are shown, like the Trends card. Drag along the chart to read any day.`;
  } else {
    const hits = done.filter(p => nhHit(k, p.v)).length;
    stats = tile(nD ? nhG(av(p => p.v)) : '–', 'avg a day') + tile(a7 == null ? '–' : nhG(a7), 'last 7 days')
      + tile(nD ? `${hits}<small>/${nD}</small>` : '–', k === 'pro' ? 'days at target' : `days ${FIB_LO}g+`) + tile(nhG(top.v), `highest, ${topD}`);
    note = k === 'pro' ? `Bars are each day's protein (green when you hit ${T.protein}g); the line is your 7-day average and the dashed line your target. Drag along the chart to read any day.`
      : `Bars are each day's fibre (green at ${FIB_LO}g or more); the line is your 7-day average and the band the ${FIB_LO}–${FIB_HI}g most adults aim for. Days with no fibre data are left out, and foods without it aren't counted, so real totals can be higher.`;
  }
  // months, newest first (finished days only)
  const months = []; NH.pts.filter(p => p.date < t).forEach(p => { const m = ym(p.date), x = months[months.length - 1]; if (x && x.m === m) x.p.push(p); else months.push({ m, p: [p] }); });
  const mAvg = ps => ps.reduce((a, p) => a + p.v, 0) / ps.length;
  const mrows = months.map((x, i) => { const a = mAvg(x.p), b = i ? mAvg(months[i - 1].p) : null, d = b == null ? null : a - b;
    const cls = d == null || k === 'mac' || Math.round(d) === 0 ? '' : d > 0 ? 'good' : 'bad';
    const sub = k === 'pro' ? `${x.p.length} day${x.p.length > 1 ? 's' : ''} · target hit on ${x.p.filter(p => proHit(p.v)).length}`
      : k === 'fib' ? `${x.p.length} day${x.p.length > 1 ? 's' : ''} · ${FIB_LO}g+ on ${x.p.filter(p => nhHit('fib', p.v)).length}`
      : `${x.p.length} day${x.p.length > 1 ? 's' : ''} · avg ${Math.round(x.p.reduce((s, p) => s + p.m[NH.mk === 'fat' ? 'carb' : 'fat'], 0) / x.p.length)}g ${NH.mk === 'fat' ? 'carbs' : 'fat'}`;
    return `<div class="whm"><b>${esc(monthName(x.m))}</b><span class="r"><b>${Math.round(a)}g</b><small class="${cls}">${d == null ? 'avg a day' : Math.round(d) === 0 ? 'same' : `${signed(d, z => Math.round(z))}g`}</small></span><small>${esc(sub)}</small></div>`; }).reverse().join('');
  box.innerHTML = `<div class="wh-read" id="nhRead" aria-live="polite"></div><div class="wh-chart" id="nhChart">${svg}</div>`
    + `<p class="hint" id="nhNote">${esc(note)}</p>`
    + `<div class="hs-sum wh-stats" id="nhStats">${stats}</div>${extra}`
    + (mrows ? `<h3 class="hs-h">By month</h3><div class="hs-months" id="nhMonths">${mrows}</div>` : '');
  nhRead(NH.pts.length - 1);
  // drag (or tap) along the chart to read the nearest day; arrow keys step through them
  const svgEl = $('nhChart').querySelector('svg'), at = e => { const bb = svgEl.getBoundingClientRect(), x = (e.clientX - bb.left) * W / bb.width;
    let j = 0; NH.pts.forEach((p, q) => { if (Math.abs(p.x - x) < Math.abs(NH.pts[j].x - x)) j = q; }); if (j !== NH.i) nhRead(j); };
  let down = false;
  svgEl.addEventListener('pointerdown', e => { down = true; try { svgEl.setPointerCapture(e.pointerId); } catch (x) {} at(e); });
  svgEl.addEventListener('pointermove', e => { if (down || e.pointerType === 'mouse') at(e); });
  ['pointerup', 'pointercancel'].forEach(nn => svgEl.addEventListener(nn, () => { down = false; }));
  svgEl.setAttribute('tabindex', '0');
  svgEl.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); nhRead(Math.max(0, Math.min(NH.pts.length - 1, NH.i + (e.key === 'ArrowLeft' ? -1 : 1)))); } });
}
/* ways in: the "See full … history" links under the Trends cards, or tapping the chart anywhere but a bar (a bar opens that day) */
$('tProHist').onclick = () => openNutHistory('pro'); $('tMacHist').onclick = () => openNutHistory('mac'); $('tFibHist').onclick = () => openNutHistory('fib');

/* ===================== v80: DAY SHAPE ===================== */
/* Which meal carries the day. Today's Eaten card shows a bar split by meal and names the biggest one; tapping it opens
   "When you eat": each meal's share and average over 4 weeks / 3 months / all time, which meal is usually the heaviest and
   lightest, when the kitchen closes, how the next morning's weigh-in moves after bigger vs lighter dinners, and records.
   Only finished, logged days count (today is in progress). Everything is worked out from the log; nothing new is stored. */
const SHAPE_R = [['4w', '4W', 28], ['3m', '3M', 91], ['all', 'All', 0]];
const SHAPE = { r: '4w' };
const SHAPE_MIN = 3, SHAPE_PAIRS = 7,   // v81: 14 nights (7 bigger, 7 lighter) before the morning after shows numbers
     SHAPE_WEEKS = 26, SHAPE_LATE = 20, SHAPE_REC_DAYS = 7, SHAPE_LIGHT_MIN = 150;
const SLOT_NAME = Object.fromEntries(SLOTS);
function slotSums(d) {
  const o = {}; SLOTS.forEach(([k]) => { o[k] = { kcal: 0, pro: 0, n: 0 }; });
  (S.log[d] || []).forEach(e => { const s = o[slotOf(e)]; if (!s) return; s.kcal += e.kcal || 0; s.pro += e.pro || 0; s.n++; });
  return o;
}
/* the time the last food was logged that day, in hours (8.5 = 8:30 am); entries logged on another day (copied, moved, logged
   the next morning) say nothing about when you ate, so they're left out */
function lastHour(d) {
  let h = null;
  (S.log[d] || []).forEach(e => { if (!(e.at > 1e11)) return; const t = new Date(e.at); if (iso(t) !== d) return;
    const x = t.getHours() + t.getMinutes() / 60; if (h == null || x > h) h = x; });
  return h;
}
/* a weight change with its sign, never "−0.0" (v71) */
const sgW = x => { const v = toW(Math.abs(x)).toFixed(1); return v === '0.0' ? '0.0' : (x > 0 ? '+' : '−') + v; };
const hourText = h => { const d = new Date(2000, 0, 1, Math.floor(h), Math.round((h % 1) * 60)); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
function shapeDays(r) {
  const t = todayIso(), first = firstLogDay(); if (!first) return [];
  const rr = SHAPE_R.find(x => x[0] === r) || SHAPE_R[0], from = rr[2] ? shift(t, -rr[2]) : first, out = [];
  for (let d = from < first ? first : from; d < t; d = shift(d, 1)) if (dayTotals(d)) out.push(d);
  return out;
}
/* the most protein in one meal on any logged day other than this one, so a new best can be cheered on Today */
function bestProMeal(skip) {
  let best = 0, n = 0;
  Object.keys(S.log).forEach(d => { if (d === skip || d > todayIso() || !dayTotals(d)) return; n++;
    const o = slotSums(d); SLOTS.forEach(([k]) => { if (o[k].pro > best) best = o[k].pro; }); });
  return { best, n };
}
function renderShape() {
  safe(checkBadges);
  const b = $('shapeBtn'); if (!b) return;
  const o = slotSums(day), tot = SLOTS.reduce((a, [k]) => a + o[k].kcal, 0), used = SLOTS.filter(([k]) => o[k].n);
  const show = used.length >= 2 && tot > 0, tx = $('shapeTxt');
  b.hidden = tx.hidden = !show; $('eatH').classList.toggle('folded', show); if (!show) return;   // v82: folded into the Eaten header
  $('shapeBar').innerHTML = SLOTS.filter(([k]) => o[k].kcal > 0).map(([k, l]) => `<i class="s-${k}" style="flex:${(o[k].kcal / tot).toFixed(4)} 1 0" title="${l}"></i>`).join('');
  const big = used.reduce((a, s) => o[s[0]].kcal > o[a[0]].kcal ? s : a), pct = Math.round(o[big[0]].kcal / tot * 100);
  const top = used.reduce((a, s) => o[s[0]].pro > o[a[0]].pro ? s : a), rec = bestProMeal(day);
  const isRec = rec.n >= SHAPE_REC_DAYS && Math.round(o[top[0]].pro) > Math.round(rec.best);
  const split = SLOTS.filter(([k]) => o[k].kcal > 0).map(([k, l]) => `${l} ${Math.round(o[k].kcal / tot * 100)}%`).join(', ');
  tx.innerHTML = (isRec ? `🏆 <b>${top[1]}</b> ${Math.round(o[top[0]].pro)}g` : `<b>${big[1]}</b> ${pct}%`) + '<svg aria-hidden="true"><use href="#i-chev-r"/></svg>';
  const say = isRec ? `Protein record: ${Math.round(o[top[0]].pro)}g at ${top[1].toLowerCase()}` : `${big[1]} ${day === todayIso() ? 'is' : 'was'} the biggest meal, ${pct}%`;
  tx.title = say; tx.setAttribute('aria-label', `${say}. See when you eat`);
  b.setAttribute('aria-label', `${split}. See when you eat`);
}
function shapeStats(days) {
  const per = {}, biggest = {}; SLOTS.forEach(([k]) => { per[k] = { kcal: 0, pro: 0, days: 0 }; biggest[k] = 0; });
  let all = 0;
  days.forEach(d => { const o = slotSums(d); let bk = null;
    SLOTS.forEach(([k]) => { const s = o[k]; if (!s.n) return; per[k].kcal += s.kcal; per[k].pro += s.pro; per[k].days++; all += s.kcal;
      if (!bk || s.kcal > o[bk].kcal) bk = k; });
    if (bk) biggest[bk]++; });
  SLOTS.forEach(([k]) => { const p = per[k]; p.share = all ? p.kcal / all : 0; p.avgK = p.days ? p.kcal / p.days : 0; p.avgP = p.days ? p.pro / p.days : 0; });
  const regular = SLOTS.map(s => s[0]).filter(k => per[k].days >= Math.max(1, days.length * 0.25));   // meals you actually eat
  const heavy = regular.reduce((a, k) => !a || per[k].share > per[a].share ? k : a, null);
  const light = regular.length > 1 ? regular.reduce((a, k) => !a || per[k].share < per[a].share ? k : a, null) : null;
  return { per, biggest, heavy, light, n: days.length };
}
function shapeLate(days) {
  const hs = days.map(d => ({ d, h: lastHour(d) })).filter(x => x.h != null);
  if (hs.length < 5) return null;
  const sorted = hs.map(x => x.h).sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
  let best = { n: 0, end: null }, run = 0, prev = null;
  hs.forEach(x => { run = x.h < SHAPE_LATE && (run && prev === shift(x.d, -1)) ? run + 1 : x.h < SHAPE_LATE ? 1 : 0; prev = x.d;
    if (run && run >= best.n) best = { n: run, end: x.d }; });   // ties go to the latest run
  return { med, early: hs.filter(x => x.h < SHAPE_LATE).length, n: hs.length, best };
}
/* the morning after: the change from that morning's weigh-in to the next, after bigger vs lighter dinners (split at the median) */
const AFTER_MIN = 0.3;   // lb: a smaller gap isn't worth calling a link
function shapeAfter(days) {
  const pairs = days.filter(d => S.weights[d] != null && S.weights[shift(d, 1)] != null)
    .map(d => ({ d, din: slotSums(d).dinner.kcal, tot: dayTotals(d).kcal, dw: S.weights[shift(d, 1)] - S.weights[d] }));
  const split = key => { const p = pairs.filter(x => x[key] > 0).sort((a, b) => a[key] - b[key]); if (p.length < 2 * SHAPE_PAIRS) return null;
    const h = Math.floor(p.length / 2), lo = p.slice(0, h), hi = p.slice(p.length - h), avg = a => a.reduce((s, x) => s + x.dw, 0) / a.length;
    // v81: the gap only counts as a link when it's clearly bigger than the usual night-to-night swing (about two standard errors)
    const sd = Math.sqrt([lo, hi].reduce((t, g) => { const m = avg(g); return t + g.reduce((u, x) => u + (x.dw - m) ** 2, 0); }, 0) / Math.max(1, lo.length + hi.length - 2));
    const gap = avg(hi) - avg(lo), se = sd * Math.sqrt(1 / lo.length + 1 / hi.length);
    return { lo: avg(lo), hi: avg(hi), cut: (lo[lo.length - 1][key] + hi[0][key]) / 2, n: lo.length + hi.length, sd, clear: Math.abs(gap) >= Math.max(2 * se, AFTER_MIN) }; };
  return { pairs: pairs.length, din: split('din'), day: split('tot') };
}
function shapeRecords(days) {
  const rec = {};
  days.forEach(d => { const o = slotSums(d);
    SLOTS.forEach(([k, l]) => { const s = o[k]; if (!s.n) return;
      if (!rec.pro || s.pro >= rec.pro.v) rec.pro = { v: s.pro, d, l };
      if (!rec.big || s.kcal >= rec.big.v) rec.big = { v: s.kcal, d, l };
      if (k === 'dinner' && s.kcal >= SHAPE_LIGHT_MIN && (!rec.light || s.kcal <= rec.light.v)) rec.light = { v: s.kcal, d, l }; }); });
  return rec;
}
function openShape() {
  openSheet('When you eat', `<div class="chips wh-r" id="shRange" role="group" aria-label="Range">${SHAPE_R.map(([k, l]) => `<button class="chip" data-sr="${k}" aria-pressed="${k === SHAPE.r}">${l}</button>`).join('')}</div><div class="sh" id="shWrap"></div>`, wideSheet());
  renderShapePanel();
  sheetBody.onclick = e => {
    const r = e.target.closest('[data-sr]'), d = e.target.closest('[data-sd]');
    if (r && r.dataset.sr !== SHAPE.r) { SHAPE.r = r.dataset.sr; [...$('shRange').children].forEach(c => c.setAttribute('aria-pressed', c === r)); haptic(); renderShapePanel(); return; }
    if (d) { closeSheet(); day = d.dataset.sd; showTab('today'); renderAll(); }
  };
}
function renderShapePanel() {
  const box = $('shWrap'); if (!box) return;
  const days = shapeDays(SHAPE.r), rr = SHAPE_R.find(x => x[0] === SHAPE.r);
  const span = rr[2] ? `in the last ${rr[2] === 28 ? '4 weeks' : '3 months'}` : 'since you started';
  if (days.length < SHAPE_MIN) {
    box.innerHTML = `<p class="empty" id="shEmpty">Log ${SHAPE_MIN} full days and your patterns show up here: which meal carries your day, when you finish eating, and how dinner shows on the scale next morning.${days.length ? ` You have ${days.length} so far.` : ''}</p>`;
    return;
  }
  const s = shapeStats(days), late = shapeLate(days), after = shapeAfter(days), rec = shapeRecords(days);
  const pc = x => Math.round(x * 100) + '%';
  const bar = SLOTS.filter(([k]) => s.per[k].share > 0).map(([k, l]) => `<i class="s-${k}" style="flex:${s.per[k].share.toFixed(4)} 1 0" title="${l}"></i>`).join('');
  const rows = SLOTS.filter(([k]) => s.per[k].days).map(([k, l]) => { const p = s.per[k], tag = k === s.heavy ? '<em class="sh-tag hi">Heaviest</em>' : k === s.light ? '<em class="sh-tag lo">Lightest</em>' : '';
    return `<div class="sh-m" data-slot="${k}"><i class="sh-dot s-${k}"></i><span class="n"><b>${l}</b>${tag}<small>avg ${kc(p.avgK)} kcal · ${Math.round(p.avgP)}g · on ${p.days} of ${s.n} days</small></span><span class="p">${pc(p.share)}</span></div>`; }).join('');
  const hv = s.heavy && SLOT_NAME[s.heavy], lt = s.light && SLOT_NAME[s.light];
  let sum = hv ? `<b>${hv}</b> is usually your heaviest meal, about ${pc(s.per[s.heavy].share)} of your calories` : '';
  const topBig = SLOTS.map(x => x[0]).reduce((a, k) => s.biggest[k] > s.biggest[a] ? k : a);
  if (hv) sum += topBig === s.heavy ? ` (the biggest of the day on ${s.biggest[topBig]} of ${s.n} days).` : `. ${SLOT_NAME[topBig]} was the biggest on more days, though (${s.biggest[topBig]} of ${s.n}).`;
  if (lt) sum += ` <b>${lt}</b> is the lightest.`;
  let h = `<p class="hint" id="shIntro">From the ${s.n} days you logged ${span}. Today isn’t counted until it’s over.</p>`
    + `<div class="sh-bar" aria-hidden="true">${bar}</div><div class="sh-meals" id="shMeals">${rows}</div><p class="sh-sum" id="shSum">${sum}</p>` + shapeWeeksHtml(days);
  if (late) {
    h += `<h3 class="hs-h">When you finish eating</h3><p class="sh-p" id="shLate">You usually log your last food around <b>${esc(hourText(late.med))}</b>. Done before 8 pm on <b>${late.early} of ${late.n}</b> days.</p>`;
  }
  // the morning after
  h += `<h3 class="hs-h">The morning after</h3>`;
  const dw = (x, c) => `<b class="${!c || sgW(x) === '0.0' ? '' : x > 0 ? 'up' : 'down'}">${sgW(x)} ${wU()}</b>`;
  if (after.din) {
    const a = after.din, gap = a.hi - a.lo;
    h += `<div class="sh-after" id="shAfter"><div><span class="k">After bigger dinners</span>${dw(a.hi, a.clear)}<small>over about ${kc(Math.round(a.cut / 50) * 50)} kcal</small></div><div><span class="k">After lighter dinners</span>${dw(a.lo, a.clear)}<small>under that</small></div></div>`
      + `<p class="sh-p" id="shAfterNote">From ${a.n} nights${after.day ? ` (by whole day: bigger ${sgW(after.day.hi)}, lighter ${sgW(after.day.lo)} ${wU()})` : ''}. `
      + (a.clear && gap > 0 ? 'A big dinner does show up, but it’s food and water, not fat, and fades in a day or two. Judge by your 7-day average.'
        : a.clear ? 'Bigger dinners haven’t meant a higher scale so far.'
        : `No clear link yet: it’s within your normal swing (±${toW(a.sd).toFixed(1)} ${wU()}), so it could be chance.`) + '</p>';
  } else {
    const need = Object.keys(S.weights).length;
    h += `<p class="sh-p" id="shAfterNote">${need ? `This needs a morning weigh-in the day after at least ${2 * SHAPE_PAIRS} logged days with dinner (about two weeks of daily weigh-ins), so a single salty dinner can’t skew it. You have ${after.pairs} so far in this range.` : 'Weigh in in the mornings and this shows how the scale moves after bigger dinners compared with lighter ones.'}</p>`;
  }
  // records
  const tileR = (key, ico, k, v, sub, d) => `<button class="sh-rec" data-rec="${key}" data-sd="${d}"><span class="ico" aria-hidden="true">${ico}</span><span class="k">${k}</span><b>${v}</b><small>${esc(sub)}</small></button>`;
  const when = r => `${r.l} · ${shortDate(r.d)}`;
  let tiles = '';
  if (rec.pro) tiles += tileR('pro', '💪', 'Most protein in one meal', `${Math.round(rec.pro.v)}<small>g</small>`, when(rec.pro), rec.pro.d);
  if (rec.light) tiles += tileR('light', '🪶', 'Lightest dinner', `${kc(rec.light.v)}<small> kcal</small>`, shortDate(rec.light.d), rec.light.d);
  if (late && late.best.n) tiles += tileR('early', '🌙', 'Done by 8 pm', `${late.best.n}<small> day${late.best.n > 1 ? 's' : ''} in a row</small>`, `best run, to ${shortDate(late.best.end)}`, late.best.end);
  if (rec.big) tiles += tileR('big', '🍽️', 'Biggest meal', `${kc(rec.big.v)}<small> kcal</small>`, when(rec.big), rec.big.d);
  h += `<h3 class="hs-h">Records</h3><div class="sh-recs" id="shRecs">${tiles}</div><p class="hint">Tap a record to open that day. A big meal now and then is fine; the week decides.</p>` + badgesHtml();
  box.innerHTML = h;
}
/* v81: week by week. One bar per Mon–Sun week (100% of that week's calories, split by meal), oldest at the top, so a shift
   (dinner shrinking, breakfast growing) is easy to see. Weeks count only finished, logged days. */
function shapeWeeksHtml(days) {
  const wk = new Map();
  days.forEach(d => { const w = weekStart(d), o = slotSums(d); if (!wk.has(w)) wk.set(w, { n: 0, tot: 0, s: Object.fromEntries(SLOTS.map(([k]) => [k, 0])) });
    const x = wk.get(w); x.n++; SLOTS.forEach(([k]) => { x.s[k] += o[k].kcal; x.tot += o[k].kcal; }); });
  let ws = [...wk.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  if (ws.length < 2) return '';
  const cut = ws.length > SHAPE_WEEKS; if (cut) ws = ws.slice(-SHAPE_WEEKS);
  const lbl = w => parseIso(w).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const rows = ws.map(([w, x]) => `<div class="sh-w" data-wk="${w}"><span class="d">${esc(lbl(w))}</span><span class="sh-wbar" aria-label="${esc(SLOTS.filter(([k]) => x.s[k] > 0).map(([k, l]) => `${l} ${Math.round(x.s[k] / x.tot * 100)}%`).join(', '))}">${SLOTS.filter(([k]) => x.s[k] > 0).map(([k]) => `<i class="s-${k}" style="flex:${(x.s[k] / x.tot).toFixed(4)} 1 0"></i>`).join('')}</span><span class="v">${kc(x.tot / x.n)}<small> /day</small></span></div>`).join('');
  // the biggest shift between the first and last full-ish weeks (3+ logged days each), if it's 5 points or more
  const full = ws.filter(([, x]) => x.n >= 3); let note = '';
  if (full.length >= 2) {
    const [w0, a] = full[0], [w1, z] = full[full.length - 1];
    const ch = SLOTS.map(([k, l]) => ({ l, from: a.s[k] / a.tot, to: z.s[k] / z.tot })).sort((p, q) => Math.abs(q.to - q.from) - Math.abs(p.to - p.from))[0];
    if (Math.abs(ch.to - ch.from) >= 0.05) note = `${ch.l} went from ${Math.round(ch.from * 100)}% of your day (week of ${lbl(w0)}) to ${Math.round(ch.to * 100)}% (week of ${lbl(w1)}).`;
    else note = 'Your meal split has stayed about the same from week to week.';
  }
  return `<h3 class="hs-h">Week by week</h3><div class="sh-weeks" id="shWeeks">${rows}</div><div class="sh-leg" aria-hidden="true">${SLOTS.map(([k, l]) => `<span><i class="s-${k}"></i>${l}</span>`).join('')}</div>`
    + (note || cut ? `<p class="sh-p" id="shWeekNote">${esc(note)}${cut ? `${note ? ' ' : ''}Showing the last ${SHAPE_WEEKS} weeks.` : ''}</p>` : '');
}

/* v81: badges to earn. Worked out from every finished, logged day (not just the range shown). A new one gets the
   celebration once per device: the ids already celebrated live in localStorage cutlog.badges (not synced, not saved data).
   The first time this runs on a device, badges already earned are marked as seen without a celebration. */
const BADGE_KEY = 'cutlog.badges';
const BADGES = [
  ['early7', '🌙', 'Kitchen closed', 'Done eating by 8 pm, 7 days in a row', 7],
  ['spread7', '🥚', 'Protein all day', '30g+ protein at breakfast, lunch and dinner, on 7 days', 7],
  ['pro50', '💪', 'Protein-packed meal', '50g+ protein in one meal', 50],
  ['full14', '📋', 'Full days', 'Breakfast, lunch and dinner all logged, on 14 days', 14],
  ['even5', '⚖️', 'Even day', '3+ meals with none over 40% of the day, on 5 days', 5],
  ['early14', '🌌', 'Two weeks closed', 'Done eating by 8 pm, 14 days in a row', 14],
];
function badgeState() {
  const t = todayIso(), first = firstLogDay(), out = Object.fromEntries(BADGES.map(b => [b[0], { cur: 0, at: null }]));
  if (!first) return out;
  let run = 0, prev = null, spread = 0, full = 0, even = 0, best = 0;
  const hit = (id, v, d) => { const o = out[id], need = BADGES.find(b => b[0] === id)[4]; if (v > o.cur) o.cur = v; if (!o.at && v >= need) o.at = d; };
  for (let d = first; d < t; d = shift(d, 1)) {
    const tt = dayTotals(d); if (!tt) continue;
    const o = slotSums(d), h = lastHour(d);
    run = h != null && h < SHAPE_LATE ? (prev === shift(d, -1) ? run + 1 : 1) : 0; prev = run ? d : null;
    hit('early7', run, d); hit('early14', run, d);
    const main = ['breakfast', 'lunch', 'dinner'];
    if (main.every(k => o[k].pro >= 30)) spread++; hit('spread7', spread, d);
    if (main.every(k => o[k].n)) full++; hit('full14', full, d);
    const used = SLOTS.filter(([k]) => o[k].n), tot = SLOTS.reduce((a, [k]) => a + o[k].kcal, 0);
    if (used.length >= 3 && tot > 0 && used.every(([k]) => o[k].kcal / tot <= 0.4)) even++; hit('even5', even, d);
    SLOTS.forEach(([k]) => { if (o[k].pro > best) best = o[k].pro; }); hit('pro50', Math.round(best), d);
  }
  return out;
}
function badgesSeen() { try { const v = JSON.parse(localStorage.getItem(BADGE_KEY)); return Array.isArray(v) ? v : null; } catch (e) { return null; } }
function checkBadges() {
  if (!S.onboarded) return;
  const st = badgeState(), earned = BADGES.filter(b => st[b[0]].at).map(b => b[0]), seen = badgesSeen();
  const save = v => { try { localStorage.setItem(BADGE_KEY, JSON.stringify(v)); } catch (e) {} };
  if (!seen) { save(earned); return; }   // first run on this device: no celebrations for what was already earned
  const fresh = earned.filter(id => !seen.includes(id)); if (!fresh.length) return;
  save([...seen, ...fresh]);
  if (msSilent) return;
  const recent = shift(todayIso(), -2);   // only cheer badges earned yesterday or the day before, never old history arriving by sync
  fresh.filter(id => st[id].at >= recent).slice(-2).forEach(id => { const b = BADGES.find(x => x[0] === id); celQueue.push({ title: `Badge earned: ${b[2]} ${b[1]}`, sub: `${b[3]}. See all your badges in When you eat.` }); });
  if (celQueue.length) setTimeout(showNextCel, 600);
}
function badgesHtml() {
  const st = badgeState();
  const tile = ([id, ico, name, desc, need]) => { const o = st[id], got = !!o.at, cur = Math.min(o.cur, need);
    return `<${got ? `button data-sd="${o.at}"` : 'div'} class="sh-badge${got ? ' got' : ''}" data-badge="${id}"><span class="ico" aria-hidden="true">${ico}</span><b>${esc(name)}</b><small>${esc(desc)}</small>`
      + (got ? `<em>Earned ${esc(parseIso(o.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</em>` : `<span class="sh-prog" role="img" aria-label="${cur} of ${need}"><i style="width:${(cur / need * 100).toFixed(1)}%"></i></span><em>${cur} / ${need}${id === 'pro50' ? 'g' : ''}</em>`)
      + `</${got ? 'button' : 'div'}>`; };
  const n = BADGES.filter(b => st[b[0]].at).length;
  return `<h3 class="hs-h">Badges <span class="sh-bn">${n} of ${BADGES.length}</span></h3><div class="sh-badges" id="shBadges">${BADGES.map(tile).join('')}</div><p class="hint">Badges count every day you've logged, not just this range. Tap an earned one to open the day you got it.</p>`;
}
$('shapeBtn').onclick = () => { haptic(); openShape(); };
$('shapeTxt').onclick = () => { haptic(); openShape(); };
$('tShape').onclick = () => openShape();

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
  const on = day === todayIso() && es.length && left >= 150;
  fitPicks = on ? pickFits(left) : [];
  const mi = on ? moreIdeas(left) : null, more = !!mi && mi.count > 0;      // v67: ideas beyond your own foods
  el.hidden = !fitPicks.length && !more;
  /* v68: while the picks show, they say what the "under your range, room for a snack" line said, so that line steps aside
     (it still shows when you're in range, over, or haven't logged anything) */
  $('status').hidden = !el.hidden && cal < T.calLo;
  if (el.hidden) return;
  const proLeft = Math.max(0, Math.round(T.protein - pro));
  const moreSub = mi && `${mi.count} that fit`;
  /* v68: one swipeable row, full names, with More ideas as its last tile (was two cut-off tiles plus a separate button) */
  el.innerHTML = `<span class="fits-k">Fits the ${kc(left)} kcal${proLeft ? ` and ${proLeft}g protein` : ''} left</span>`
    + `<div class="fits-row" id="fitsRow">${fitPicks.map((x, i) => `<button class="fit" data-fit="${i}"><b>${esc(x.f.name)}</b><small>${Math.round(x.kcal)} kcal · ${fmtG(x.pro)}g</small></button>`).join('')}`
    + (more ? `<button class="fit fit-more" id="fitsMore" type="button"><b>More ideas${CHEV_R}</b><small>${esc(moreSub)}</small></button>` : '') + '</div>';
  const row = $('fitsRow'), fade = () => row.classList.toggle('more', row.scrollLeft + row.clientWidth < row.scrollWidth - 4);
  row.addEventListener('scroll', fade, { passive: true }); requestAnimationFrame(fade);
}
$('fits').onclick = e => {
  if (e.target.closest('#fitsMore')) { haptic(); openMoreIdeas(); return; }
  const b = e.target.closest('[data-fit]'); if (!b) return; const x = fitPicks[+b.dataset.fit]; if (x) { haptic(); openAmount(x.f, { qty: x.qty, unit: x.unit }); }
};

/* =================== v67: MORE IDEAS (beyond your own foods) ===================
   From What fits: simple high-protein things to make at home (built from the built-in foods) and Canadian chain menu items,
   only those that fit what's left today, most protein per calorie first. After about 7 pm lighter picks come first (Kan eats
   his last meal by 7-8 pm). Nothing is saved until something is logged, and then only the entry (like a built-in food). */
const IDEA_MIN_PRO = 10, IDEA_MIN_DENS = 4;   // only suggest things with real protein: 10 g or more, and 4 g or more per 100 kcal
let ideaCache = null;
function ideaFoods() {
  if (ideaCache) return ideaCache;
  return ideaCache = HOME_IDEAS.map(h => {
    const items = h.items.map(([n, qty, unit]) => ({ food: BUILTIN_FOODS.find(b => b.name === n), qty, unit })).filter(it => it.food);
    const v = items.map(it => calc(it.food, it.qty, it.unit)), k = v.reduce((a, x) => a + x.kcal, 0), p = v.reduce((a, x) => a + x.pro, 0);
    const f = { id: 'idea-' + h.key, name: h.name, source: 'idea', kcalServ: Math.round(k), proServ: r1(p), snack: !!h.snack, what: h.what, items };
    if (v.every(x => x.fib != null)) f.fibServ = r1(v.reduce((a, x) => a + x.fib, 0));
    if (v.every(x => x.carb != null)) { f.carbServ = r1(v.reduce((a, x) => a + x.carb, 0)); f.fatServ = r1(v.reduce((a, x) => a + x.fat, 0)); }   // v84
    return f;
  });
}
const lateNow = () => { const h = nowH(); return h >= mealTimes().last - 1 || h < 4; };   // v90: the hour before your latest meal (7 pm by default)
const ideaWhat = f => f.what || (ideaFoods().find(x => x.id === f.id) || {}).what || '';
function moreIdeas(left) {
  const late = lateNow(), light = f => f.source === 'idea' ? f.snack : f.kcalServ <= 350;   // home ideas are tagged; chain items by size
  const rank = list => list.filter(f => f.kcalServ <= left && f.proServ >= IDEA_MIN_PRO && f.proServ / f.kcalServ * 100 >= IDEA_MIN_DENS)
    .sort((a, b) => (late ? light(b) - light(a) : 0) || b.proServ / b.kcalServ - a.proServ / a.kcalServ || b.proServ - a.proServ);
  const home = rank(ideaFoods()), out = rank(CHAIN_FOODS);
  return { home, out, late, count: home.length + out.length };
}
const MI = { tab: 'home', chain: 'all' };
function openMoreIdeas() {
  openSheet('More ideas', '<div id="miWrap"></div>');
  renderMoreIdeas();
  sheetBody.onclick = e => {
    const t = e.target.closest('[data-mt]'), c = e.target.closest('[data-mc]'), it = e.target.closest('[data-mi]');
    if (t) { MI.tab = t.dataset.mt; haptic(); renderMoreIdeas(); return; }
    if (c) { MI.chain = c.dataset.mc; haptic(); renderMoreIdeas(); return; }
    if (it) { const f = [...ideaFoods(), ...CHAIN_FOODS].find(x => x.id === it.dataset.mi); if (f) openAmount(f, { qty: 1, unit: 'serving' }); }
  };
}
function renderMoreIdeas() {
  const box = $('miWrap'); if (!box) return;
  const T = S.targets, es = entriesFor(todayIso()), left = Math.round(T.calHi - es.reduce((s, e) => s + e.kcal, 0));
  const proLeft = Math.max(0, Math.round(T.protein - es.reduce((s, e) => s + e.pro, 0)));
  const m = moreIdeas(left), chains = Object.keys(CHAIN_INFO);
  if (MI.chain !== 'all' && !chains.includes(MI.chain)) MI.chain = 'all';
  const row = (f, sub) => `<button class="item" data-mi="${esc(f.id)}"><span class="nm">${esc(f.item || f.name)}<small>${esc(sub)}</small>${ppBadge(f)}</span><span class="meta">${kc(f.kcalServ)} kcal · ${fmtG(f.proServ)}g</span></button>`;
  let list;
  if (MI.tab === 'home') {
    list = m.home.length ? m.home.map(f => row(f, ideaWhat(f))).join('') : '<p class="empty">Nothing from the home ideas fits what’s left today.</p>';
  } else {
    const out = m.out.filter(f => MI.chain === 'all' || f.chain === MI.chain);
    list = `<div class="chips mi-ch" id="miChains" role="group" aria-label="Restaurant">${['all', ...chains].map(c => `<button class="chip" data-mc="${esc(c)}" aria-pressed="${c === MI.chain}">${c === 'all' ? 'All' : esc(c)}</button>`).join('')}</div>`
      + (out.length ? `<div class="list" id="miOut">${out.map(f => row(f, MI.chain === 'all' ? f.chain : '')).join('')}</div>` : '<p class="empty">Nothing here fits what’s left today.</p>')
      + `<p class="hint">Numbers come from each chain’s own Canadian nutrition info, checked ${esc(parseIso(CHAIN_INFO["McDonald's"].checked).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))}. Sauces and changes to an order add calories.${MI.chain === 'Subway' || MI.chain === 'all' ? ' ' + esc(CHAIN_INFO.Subway.note) : ''}</p>`;
  }
  box.innerHTML = `<p class="hint mi-left" id="miLeft">Fits the ${kc(left)} kcal${proLeft ? ` and ${proLeft}g protein` : ''} you have left today, most protein per calorie first. Only picks with real protein (${IDEA_MIN_PRO}g or more, and ${IDEA_MIN_DENS}g per 100 kcal).</p>`
    + (m.late ? '<p class="mi-late" id="miLate">It’s evening, so lighter high-protein snacks come first.</p>' : '')
    + `<div class="seg2 mi-tabs" id="miTabs" role="group" aria-label="Where"><button type="button" data-mt="home" aria-pressed="${MI.tab === 'home'}">Make at home <small>${m.home.length}</small></button><button type="button" data-mt="out" aria-pressed="${MI.tab === 'out'}">Eating out <small>${m.out.length}</small></button></div>`
    + (MI.tab === 'home' ? `<div class="list" id="miHome">${list}</div><p class="hint">Made from Cut Log’s built-in foods. Tap one to log it, or save it as one of your meals and change it to suit you.</p>` : list);
}
/* How much? for a home idea or a chain item: what's in it, or where the numbers come from */
function moreNote(f) {
  if (f.source === 'idea' && ideaWhat(f)) return `<p class="hint mi-note" id="aIdea">${esc(ideaWhat(f))}.</p>`;
  if (f.source === 'chain' && CHAIN_INFO[f.chain]) return `<p class="hint mi-note" id="aChain">From ${esc(CHAIN_INFO[f.chain].src)}, checked ${esc(parseIso(CHAIN_INFO[f.chain].checked).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}.${f.chain === 'Subway' ? ' ' + esc(CHAIN_INFO.Subway.note) : ''}</p>`;
  return '';
}
/* v75: sauce and cheese on Subway subs and salads. Subway counts both without them (Kan's DoorDash salads read 220 and 260
   kcal against 140 and 110 here: the difference was the ranch). The entry's calories include what was picked, and the
   picked keys are kept on the entry (adds) so editing shows them again. Rice bowls aren't on Subway's sauce chart, so no picker. */
const SUB_ADD = Object.fromEntries(['sauce', 'cheese'].flatMap(t => SUBWAY_ADDS[t].map(([key, name, k, p]) => [key, { key, name, k, p, t }])));
const SUB_ORDER = Object.keys(SUB_ADD);
const isSubItem = f => !!f && f.source === 'chain' && f.chain === 'Subway' && !/bowl/i.test(f.item || f.name);
const subSalad = f => /salad/i.test(f.item || f.name);
const subMult = (f, a) => a.t === 'sauce' && subSalad(f) ? 2 : 1;          // a salad gets a double portion of sauce
const cleanAdds = (f, a) => isSubItem(f) && Array.isArray(a) ? SUB_ORDER.filter(k => a.includes(k)) : [];
function addsVal(f, adds, q) {
  let k = 0, p = 0; adds.forEach(key => { const a = SUB_ADD[key]; if (a) { k += a.k * subMult(f, a); p += a.p * subMult(f, a); } });
  return { kcal: k * (q > 0 ? q : 0), pro: p * (q > 0 ? q : 0) };
}
const addsD = adds => adds.length ? ` · with ${adds.map(k => SUB_ADD[k].name).join(', ')}` : '';
const addsKey = e => (e.adds || []).join(',');
function addsHtml(f, adds) {
  const chip = (a, on) => `<button class="chip" data-add="${a.key}" aria-pressed="${on}">${esc(a.name)} <small>+${a.k * subMult(f, a)}</small></button>`;
  const sauces = SUBWAY_ADDS.sauce.map(x => SUB_ADD[x[0]]), cheeses = SUBWAY_ADDS.cheese.map(x => SUB_ADD[x[0]]);
  return `<div class="oil adds" id="aAdds"><span class="oil-k">Sauce?${subSalad(f) ? ' A salad gets a double portion.' : ''} Pick any.</span>
    <div class="chips wrap" id="aSauce" role="group" aria-label="Sauce"><button class="chip" data-add="none" aria-pressed="${!adds.some(k => SUB_ADD[k].t === 'sauce')}">None</button>${sauces.map(a => chip(a, adds.includes(a.key))).join('')}</div>
    <span class="oil-k">Cheese?</span>
    <div class="chips wrap" id="aCheese" role="group" aria-label="Cheese"><button class="chip" data-add="nocheese" aria-pressed="${!adds.some(k => SUB_ADD[k].t === 'cheese')}">None</button>${cheeses.map(a => chip(a, adds.includes(a.key))).join('')}</div></div>`;
}
function saveIdeaMeal(f) {
  if (S.meals.some(m => m.name === f.name)) { toast('Already in My meals'); return; }
  const m = { id: uid(), name: f.name, servings: 1, items: f.items.map(it => ({ food: { ...it.food }, qty: it.qty, unit: it.unit })) };
  const t = mealTotals(m); m.kcal = Math.round(t.kcal); m.pro = Math.round(t.pro);   // like Save meal, without touching a meal you're building
  S.meals.push(m); touchMeta(); haptic(); toast('Saved to My meals');
}

/* =================== v73: PLAN MY DAY ===================
   Builds a day of meals from what you actually eat (your saved meals and the foods you've logged in the last 4 weeks, at your
   usual amounts, in the meals you usually have them), plus one or two of the built-in home ideas, rotated. It aims for the
   calorie range and the protein target, leaning on the most protein per calorie, and changes things up from the last few
   plans (Shuffle gives another version). Today fills only the meals still ahead; Tomorrow plans a whole day. Nothing is planned
   after 8 pm. Plans live on this device only (localStorage cutlog.plan), never in saved or synced data; logging a meal from the
   plan makes ordinary entries. */
const PLAN_KEY = 'cutlog.plan', PLAN_DAYS = 28, PLAN_END_H = 20, PLAN_MIN_KCAL = 30;
const SLOT_END = { breakfast: 11.5, lunch: 16, dinner: PLAN_END_H, snacks: PLAN_END_H };   // the defaults; v90: slotEnd() follows your meal times
const IDEA_SLOTS = { protoats: ['breakfast'], eggstoast: ['breakfast', 'lunch'], beanseggs: ['breakfast', 'lunch'], yogbowl: ['snacks', 'breakfast'], cottage: ['snacks', 'breakfast'], whites: ['snacks', 'breakfast'] };
function planStore() { try { return JSON.parse(localStorage.getItem(PLAN_KEY)) || {}; } catch (e) { return {}; } }
function planSave(x) { try { localStorage.setItem(PLAN_KEY, JSON.stringify(x)); } catch (e) {} }
const nowH = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const slotLabel = k => SLOTS.find(s => s[0] === k)[1];

/* ===================== v90: MEAL TIMES, LIGHT DINNER, PLAN LATER =====================
   Kan (5 Nov): "because I like to have my dinner before 7 or 8pm doesn't mean everyone does": anyone can set when they have
   breakfast, lunch and dinner and their latest meal (You → Meal times). Kept in the targets (targets.times, hours as numbers,
   so it syncs like adjWk; nothing new at the top level). Not set = the old fixed hours, so nothing changes for anyone who
   doesn't touch it (breakfast can be planned until 11:30, lunch until 4 pm, dinner and snacks until 8 pm).
   In the last hour before the latest meal, Today's plan keeps what's left light (LIGHT_KCAL at most, protein first) however
   many calories are left, so a late meal doesn't hurt sleep; the rest stays in the weekly budget.
   Plan later: a meal can be left "not planned yet" (you'll eat it, you just don't know what). The planner keeps room for it
   (about your usual size of that meal) and plans the rest around it. Kept in the plan (localStorage cutlog.plan, `later`). */
const TIMES_DEF = { breakfast: 8, lunch: 12.5, dinner: 18.5, last: 20 };
const LIGHT_KCAL = 450, LIGHT_PRO = 40, LIGHT_H = 1;
const mealTimes = () => ({ ...TIMES_DEF, ...(S.targets?.times || {}) });
function slotEnd(s) {          // a meal can still be planned for today until this hour
  const t = mealTimes();
  if (s === 'breakfast') return Math.min(t.breakfast + 3.5, t.lunch, t.last);
  if (s === 'lunch') return Math.min(t.lunch + 3.5, t.dinner, t.last);
  return t.last;
}
const lightFrom = () => { const t = mealTimes(); return Math.max(t.last - LIGHT_H, t.dinner + 0.5); };
const hmOf = h => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const hOf = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] + +m[2] / 60 : null; };
/* your usual size of a meal (median of the days you had it in the last 4 weeks), or a share of your targets */
function slotTypical(s) {
  const T = S.targets, mid = (T.calLo + T.calHi) / 2, share = { breakfast: 0.25, lunch: 0.3, dinner: 0.35, snacks: 0.1 }[s];
  const t = todayIso(), since = shift(t, -PLAN_DAYS), ks = [], ps = [];
  Object.keys(S.log).filter(d => d >= since && d < t).forEach(d => { const g = (S.log[d] || []).filter(e => slotOf(e) === s);
    if (g.length) { ks.push(g.reduce((a, e) => a + e.kcal, 0)); ps.push(g.reduce((a, e) => a + e.pro, 0)); } });
  if (ks.length < 3) return { kcal: mid * share, pro: T.protein * share };
  const med = a => { const b = [...a].sort((x, y) => x - y), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };
  return { kcal: Math.min(Math.max(med(ks), mid * 0.1), mid * 0.5), pro: Math.min(med(ps), T.protein * 0.5) };
}
/* everything the planner can use, with your usual amount and meal for each */
function planCandidates() {
  const t = todayIso(), since = shift(t, -PLAN_DAYS), map = new Map(), daysLogged = new Set(), slotDays = { breakfast: new Set(), lunch: new Set(), dinner: new Set(), snacks: new Set() };
  const pairs = new Map(), together = {};     // foods you have in the same meal on the same day go together in a plan too
  Object.keys(S.log).filter(d => d >= since && d < t).forEach(d => (S.log[d] || []).forEach(e => {
    daysLogged.add(d); slotDays[slotOf(e)]?.add(d);
    const f0 = e.food; if (!f0 || !(e.qty > 0) || ['entry', 'chain'].includes(f0.source)) return;
    let f;
    if (f0.source === 'meal') { const m = mealOf(f0); if (!m) return; f = mealFood(m); }
    else if (f0.source === 'idea') f = ideaFoods().find(x => x.id === f0.id) || null;
    else f = freshFood(f0);
    if (!f || !unitsFor(f).some(u => u.key === e.unit)) return;
    const c = map.get(f.id) || { food: f, amounts: new Map(), slots: {}, days: new Set() };
    const ak = `${r1(e.qty)}|${e.unit}|${oilKey(e.oil) || ''}`; c.amounts.set(ak, (c.amounts.get(ak) || 0) + 1);
    c.slots[slotOf(e)] = (c.slots[slotOf(e)] || 0) + 1; c.days.add(d); map.set(f.id, c);
    (together[d + slotOf(e)] ||= new Set()).add(f.id);
  }));
  Object.values(together).forEach(g => { const a = [...g].sort(); a.forEach((x, i) => a.slice(i + 1).forEach(y => pairs.set(x + '|' + y, (pairs.get(x + '|' + y) || 0) + 1))); });
  const out = [];
  map.forEach(c => {
    const [ak] = [...c.amounts.entries()].sort((a, b) => b[1] - a[1])[0], [q, unit, oil] = ak.split('|');
    const n = Object.values(c.slots).reduce((a, b) => a + b, 0), slots = Object.keys(c.slots).filter(s => c.slots[s] >= Math.max(1, n * 0.3));
    const cand = mkCand(c.food, +q, unit, oil || null, slots, c.days.size, c.food.source === 'idea');
    if (cand) out.push(cand);
  });
  S.meals.forEach(m => { const f = mealFood(m); if (map.has(f.id)) return;      // saved meals you haven't logged lately still count
    const cand = mkCand(f, 1, 'serving', null, [S.slotPref?.[f.id] || 'lunch', ...(S.slotPref?.[f.id] ? [] : ['dinner'])], 0, false); if (cand) out.push(cand); });
  ideaFoods().forEach(f => { if (map.has(f.id)) return;
    const slots = IDEA_SLOTS[f.id.slice(5)] || (f.snack ? ['snacks'] : ['lunch', 'dinner']);
    const cand = mkCand(f, 1, 'serving', null, slots, 0, true); if (cand) out.push(cand); });
  const nd = daysLogged.size, used = SLOTS.map(s => s[0]).filter(s => slotDays[s].size >= Math.max(2, nd * 0.25));
  return { list: out, pairs, days: nd, slots: used.length >= 2 ? used : ['breakfast', 'lunch', 'dinner'] };
}
function mkCand(food, qty, unit, oil, slots, freq, idea) {
  const base = calc(food, qty, unit); if (!(base.kcal >= PLAN_MIN_KCAL)) return null;
  const small = (unit === 'serving' || unit === 'piece') && qty <= 1 && base.kcal <= 250 && food.source !== 'meal' && !idea;
  const scales = idea || food.source === 'meal' ? [1] : unit === 'g' ? [0.75, 1, 1.25, 1.5] : small ? [1, 2] : HAND.includes(unit) || unit === 'cup' ? [1, 1.5] : [1];
  const at = {}; scales.forEach(s => { const q = planQty(qty * s, unit), v = calc(food, q, unit); at[s] = { q, kcal: v.kcal + (OIL[oil]?.k || 0), pro: v.pro }; });
  return { key: food.id, food, qty, unit, oil, slots, freq, idea, scales, at };
}
const planQty = (q, unit) => unit === 'g' ? Math.max(5, Math.round(q / 5) * 5) : Math.round(q * 4) / 4;
/* a plan: [{c, s, slot}]. Lower score is better. */
function planScore(items, base, T, recent, pairs) {
  let k = base.kcal, p = base.pro, ideas = 0, fam = 0; const per = {};
  for (const it of items) { const a = it.c.at[it.s]; k += a.kcal; p += a.pro; if (it.c.idea) ideas++; fam += Math.min(it.c.freq, 8); per[it.slot] = (per[it.slot] || 0) + 1; }
  const mid = (T.calLo + T.calHi) / 2;
  let sc = (Math.round(k) < T.calLo ? 40 + (T.calLo - k) * 8 : 0) + (Math.round(k) > T.calHi ? 40 + (k - T.calHi) * 8 : 0) + Math.abs(k - mid) * 0.15;
  sc += Math.max(0, T.protein - p) * 12 + (proHit(p, T) ? 0 : 60) + Math.max(0, p - T.protein - 30) * 0.5;   // showing 179 of 180 is a miss
  if (ideas > 2) sc += 1e4; if (ideas === 2) sc += 70; if (!ideas && items.length) sc += 25;   // one home idea is the norm, two now and then
  const bySlot = {}; items.forEach(it => (bySlot[it.slot] ||= []).push(it));
  const ids = new Set(items.filter(it => !it.c.idea).map(it => it.c.key));        // an idea repeating a food already in the plan (ground chicken twice)
  items.forEach(it => { if (it.c.idea && it.c.food.items?.some(x => ids.has(x.food.id))) sc += 35; });
  Object.entries(bySlot).forEach(([sl, g]) => {
    if (sl !== 'snacks' && !g.some(it => it.c.at[it.s].pro >= 15)) sc += 60;      // a main meal needs a protein (no plate of plain rice)
    if (pairs) g.forEach((a, i) => g.slice(i + 1).forEach(b => { const n = pairs.get([a.c.key, b.c.key].sort().join('|')) || 0; if (n >= 3) sc -= 12; }));
  });
  items.forEach(it => { const r = recent.indexOf(it.c.key); if (r >= 0) sc += 45 * (1 - r / Math.max(recent.length, 1)) + 15; });
  if (items.length) sc -= 6 * fam / items.length;
  Object.values(per).forEach(n => { if (n > 2) sc += (n - 2) * 40; });
  return { sc, kcal: k, pro: p };
}
function buildPlan(cands, slots, base, T, recent, avoidSig, minPer = 1) {
  const pools = {}; slots.forEach(s => { pools[s] = cands.list.filter(c => c.slots.includes(s)); if (!pools[s].length) pools[s] = cands.list.filter(c => !c.idea && c.at[1].kcal >= 200); });
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const pickW = pool => { const w = pool.map(c => 1 + Math.min(c.freq, 8) + 8 * c.at[1].pro / Math.max(c.at[1].kcal, 1) * 10); let x = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < pool.length; i++) { x -= w[i]; if (x <= 0) return pool[i]; } return pool[pool.length - 1]; };
  const lo = s => s === 'snacks' ? 0 : minPer;
  const fresh = () => { const it = []; slots.forEach(s => { const pool = pools[s]; if (!pool.length) return; const n = lo(s) + Math.floor(Math.random() * (3 - lo(s)));
    for (let i = 0; i < n; i++) { const c = pickW(pool); if (it.some(x => x.c.key === c.key)) continue; it.push({ c, s: rnd(c.scales), slot: s }); } }); return it; };
  const sig = it => it.map(x => `${x.slot}:${x.c.key}:${x.s}`).sort().join('|');
  /* v74: a breakfast, lunch or dinner left empty is a clear miss (the food picked for it may already be in another meal) */
  const scoreOf = it => planScore(it, base, T, recent, cands.pairs).sc + slots.filter(s => lo(s) > 0 && pools[s].length && !it.some(x => x.slot === s)).length * 250;
  const found = new Map();
  for (let trial = 0; trial < 160; trial++) {
    let cur = fresh(), best = scoreOf(cur);
    for (let step = 0; step < 50; step++) {
      const nx = cur.slice(), mv = Math.random(), s = rnd(slots), pool = pools[s]; if (!pool.length) continue;
      const inS = nx.map((x, i) => [x, i]).filter(([x]) => x.slot === s);
      if (mv < 0.4 && inS.length) { const [, i] = rnd(inS), c = rnd(pool); if (nx.some(x => x.c.key === c.key)) continue; nx[i] = { c, s: rnd(c.scales), slot: s }; }
      else if (mv < 0.65 && nx.length) { const i = Math.floor(Math.random() * nx.length); nx[i] = { ...nx[i], s: rnd(nx[i].c.scales) }; }
      else if (mv < 0.85 && inS.length < 2) { const c = rnd(pool); if (nx.some(x => x.c.key === c.key)) continue; nx.push({ c, s: rnd(c.scales), slot: s }); }
      else if (inS.length > lo(s)) { const [, i] = rnd(inS); nx.splice(i, 1); }
      else continue;
      const v = scoreOf(nx); if (v <= best) { best = v; cur = nx; }
    }
    const g = sig(cur); if (!found.has(g)) found.set(g, { items: cur, sc: best });
  }
  const ranked = [...found.entries()].filter(([g]) => g !== avoidSig).sort((a, b) => a[1].sc - b[1].sc);
  if (!ranked.length) return null;
  const top = ranked.filter(([, x]) => x.sc <= ranked[0][1].sc + 35).slice(0, 4);
  const [g, x] = rnd(top);
  return { sig: g, items: x.items };
}
/* the state of a day's plan: meals already eaten, meals still ahead (avail), and the ones the planner fills by itself (open:
   the meals you usually eat). v74: you can choose and lock any meal still ahead. */
function planCtx(d) {
  const t = todayIso(), T = S.targets, isToday = d === t, es = isToday ? entriesFor(d) : [];
  const cands = planCandidates(), h = nowH();
  const done = isToday ? SLOTS.map(s => s[0]).filter(s => es.some(e => slotOf(e) === s)) : [];
  const avail = SLOTS.map(s => s[0]).filter(s => !done.includes(s) && (!isToday || h < slotEnd(s)));
  const open = cands.slots.filter(s => avail.includes(s));
  const base = { kcal: es.reduce((a, e) => a + e.kcal, 0), pro: es.reduce((a, e) => a + e.pro, 0) };
  const end = mealTimes().last;
  return { d, isToday, T, es, cands, done, avail, open, base, closed: isToday && h >= end, light: isToday && h >= lightFrom() && h < end };
}
const planTk = T => `${T.calLo}|${T.calHi}|${T.protein}`;     // v74: the targets a plan was built for
/* builds (or rebuilds) a day's plan. Locked meals stay exactly as they are; everything else is planned around them. */
function makePlan(ctx, avoid) {
  const st = planStore(), recent = st.recent || [], old = st.plans?.[ctx.d];
  const later = (old?.later || []).filter(s => ctx.avail.includes(s));     // v90: meals left "not planned yet"
  const locked = (old?.items || []).filter(x => x.lock && ctx.avail.includes(x.slot) && !later.includes(x.slot)), lockedSlots = new Set(locked.map(x => x.slot));
  let base = locked.reduce((a, x) => { const v = planVal(x); return { kcal: a.kcal + v.kcal, pro: a.pro + v.pro }; }, { ...ctx.base });
  later.forEach(s => { const v = slotTypical(s); base = { kcal: base.kcal + v.kcal, pro: base.pro + v.pro }; });   // room kept for them
  const slots = ctx.open.filter(s => !lockedSlots.has(s) && !later.includes(s));
  let T = ctx.T, cands = ctx.cands, minPer = base.kcal >= ctx.T.calLo - 300 ? 0 : 1;
  if (ctx.light) {    // v90: close to your latest meal: keep what's left light, however much is left
    T = { calLo: Math.min(ctx.T.calLo, base.kcal + 150), calHi: Math.min(ctx.T.calHi, base.kcal + LIGHT_KCAL), protein: Math.min(ctx.T.protein, base.pro + LIGHT_PRO) };
    cands = { ...ctx.cands, list: ctx.cands.list.filter(c => c.at[1] && c.at[1].kcal <= LIGHT_KCAL) }; minPer = 1;
  }
  const r = slots.length ? buildPlan(cands, slots, base, T, recent, avoid, minPer) : null;
  const items = [...locked, ...(r ? r.items.map(x => ({ slot: x.slot, food: x.c.food, qty: x.c.at[x.s].q, unit: x.c.unit, oil: x.c.oil, idea: x.c.idea })) : [])];
  st.plans = Object.fromEntries(Object.entries(st.plans || {}).filter(([k]) => k >= shift(todayIso(), -1)));
  st.plans[ctx.d] = { items, sig: r?.sig || '', at: Date.now(), tk: planTk(ctx.T) };
  if (later.length) st.plans[ctx.d].later = later;
  if (ctx.light) st.plans[ctx.d].light = true;
  st.recent = [...items.filter(x => !x.lock).map(x => x.food.id), ...recent.filter(k => !items.some(x => x.food.id === k))].slice(0, 24);
  planSave(st); return st.plans[ctx.d];
}
function planEdit(d, fn) { const st = planStore(), p = st.plans?.[d]; if (!p) return null; fn(p); p.at = Date.now(); planSave(st); return p; }
const planVal = it => { const v = calc(it.food, it.qty, it.unit); return { kcal: v.kcal + (OIL[it.oil]?.k || 0), pro: v.pro, fib: v.fib }; };
function planReady() { const c = planCandidates(); return c.days >= 3 && c.list.filter(x => !x.idea).length >= 4; }
function renderPlanBtn() {
  const b = $('planBtn'); if (!b) return;
  b.hidden = day !== todayIso() || !planReady(); if (b.hidden) return;
  const p = planStore().plans?.[todayIso()], ctx = p ? planCtx(todayIso()) : null;
  const next = ctx && !ctx.closed ? SLOTS.map(s => s[0]).find(s => ctx.avail.includes(s) && p.items.some(x => x.slot === s)) : null;
  if (next) { const its = p.items.filter(x => x.slot === next), v = its.reduce((a, x) => { const y = planVal(x); return { kcal: a.kcal + y.kcal, pro: a.pro + y.pro }; }, { kcal: 0, pro: 0 });
    $('planSub').textContent = `Next: ${slotLabel(next)} · ${kc(v.kcal)} kcal · ${fmtG(v.pro)}g`; }
  else $('planSub').textContent = 'Meals from what you eat, to hit your targets';
}
const PL = { tab: 'today', rebuilt: false };
function openPlan(tab) {
  PL.tab = tab || (nowH() >= mealTimes().last ? 'tomorrow' : 'today');
  openSheet('Plan my day', '<div id="plWrap"></div>');
  renderPlan();
  sheetBody.onclick = e => {
    const t = e.target.closest('[data-pt]'), lg = e.target.closest('[data-pl]'), it = e.target.closest('[data-pi]');
    const ch = e.target.closest('[data-pc]'), lk = e.target.closest('[data-pk]'), rm = e.target.closest('[data-px]');
    const lt = e.target.closest('[data-plt]'), pa = e.target.closest('[data-pa]');
    if (t && !t.disabled) { PL.tab = t.dataset.pt; haptic(); renderPlan(); return; }
    if (e.target.closest('#plShuffle') || e.target.closest('#plRedo')) { haptic(); const d = planDay(); makePlan(planCtx(d), planStore().plans?.[d]?.sig); renderPlan(); replay($('plWrap'), 'fade-in'); return; }
    if (lg) { logPlanSlot(lg.dataset.pl); return; }
    if (lt) { haptic(); const s = lt.dataset.plt, d = planDay();      // v90: leave this meal for later, keep room for it
      if (!planStore().plans?.[d]) makePlan(planCtx(d));
      planEdit(d, p => { p.items = p.items.filter(x => x.slot !== s); p.later = [...new Set([...(p.later || []), s])]; });
      makePlan(planCtx(d)); renderPlan(); toast(`${slotLabel(s)} left open. Room is kept for it.`); return; }
    if (pa) { haptic(); const s = pa.dataset.pa, d = planDay();
      planEdit(d, p => { p.later = (p.later || []).filter(x => x !== s); if (!p.later.length) delete p.later; });
      makePlan(planCtx(d)); renderPlan(); toast(`${slotLabel(s)} planned`); return; }
    if (ch) { haptic(); openPlanPick(ch.dataset.pc); return; }
    if (lk) { haptic(); const s = lk.dataset.pk, d = planDay(); let on;
      planEdit(d, p => { const its = p.items.filter(x => x.slot === s); on = !its.every(x => x.lock); its.forEach(x => { x.lock = on; }); });
      renderPlan(); toast(on ? `${slotLabel(s)} locked. Shuffle won’t change it.` : `${slotLabel(s)} unlocked`); return; }
    if (rm) { haptic(); const d = planDay(), i = +rm.dataset.px; let gone;
      planEdit(d, p => { gone = p.items.splice(i, 1)[0]; });
      makePlan(planCtx(d)); renderPlan(); if (gone) toast(`Took ${gone.food.name} out. The rest is re-planned.`); return; }
    if (it && PL.tab === 'today') { const p = planStore().plans?.[todayIso()], x = p?.items[+it.dataset.pi]; if (x) openAmount(x.food, { qty: x.qty, unit: x.unit, oil: x.oil }, { slot: x.slot }); }
  };
}
const planDay = () => PL.tab === 'today' ? todayIso() : shift(todayIso(), 1);
/* v74: choose what goes in a meal: your saved meals, your usual foods, home ideas, or any food through search.
   The choice is locked in, and the meals that aren't locked are re-planned around it. */
function openPlanPick(s) {
  const d = planDay(), label = slotLabel(s).toLowerCase(), c = planCandidates();
  const meals = S.meals.map(mealFood), own = c.list.filter(x => !x.idea && x.food.source !== 'meal').sort((a, b) => (b.slots.includes(s) - a.slots.includes(s)) || b.freq - a.freq);
  const ideas = c.list.filter(x => x.idea).sort((a, b) => b.slots.includes(s) - a.slots.includes(s));
  const locked = (planStore().plans?.[d]?.items || []).some(x => x.slot === s && x.lock);
  const PK = [];
  const row = (f, qty, unit, sub) => { PK.push({ f, qty, unit }); const v = calc(f, qty, unit); return `<button class="item" data-pk2="${PK.length - 1}"><span class="nm">${esc(f.name)}<small>${esc(sub)}</small></span><span class="meta">${kc(v.kcal)} kcal · ${fmtG(v.pro)}g</span></button>`; };
  openSheet(`Choose ${label}`, `<p class="hint">${locked ? `It’s added to your ${label}.` : `It replaces what’s planned for ${label}.`} Your choice is locked in, and the rest of the day is re-planned around it.</p>
    ${meals.length ? `<h3>Your meals</h3><div class="list">${meals.map(f => row(f, 1, 'serving', '1 serving')).join('')}</div>` : ''}
    ${own.length ? `<h3>Your usual foods</h3><div class="list">${own.map(x => row(x.food, x.qty, x.unit, `${fmtQty(x.qty)} ${unitWord(x.food, x.unit, x.qty)}`)).join('')}</div>` : ''}
    ${ideas.length ? `<h3>Home ideas</h3><div class="list">${ideas.map(x => row(x.food, 1, 'serving', ideaWhat(x.food))).join('')}</div>` : ''}
    <button class="btn ghost" id="plSearch">Search all foods</button>
    <button class="btn ghost" id="plBack">Back to the plan</button>`);
  const put = (f, q, u) => {
    const st = planStore(); if (!st.plans?.[d]) makePlan(planCtx(d));
    planEdit(d, p => { const keep = p.items.filter(x => x.slot === s && x.lock); p.items = [...p.items.filter(x => x.slot !== s), ...keep, { slot: s, food: f, qty: q, unit: u, oil: null, idea: f.source === 'idea', lock: true }];
      if (p.later) { p.later = p.later.filter(x => x !== s); if (!p.later.length) delete p.later; } });
    makePlan(planCtx(d)); openPlan(PL.tab); toast(`${f.name} is in ${label}, locked`);
  };
  pick = { label: `Put in ${label}`, title: `Choose ${label}`, onDone: (f, q, u) => put(f, q, u) };
  sheetBody.onclick = e => {
    const b = e.target.closest('[data-pk2]');
    if (b) { const x = PK[+b.dataset.pk2]; pick = { label: `Put in ${label}`, title: `Choose ${label}`, onDone: (f, q, u) => put(f, q, u) }; openAmount(x.f, { qty: x.qty, unit: x.unit }); return; }
    if (e.target.closest('#plSearch')) { pick = { label: `Put in ${label}`, title: `Choose ${label}`, onDone: (f, q, u) => put(f, q, u) }; openSearch(); return; }
    if (e.target.closest('#plBack')) { pick = null; openPlan(PL.tab); }
  };
}
function renderPlan() {
  const box = $('plWrap'); if (!box) return;
  const d = planDay(), ctx = planCtx(d), T = S.targets;
  let p = planStore().plans?.[d], rebuilt = false;
  if (!p && !ctx.closed) p = makePlan(ctx);
  else if (p && !ctx.closed && p.tk !== planTk(T)) { p = makePlan(ctx); rebuilt = true; }   // v74: targets changed since it was built
  else if (p && !ctx.closed && !!p.light !== ctx.light && ctx.isToday) { p = makePlan(ctx); rebuilt = 'light'; }   // v90: it got late (or your meal times changed)
  const later = (p?.later || []).filter(s => ctx.avail.includes(s));
  const items = (p?.items || []).map((x, i) => ({ ...x, i })).filter(x => ctx.avail.includes(x.slot));
  const tot = items.reduce((a, x) => { const v = planVal(x); return { kcal: a.kcal + v.kcal, pro: a.pro + v.pro }; }, { ...ctx.base });
  const tabs = `<div class="seg2 pl-tabs" id="plTabs" role="group" aria-label="Which day"><button type="button" data-pt="today" aria-pressed="${PL.tab === 'today'}">Today</button><button type="button" data-pt="tomorrow" aria-pressed="${PL.tab === 'tomorrow'}">Tomorrow</button></div>`;
  if (ctx.closed) {
    box.innerHTML = tabs + `<p class="hint" id="plClosed">It's after ${esc(hourText(mealTimes().last))}, your latest meal time, so today's plan is done. Tomorrow's plan is ready when you are.</p>`; return;
  }
  const inR = Math.round(tot.kcal) >= T.calLo && Math.round(tot.kcal) <= T.calHi, proOk = Math.round(tot.pro) >= T.protein;
  const anyLock = items.some(x => x.lock);
  /* v90: room kept for meals left for later, shared by their usual sizes (and kept light when it's late) */
  const room = {}, typ = later.map(s => slotTypical(s)), tk = typ.reduce((a, v) => a + v.kcal, 0) || 1, tp = typ.reduce((a, v) => a + v.pro, 0) || 1;
  later.forEach((s, i) => { let k = Math.max(0, ((T.calLo + T.calHi) / 2 - tot.kcal) * typ[i].kcal / tk), hi = Math.max(0, (T.calHi - tot.kcal) * typ[i].kcal / tk);
    if (ctx.light) { k = Math.min(k, LIGHT_KCAL); hi = Math.min(hi, LIGHT_KCAL); }
    room[s] = { kcal: k, hi, pro: Math.max(0, (T.protein - tot.pro) * typ[i].pro / tp) }; });
  const roomK = Object.values(room).reduce((a, v) => a + v.kcal, 0);
  const names = list => list.map(x => slotLabel(x).toLowerCase()).join(' and ');
  let note;
  if (ctx.isToday && ctx.base.kcal >= T.calHi) note = `<p class="gwarn" id="plNote">You're at the top of your range for today. One day like this is fine; the weekly trend decides.</p>`;
  else if (!items.length && !later.length && ctx.isToday) note = `<p class="hint" id="plNote">${ctx.open.length ? 'You’re set for today: nothing more is needed to hit your targets.' : 'No meals left to plan for today.'}</p>`;
  else if (ctx.light) {
    const left = T.calLo - tot.kcal - roomK, what = items.some(x => x.slot === 'dinner') || later.includes('dinner') ? 'dinner' : 'what’s left';
    note = `<p class="hint" id="plNote"><span id="plLight">It’s close to your latest meal time (${esc(hourText(mealTimes().last))}), so ${what} is kept light, up to ${LIGHT_KCAL} kcal with protein first, to help you sleep.</span>${left >= 50 ? ` The other ${kc(left)} kcal ${mode() === 'gain' ? 'are short today; add them earlier tomorrow.' : 'stay in your weekly budget.'}` : ''}</p>`;
  } else if (later.length) {
    note = Math.round(tot.kcal) > T.calHi
      ? `<p class="gwarn" id="plNote">Your planned meals already come to ${kc(tot.kcal)} kcal, so there’s no room left for ${names(later)}. Shuffle, or take something out.</p>`
      : `<p class="hint" id="plNote">${rebuilt === true ? 'Re-planned for your new targets. ' : ''}The rest is planned around ${names(later)}, from what you’ve logged in the last 4 weeks. Log ${later.length > 1 ? 'them' : 'it'} as usual when you know what ${later.length > 1 ? 'they are' : 'it is'}.</p>`;
  } else if (!inR || !proOk) {
    const why = !inR ? `comes to ${kc(tot.kcal)} kcal` : `reaches ${fmtG(tot.pro)}g protein`;
    note = ctx.isToday && ctx.done.length && p?.at < Math.max(...ctx.es.map(e => e.at || 0))
      ? `<p class="gwarn" id="plNote">With what you've logged, this plan now ${why}. Re-plan the rest to get back on target.</p><button class="btn" id="plRedo">Re-plan the rest</button>`
      : `<p class="hint" id="plNote">${proOk ? '' : `The most protein ${anyLock ? 'this plan can reach with your locked meals' : 'your foods reach in this range'} is about ${fmtG(tot.pro)}g. A shake or egg whites would close the gap. `}${inR ? '' : `This is as close to ${kc(T.calLo)}–${kc(T.calHi)} kcal as ${anyLock ? 'your locked meals leave room for' : 'your foods allow'}.`}</p>`;
  } else note = `<p class="hint" id="plNote">${rebuilt === true ? 'Re-planned for your new targets. ' : ''}Built from the meals and foods you've logged in the last 4 weeks, at your usual amounts.</p>`;
  const pw = later.length ? ' planned' : '';
  const sum = `<div class="result" id="plSum"><div><span class="num">${kc(tot.kcal)}</span><small>kcal${pw}</small></div><div class="pro"><span class="num">${fmtG(tot.pro)}g</span><small>protein${pw}</small></div></div><p class="hint pl-target" id="plTarget">Your targets: ${kc(T.calLo)}–${kc(T.calHi)} kcal and ${T.protein}g protein${ctx.isToday && ctx.done.length ? ', counting what you’ve logged' : ''}${later.length ? `, with room kept for ${names(later)}` : ''}.</p>`;
  const groups = SLOTS.map(([s, label]) => {
    if (ctx.done.includes(s)) { const g = ctx.es.filter(e => slotOf(e) === s), k = g.reduce((a, e) => a + e.kcal, 0), pr = g.reduce((a, e) => a + e.pro, 0);
      return `<div class="pl-slot pl-done" data-slot="${s}"><div class="mg-h"><span>${label}</span><span class="mg-t">Logged ✓ · ${kc(k)} kcal · ${fmtG(pr)}g</span></div></div>`; }
    if (!ctx.avail.includes(s)) return '';
    if (later.includes(s)) { const r = room[s], lab = label.toLowerCase();
      const pOk = r.pro >= 5, pg = Math.round(r.pro);
      const txt = r.kcal >= 50 ? `Room for about <b>${kc(r.kcal)} kcal</b>${pOk ? ` and <b>${pg}g protein</b>` : ''}${r.hi - r.kcal >= 50 ? ` (up to ${kc(r.hi)} kcal keeps you in range)` : ''}.${pOk ? '' : ' The rest of the plan already covers your protein.'}${ctx.light ? ' Keep it light, it’s getting late.' : ''} Log whatever you have.` : `Your other meals already fill your range, so keep ${lab} light.`;
      return `<div class="pl-slot pl-later" data-slot="${s}"><div class="mg-h"><span>${label}<i class="pl-tag">Not planned yet</i></span><span class="mg-t">${r.kcal >= 50 ? `~${kc(r.kcal)} kcal${pOk ? ` · ${pg}g` : ''}` : ''}</span></div><p class="hint pl-room" id="plRoom-${s}">${txt}</p>`
        + `<div class="pl-acts"><button class="linkbtn" data-pc="${s}">Choose ${lab}</button><button class="linkbtn" data-pa="${s}">Plan it for me</button></div></div>`; }
    const g = items.filter(x => x.slot === s);
    if (!g.length) return `<div class="pl-slot pl-empty" data-slot="${s}"><div class="mg-h"><span>${label}</span><button class="linkbtn" data-pc="${s}">+ Add</button></div></div>`;
    const lock = g.every(x => x.lock), v = g.reduce((a, x) => { const y = planVal(x); return { kcal: a.kcal + y.kcal, pro: a.pro + y.pro }; }, { kcal: 0, pro: 0 });
    const rows = g.map(x => { const y = planVal(x), amt = `${fmtQty(x.qty)} ${unitWord(x.food, x.unit, x.qty)}${x.oil ? ` · ${OIL[x.oil].d}` : ''}`;
      const btn = `<button class="item" data-pi="${x.i}"${ctx.isToday ? '' : ' tabindex="-1"'}><span class="nm">${esc(x.food.name)}${x.idea ? '<i class="pl-tag">Idea</i>' : ''}<small>${esc(amt)}</small></span><span class="meta">${kc(y.kcal)} kcal · ${fmtG(y.pro)}g</span></button>`;
      return lock ? `<div class="meal-row">${btn}<button class="x" data-px="${x.i}" aria-label="Take ${esc(x.food.name)} out">${icon('i-x')}</button></div>` : btn; }).join('');
    return `<div class="pl-slot${lock ? ' pl-locked' : ''}" data-slot="${s}"><div class="mg-h"><span>${label}${lock ? '<i class="pl-tag pl-lock">🔒 Locked</i>' : ''}</span><span class="mg-t">${kc(v.kcal)} kcal · ${fmtG(v.pro)}g</span></div><div class="list">${rows}</div>`
      + (ctx.isToday ? `<button class="btn ghost pl-log" data-pl="${s}">Log ${label.toLowerCase()} · ${kc(v.kcal)} kcal</button>` : '')
      + `<div class="pl-acts"><button class="linkbtn" data-pc="${s}">${lock ? `+ Add to ${label.toLowerCase()}` : `Choose ${label.toLowerCase()}`}</button><button class="linkbtn" data-plt="${s}">Plan later</button><button class="linkbtn" data-pk="${s}">${lock ? 'Unlock' : '🔒 Lock'}</button></div></div>`;
  }).join('');
  box.innerHTML = tabs + sum + note + groups
    + (ctx.open.some(s => !later.includes(s)) && !(ctx.isToday && ctx.base.kcal >= T.calHi) ? `<button class="btn ghost" id="plShuffle">Shuffle${anyLock ? ' the unlocked meals' : ': another plan'}</button>` : '')
    + `<p class="hint">${ctx.isToday ? 'Tap a food to change its amount before logging it, or log a whole meal with one tap.' : 'Tomorrow this plan opens on Today, so you can log each meal as you eat it.'} Choose a meal to plan it yourself, or lock one you like: locked meals stay put and the rest is planned around them. Not sure yet? Plan later keeps room for that meal. Shuffle mixes up the rest and rotates in a home idea or two.</p>`;
}
function logPlanSlot(s) {
  const p = planStore().plans?.[todayIso()]; if (!p || day !== todayIso()) return;
  const its = p.items.filter(x => x.slot === s); if (!its.length) return;
  const now = Date.now(), ids = [];
  its.forEach((x, i) => { const f = freshFood(x.food), v = planVal({ ...x, food: f });
    const e = { id: uid(), name: f.name, kcal: r1(v.kcal), pro: r1(v.pro), detail: `${fmtQty(x.qty)} ${unitWord(f, x.unit, x.qty)}${x.oil ? ` · ${OIL[x.oil].d}` : ''}`, at: now + i, slot: s, food: f, qty: x.qty, unit: x.unit };
    setFib(e, v.fib); if (x.oil) e.oil = x.oil; (S.log[todayIso()] ||= []).push(e); ids.push(e.id); pushRecent(f, x.qty, x.unit); });
  const st = planStore(); if (st.plans?.[todayIso()]) { st.plans[todayIso()].at = now + its.length; planSave(st); }   // logged from the plan: still on plan
  touchDay(todayIso()); touchMeta(); renderTotals(); renderRows(); haptic(); renderPlan();
  const k = its.reduce((a, x) => a + planVal(x).kcal, 0);
  toast(`Logged ${slotLabel(s).toLowerCase()} · ${kc(k)} kcal`, { label: 'Undo', fn: () => {
    S.log[todayIso()] = entriesFor(todayIso()).filter(e => !ids.includes(e.id)); if (!S.log[todayIso()].length) delete S.log[todayIso()];
    touchDay(todayIso()); renderTotals(); renderRows(); if (SH.open && $('sheetTitle').textContent === 'Plan my day') renderPlan(); } });
}
$('planBtn').onclick = () => { haptic(); openPlan(); };

/* Weekly check-in: last full week (Monday to Sunday) */
function lastWeek() {
  const T = S.targets, ws = shift(weekStart(todayIso()), -7), we = shift(ws, 6);
  const days = Array.from({ length: 7 }, (_, i) => dayTotals(shift(ws, i))).filter(Boolean);
  const arr = weightsArr(), wNow = avgBetween(arr, ws, we), wPrev = avgBetween(arr, shift(ws, -7), shift(ws, -1));
  return { ws, we, n: days.length, avgK: days.length ? days.reduce((s, x) => s + x.kcal, 0) / days.length : null,
    avgP: days.length ? days.reduce((s, x) => s + x.pro, 0) / days.length : null,
    inRange: days.filter(x => kcalIn(x.kcal)).length, proHit: days.filter(x => proHit(x.pro)).length,
    onTarget: days.filter(x => kcalOnTarget(x.kcal)).length, low: mode() === 'lose' ? days.filter(x => kcalLow(x.kcal)).length : 0,   // v76
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
  const cut = m === 'lose', good = cut ? w.onTarget : w.inRange, goodTxt = cut ? 'on target' : 'in your calorie range';   // v76
  let verdict;
  if (w.n < 4) verdict = `Only ${w.n} day${w.n > 1 ? 's' : ''} logged, so take this week's numbers with a pinch of salt. Aim for at least 5.`;
  else if (wc == null) verdict = `${good} of ${w.n} logged days ${goodTxt}. Weigh in a few mornings a week to see how your weight responded.`;
  else {
    const moving = m === 'lose' ? wc < -0.2 : m === 'gain' ? wc > 0.1 : Math.abs(wc) <= 0.5;
    const move = m === 'maintain' ? 'your weight held steady' : `${m === 'lose' ? 'down' : 'up'} ${fW(Math.abs(wc))} ${wU()} on the weekly average`;
    verdict = moving ? `Good week: ${move}, with ${good} of ${w.n} days ${goodTxt}.`
      : `Your weekly average ${wc > 0.05 ? 'went up' : wc < -0.05 ? 'went down' : 'held steady'} (${wTxt} ${wU()}). One week can be noise from water and salt. If it repeats next week, adjust.`;
  }
  const sug0 = goalSuggestion(m), sug = sug0 && sug0.src === 'burn' ? { ...sug0, ...burnStep(sug0.lo, sug0.hi, T) } : sug0;   // v79: one step at a time
  let adj;
  if (sug && sug.src === 'burn' && (Math.abs(sug.lo - T.calLo) >= 100 || Math.abs(sug.hi - T.calHi) >= 100))
    adj = `<div class="ci-adj"><p class="hint">Your real burn now suggests <b>${kc(sug0.lo)}–${kc(sug0.hi)} kcal</b> for ${MODES[m]}. You're set to ${kc(T.calLo)}–${kc(T.calHi)}.${sug.capped ? ` That's a big change, so ${sug.lo > T.calLo ? 'go up' : 'come down'} ${BURN_STEP} kcal first and check again next week.` : ''}</p>
      <button class="btn ghost" id="ciUse">Update my targets to ${kc(sug.lo)}–${kc(sug.hi)}</button></div>`;
  else if (sug && sug.src === 'burn') adj = '<p class="hint">Your targets still match your real burn. Nothing to change.</p>';
  else adj = '<p class="hint">After about 4 weeks of logging and weighing in, your check-in can suggest target changes from your real burn.</p>';
  box.innerHTML = `<div class="ci-grid">
      <div><span class="v">${kc(w.avgK)}</span><span class="k">avg kcal</span></div>
      <div><span class="v">${Math.round(w.avgP)}g</span><span class="k">avg protein</span></div>
      <div><span class="v">${wTxt}</span><span class="k">weight (${wU()}) vs week before</span></div>
      <div><span class="v">${good}/${w.n}</span><span class="k">${cut ? 'days on target' : 'days in range'}</span></div>
      <div><span class="v">${w.proHit}/${w.n}</span><span class="k">protein days</span></div>
      <div><span class="v">${w.n}/7</span><span class="k">days logged</span></div>
    </div>
    <p class="ci-verdict">${esc(verdict)}</p>${w.low ? `<p class="hint" id="ciLow">${w.low === 1 ? '1 day was' : `${w.low} days were`} under ${kc(T.calLo - LOW_GAP)} kcal. Now and then is fine; eating that little often can cost muscle and energy.</p>` : ''}${adj}`;
  if ($('ciUse')) $('ciUse').onclick = () => {
    const old = { ...S.targets };
    S.targets = { ...S.targets, calLo: sug.lo, calHi: sug.hi, adjWk: weekStart(todayIso()) }; touchMeta(); renderAll(); renderTrends(); haptic();
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

/* ===================== v89: CALORIE CHECK-IN POP-UP AND WHAT'S NEW ===================== */
/* Kan (4 Nov): target steps shouldn't be a light nudge. When it's time to move your calories, a box pops up on its own (at most
   once a week) and asks: Yes changes the target (with Undo), Not now changes nothing until next week. Two things can ask:
   1. the real burn (same suggestion and 250 kcal steps as the Trends card and the check-in), or
   2. the trend watch: your weekly rate on the trend line is out of a healthy range for your goal two weeks running (this week's
      14 days and last week's 14 days), counting only after your first 2 weeks of weigh-ins. If too few days are logged, it asks
      you to log a full week instead of changing anything (unlogged snacks look like a big deficit).
   "Asked this week" is kept on this device (localStorage cutlog.adj) and in the targets (targets.adjWk, so it syncs and the
   other device doesn't ask again). Nothing else is stored. */
const ADJ_BAND = { lose: [-1.5, 0.2], maintain: [-0.5, 0.5], gain: [-0.1, 0.8] };   // lb a week on the trend line: [too fast down, too fast up]
const ADJ_LOGGED = 10;                                                             // of the last 14 finished days
let adjPending = false, adjCur = null;
function adjWeekAsked() {
  const wk = weekStart(todayIso()); let d = null; try { d = localStorage.getItem('cutlog.adj'); } catch (e) {}
  return (d && d >= wk) || (S.targets.adjWk && S.targets.adjWk >= wk);
}
const adjStepOf = (T, dir) => { const lo = Math.max(1200, T.calLo + dir * BURN_STEP); return { lo, hi: Math.max(lo + 100, T.calHi + dir * BURN_STEP) }; };
/* what the pop-up would say right now, or null */
function adjOffer() {
  const T = S.targets, m = mode(), t = todayIso();
  const sug = goalSuggestion(m);
  if (sug && sug.src === 'burn') {
    const st = burnStep(sug.lo, sug.hi, T);
    if (Math.abs(st.lo - T.calLo) >= 100 || Math.abs(st.hi - T.calHi) >= 100) {
      const gap = (sug.lo + sug.hi) / 2 - (T.calLo + T.calHi) / 2;
      return { kind: 'burn', lo: st.lo, hi: st.hi, steps: Math.max(1, Math.ceil(Math.abs(gap) / BURN_STEP - 0.2)),
        why: `Your real burn is about ${kc(r50(sug.burn))} kcal a day, so ${MODES[m].toLowerCase()} is about ${kc(sug.lo)}\u2060–\u2060${kc(sug.hi)}.${st.capped ? ` Going ${st.lo > T.calLo ? 'up' : 'down'} ${BURN_STEP} at a time lets next week's weigh-ins check it.` : ''}` };
    }
  }
  // trend watch
  const first = weightsArr()[0]; if (!first || shift(first.date, BURN_SETTLE) > shift(t, -20)) return null;   // both 2-week windows after your first 2 weeks
  const r1 = trendRate(t, RATE_MIN_DAYS), r2 = trendRate(shift(t, -7), RATE_MIN_DAYS); if (r1 == null || r2 == null) return null;
  const [dn, up] = ADJ_BAND[m], side = r => r < dn ? 1 : r > up ? -1 : 0, dir = side(r1);     // 1 = eat more, -1 = eat less
  if (!dir || side(r2) !== dir) return null;
  let logged = 0; for (let i = 1; i <= RATE_MIN_DAYS; i++) if (dayTotals(shift(t, -i))) logged++;
  const moved = r1 < 0 ? `lost ${fW(-r1)} ${wU()}` : `gained ${fW(r1)} ${wU()}`;
  const pace = m === 'lose' ? (dir > 0 ? `faster than about ${fW(-dn)} ${wU()} a week, the pace that protects your muscle` : 'while you\'re cutting')
    : m === 'maintain' ? `more than the ${fW(up)} ${wU()} a week that counts as holding steady` : (dir < 0 ? `faster than about ${fW(up)} ${wU()} a week, so more of it is likely fat` : 'while you\'re building');
  const base = `Your trend line has ${moved} a week over the last 2 weeks, ${pace}.`;
  if (logged < ADJ_LOGGED) return { kind: 'log', why: `${base} But only ${logged} of the last ${RATE_MIN_DAYS} days are logged, so Cut Log can't tell whether your calories need to change. Log everything for a week and it will check again.` };
  const st = adjStepOf(T, dir); if (st.lo === T.calLo && st.hi === T.calHi) return null;
  return { kind: 'trend', lo: st.lo, hi: st.hi, steps: 1, why: base };
}
function adjCheck() {
  adjPending = false;
  if (!S.onboarded || !$('adj').hidden || !$('onboard').hidden || adjWeekAsked()) return;
  if (SH.open || !$('celebrate').hidden) { adjPending = true; return; }      // shown once the panel or celebration closes
  let o = null; try { o = adjOffer(); } catch (e) { console.error('Cut Log adjOffer', e); } if (!o) return;
  adjCur = o; const T = S.targets, b = $('adj');
  if (o.kind === 'log') {
    $('adjTitle').textContent = 'Log a full week first'; $('adjCh').hidden = true; $('adjStep').hidden = true;
    $('adjYes').hidden = true; $('adjNo').textContent = 'Got it'; $('adjNote').textContent = 'Your target stays as it is.';
  } else {
    const d = o.lo - T.calLo;
    $('adjTitle').textContent = d > 0 ? 'Time to eat a bit more' : 'Time to eat a bit less';
    $('adjCh').hidden = false; $('adjOld').textContent = `${kc(T.calLo)}–${kc(T.calHi)}`; $('adjNew').textContent = `${kc(o.lo)}–${kc(o.hi)}`;
    $('adjStep').hidden = false; $('adjStep').className = 'adj-step ' + (d > 0 ? 'up' : 'down');
    $('adjStep').innerHTML = `<span>${d > 0 ? '+' : '−'}${kc(Math.abs(d))} kcal a day</span>${o.steps > 1 ? `<span> · step 1 of about ${o.steps}</span>` : ''}`;
    $('adjYes').hidden = false; $('adjYes').textContent = 'Yes, update my target'; $('adjNo').textContent = 'Not now';
    $('adjNote').textContent = "Not now keeps your target. It asks again at next week's check-in.";
  }
  $('adjWhy').textContent = o.why;
  b.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add('in')));   // no vibration: it opens without a tap
}
function adjClose(answer) {
  const wk = weekStart(todayIso()), o = adjCur, b = $('adj'); adjCur = null;
  try { localStorage.setItem('cutlog.adj', wk); } catch (e) {}
  b.classList.remove('in'); setTimeout(() => { b.hidden = true; }, 320);
  if (answer && o && o.lo) {
    const old = { ...S.targets, adjWk: wk };
    S.targets = { ...S.targets, calLo: o.lo, calHi: o.hi, adjWk: wk }; touchMeta(); renderAll(); if (tab === 'trends') renderTrends();
    toast('Target updated', { label: 'Undo', fn: () => { S.targets = old; touchMeta(); renderAll(); if (tab === 'trends') renderTrends(); } });
  } else { S.targets = { ...S.targets, adjWk: wk }; touchMeta(); }
}
$('adjYes').onclick = () => { haptic(); adjClose(true); };
$('adjNo').onclick = () => adjClose(false);

/* What's new: after an update, the changes since the version this device last saw show once on opening (people who just
   set the app up don't get it). Always available in You → Help. Last seen version: localStorage cutlog.seenV (per device).
   Every release adds an entry at the top, in plain words for everyone who uses Cut Log. */
const CHANGELOG = [
  { v: 94, d: '2026-11-06', items: [
    'Weight history: the change tile now reads "lb change" on one line, a new line under the tiles says which days the change and weekly rate cover, and each month\'s number is labelled as its average.',
  ] },
  { v: 93, d: '2026-11-06', items: [
    'Setting the weigh-in reminder time no longer closes the time picker while you\'re still scrolling it.',
  ] },
  { v: 92, d: '2026-11-06', items: [
    'Time boxes (Meal times, the weigh-in reminder time) now stay inside their card on iPhone instead of spilling over the edge and the box next to them.',
    'Messages that pop up while a panel is open (like "Dinner left open") now sit at the bottom of the panel, and the panel makes room for them, so they never cover its buttons or text.',
  ] },
  { v: 91, d: '2026-11-06', items: [
    'Notifications, in You → Notifications. A lunch or dinner check comes only when that meal isn\'t logged yet, and a last call 30 minutes before your latest meal tells you what\'s left for today.',
    'Weigh-in reminders at the time you pick: every morning if you weigh in daily, or on your chosen day if you weigh in weekly.',
    'Tap an alert to land on the right screen. Each phone has its own switches; they need Cut Log on your Home Screen and Cloud sync.'] },
  { v: 90, d: '2026-11-05', items: [
    'Set your own meal times in You → Meal times (breakfast, lunch, dinner and your latest meal). Plan my day plans around them.',
    'Close to your latest meal, Plan my day keeps what\'s left light, protein first, however many calories are left, so a late meal doesn\'t hurt your sleep. The rest stays in your weekly budget.',
    'Not sure what a meal will be yet? Tap Plan later in Plan my day: room is kept for it and the rest of the day is planned around it.'] },
  { v: 89, d: '2026-11-04', items: [
    'When it\'s time to change your calories, Cut Log now asks you with a pop-up: Yes updates your target, Not now leaves it. At most once a week.',
    'It also watches your weight trend: if you\'re losing or gaining much faster than your goal calls for, two weeks in a row, it suggests a 250 kcal change (or asks you to log a full week first).',
    'This What\'s new page, after each update. You can find it any time in You → Help.'] },
  { v: 88, d: '2026-11-04', items: ['In the protein, carbs and fibre history pages, 3M, 6M and 1Y switch on once you\'ve logged long enough for them to show something new.'] },
  { v: 87, d: '2026-11-04', items: ['Trends: See full protein history, See full carbs and fat history and See full fibre history. Every day with a 7-day average line, drag to read any day, and each month\'s average. Tapping those charts (not a bar) opens them too.'] },
  { v: 86, d: '2026-11-04', items: ['Shorter notes under fibre in More nutrients.'] },
  { v: 85, d: '2026-11-03', items: ['Carb totals only show once most of the day\'s food has carb data, so a few known foods can\'t give a misleading number.', 'Foods missing carbs get a "+ carbs" button to add them from the label, and scanned foods fill theirs in by themselves.'] },
  { v: 84, d: '2026-11-03', items: ['Carbs and fat: in More nutrients on Today, on How much?, and a new Carbs and fat card on Trends.'] }
];
const NEWS_MAX = 5;
function newsHtml(list) {
  return `<div class="news">${list.map(c => `<section class="news-v"><h3>Version ${c.v} · ${esc(parseIso(c.d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</h3><ul>${c.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></section>`).join('')}</div>`;
}
function openNews(list, auto) {
  openSheet("What's new", newsHtml(list) + (auto ? '<p class="hint" id="newsWhere">Every update is listed in You → Help → What\'s new.</p><button class="btn" id="newsOk">Got it</button>' : ''));
  if ($('newsOk')) $('newsOk').onclick = () => closeSheet();
}
function newsOnLaunch() {
  const cur = +APP_V; let seen = null; try { seen = localStorage.getItem('cutlog.seenV'); } catch (e) {}
  const mark = () => { try { localStorage.setItem('cutlog.seenV', String(cur)); } catch (e) {} };
  if (!S.onboarded) { mark(); return; }                                      // someone setting the app up: nothing has changed for them
  const had = Object.keys(S.log).length || Object.keys(S.weights).length;
  const from = seen ? +seen : had ? cur - 1 : cur;                          // before v89 nothing was remembered: show this update
  if (!(from < cur)) { if (!seen) mark(); return; }
  const list = CHANGELOG.filter(c => c.v > from && c.v <= cur).slice(0, NEWS_MAX);
  if (!list.length) { mark(); return; }
  if (SH.open || !$('celebrate').hidden) return;                             // busy (a meal being picked up): next time
  mark(); openNews(list, true);
}
$('newsBtn').onclick = () => { haptic(); openNews(CHANGELOG); };

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
/* v90: meal times */
function openTimesEdit(open) {
  if (open) { const mt = mealTimes(); $('tmB').value = hmOf(mt.breakfast); $('tmL').value = hmOf(mt.lunch); $('tmD').value = hmOf(mt.dinner); $('tmE').value = hmOf(mt.last); $('tmWarn').hidden = true; }
  toggleEdit('timesView', 'timesForm', open); $('timesEdit').hidden = open; $('timesHint').hidden = open;
}
function timesProblem(t) {
  if ([t.breakfast, t.lunch, t.dinner, t.last].some(x => x == null)) return 'Fill in all four times.';
  if (t.breakfast < 4) return 'Breakfast needs to be 4 am or later.';
  if (!(t.breakfast < t.lunch && t.lunch < t.dinner)) return 'Breakfast, lunch and dinner need to be in that order.';
  if (t.last < t.dinner) return 'Your latest meal can’t be before dinner.';
  return '';
}
$('timesEdit').onclick = () => openTimesEdit(true);
$('tmCancel').onclick = () => openTimesEdit(false);
$('tmSave').onclick = () => {
  const t = { breakfast: hOf($('tmB').value), lunch: hOf($('tmL').value), dinner: hOf($('tmD').value), last: hOf($('tmE').value) };
  const bad = timesProblem(t); $('tmWarn').hidden = !bad; $('tmWarn').textContent = bad; if (bad) return;
  S.targets = { ...S.targets, times: t }; touchMeta(); openTimesEdit(false); renderAll(); haptic(); toast('Meal times saved');
};
/* ---------- v91: NOTIFICATIONS ----------
   Alerts come from a small free Supabase function (server/cutlog-alerts in the project), which acts as the alarm clock:
   Firebase's free plan can't run anything on a schedule. Cut Log's data stays in Firebase. Each phone that turns alerts on
   sends that function: where to send pushes, its time zone, meal times, weigh-in setting, which alerts are on, and a short
   note for today (calories, protein, meals logged, weighed in). Settings for alerts are per phone (localStorage
   cutlog.push), never in saved data. Needs Cloud sync sign-in (the function checks the Firebase sign-in). */
var ALERTS_URL = window.CUTLOG_ALERTS_URL ?? 'https://mwgbphjchwmbvsyhkulu.supabase.co/functions/v1/cutlog-alerts';   // Supabase project cutlog-alerts. var: render functions can run before this line on launch           // set to the Supabase function's address once it exists
var PUSH_KEY = 'cutlog.push', PUSH_STALE = 6 * 36e5, PUSH_WAIT = 2500;
const ALERT_DEF = { breakfast: false, lunch: true, dinner: true, last: true, weigh: true, weighT: 7.5, weighDay: 1, checkin: false };
const ALERT_ROWS = [['lunch', 'Lunch check'], ['dinner', 'Dinner check'], ['last', 'Last call'], ['weigh', 'Weigh-in reminder'], ['breakfast', 'Breakfast check'], ['checkin', 'Monday check-in']];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function pushState() { try { return JSON.parse(localStorage.getItem(PUSH_KEY)) || {}; } catch (e) { return {}; } }
function pushSave(o) { try { localStorage.setItem(PUSH_KEY, JSON.stringify({ ...pushState(), ...o })); } catch (e) {} }
const alertPrefs = () => ({ ...ALERT_DEF, ...(pushState().prefs || {}) });
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
const pushCan = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
var PUSH_SLOT = null;          // a lunch alert opens search with Lunch picked (cleared when the panel closes)
var alertBusy = false, alertTimer = null;
// When each alert goes, in words, from the meal times (same rules as the alarm clock: 45 min after, 30 min before)
function alertWhen(k) {
  const mt = mealTimes(), lastAt = mt.last - 0.5, p = alertPrefs();
  if (k === 'last') return `${hourText(lastAt)}, with what's left for today`;
  if (k === 'checkin') return 'Monday at 9:00 AM';
  if (k === 'weigh') return scale() === 'weekly' ? `${DAYS_LONG[p.weighDay]} at ${hourText(p.weighT)}, if you haven't weighed in` : `Every morning at ${hourText(p.weighT)}, if you haven't weighed in`;
  const at = mt[k] + 0.75;
  if (k === 'dinner' && p.last && at >= lastAt - 0.5) return `If dinner isn't logged, the ${hourText(lastAt)} last call says so`;
  return `If ${k} isn't logged by ${hourText(at)}`;
}
// Today's note for the alarm clock: only numbers, no food names
function alertStatus() {
  const t = todayIso(), es = entriesFor(t), tot = dayTotals(t) || { kcal: 0, pro: 0 };
  return { d: t, kcal: Math.round(tot.kcal), pro: Math.round(tot.pro), calHi: S.targets.calHi, protein: S.targets.protein,
    slots: [...new Set(es.map(slotOf))], weighed: S.weights[t] != null };
}
function alertBody() {
  return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Toronto', prefs: alertPrefs(), times: mealTimes(), scale: scale(), status: alertStatus() };
}
async function alertCall(body, ms = 15000) {
  const tok = await Promise.race([Sync.user.getIdToken(), new Promise((_, no) => setTimeout(() => no(new Error('sign-in timeout')), 8000))]);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(ALERTS_URL, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    return { status: r.status, ...j };
  } finally { clearTimeout(t); }
}
async function swReg() {
  return Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('no service worker')), 6000))]);
}
async function alertsOn() {
  if (alertBusy) return; alertBusy = true; renderAlerts();
  try {
    const perm = await Notification.requestPermission();      // must come first, straight from the tap (iPhone)
    if (perm !== 'granted') { pushSave({ on: false }); toast(perm === 'denied' ? 'Notifications are blocked for Cut Log' : 'Notifications not turned on'); return; }
    const reg = await swReg();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const r = await fetch(ALERTS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'key' }) });
      const { key } = await r.json(); if (!key) throw new Error('no key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    }
    const body = alertBody(), j = await alertCall({ action: 'save', sub: sub.toJSON(), ...body });
    if (j.status !== 200) throw new Error('save ' + j.status);
    pushSave({ on: true, ep: sub.endpoint, sig: JSON.stringify(body), sentAt: Date.now(), okAt: Date.now(), failAt: 0 });
    haptic(); toast('Notifications on');
  } catch (e) {
    console.warn('Cut Log alerts:', e);
    toast(/sign-in/.test(e?.message) ? 'Couldn’t check your sign-in. Try again.' : 'Couldn’t turn notifications on. Try again.');
  } finally { alertBusy = false; renderAlerts(); }
}
async function alertsOff() {
  const ps = pushState(); pushSave({ on: false, sig: '' }); renderAlerts(); haptic(); toast('Notifications off on this phone');
  try { if (Sync.user && ps.ep) await alertCall({ action: 'remove', endpoint: ps.ep }); } catch (e) {}
  try { const sub = await (await swReg()).pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) {}
}
async function alertsTest() {
  const ps = pushState(); if (!ps.on || alertBusy) return;
  toast('Sending in 5 seconds. You can leave the app.'); haptic();
  try {
    const j = await alertCall({ action: 'test', endpoint: ps.ep }, 30000);
    if (j.gone) { pushSave({ on: false }); renderAlerts(); toast('Alerts were reset. Turn them on again.'); }
    else if (!j.ok) toast('The test didn’t go through. Try again later.');
  } catch (e) { toast('Couldn’t reach the alert server.'); }
}
// Keeps the alarm clock's copy current: after changes (a few seconds later), and at least every 6 hours the app is used
function alertsKick() { if (ALERTS_URL && pushState().on) { clearTimeout(alertTimer); alertTimer = setTimeout(() => safe(alertsSync), PUSH_WAIT); } }
async function alertsSync(force) {
  const ps = pushState(); if (!ps.on || !ALERTS_URL || !Sync.user || alertBusy) return;
  const body = alertBody(), sig = JSON.stringify(body);
  if (!force && sig === ps.sig && Date.now() - (ps.sentAt || 0) < PUSH_STALE) return;
  try {
    const j = await alertCall({ action: 'status', endpoint: ps.ep, ...body });
    if (j.status === 200) pushSave({ sig, sentAt: Date.now(), okAt: Date.now(), failAt: 0 });
    else if (j.gone) {                       // the alarm clock lost this phone (Apple reset it, or it was removed): sign up again quietly
      const sub = Notification.permission === 'granted' && await (await swReg()).pushManager.getSubscription();
      const k = sub && await alertCall({ action: 'save', sub: sub.toJSON(), ...body });
      if (k && k.status === 200) pushSave({ ep: sub.endpoint, sig, sentAt: Date.now(), okAt: Date.now(), failAt: 0 });
      else { pushSave({ on: false }); renderAlerts(); }
    } else pushSave({ failAt: Date.now() });
  } catch (e) { pushSave({ failAt: Date.now() }); }
  if ($('notifCard') && tab === 'you') renderAlerts();
}
function renderAlerts() {
  const card = $('notifCard'); card.hidden = !ALERTS_URL; if (!ALERTS_URL) return;
  const ps = pushState(), on = !!ps.on, p = alertPrefs();
  let text = '', btn = false;
  if (!pushCan()) text = isIOS() && !standalone() ? 'To get alerts, add Cut Log to your Home Screen (Share, then Add to Home Screen) and open it from there.' : 'This browser can’t show notifications from Cut Log.';
  else if (!Sync.user) text = 'Sign in under Account and sync first. Alerts use your account to know your meal times and what you’ve logged.';
  else if (!on && Notification.permission === 'denied') text = 'Notifications are blocked for Cut Log. Turn them on in your phone’s Settings, under Notifications, then come back here.';
  else if (!on) { text = 'Get a nudge when you forget to log a meal, before your latest meal, and for weigh-ins. Meal checks only come when that meal isn’t logged yet.'; btn = true; }
  else text = 'On for this phone. Meal checks only come when that meal isn’t logged yet.';
  $('ntText').textContent = text;
  $('ntOn').hidden = !btn; $('ntOn').disabled = alertBusy; $('ntOn').textContent = alertBusy ? 'Turning on…' : 'Turn on notifications';
  $('ntState').textContent = on ? 'On' : '';
  const show = on && pushCan() && !!Sync.user;
  $('ntList').hidden = $('ntFoot').hidden = !show;
  const stale = show && ps.failAt && Date.now() - (ps.okAt || 0) > 2 * 864e5;
  $('ntWarn').hidden = !stale;
  if (stale) $('ntWarn').textContent = `Couldn’t reach the alert server since ${shortDate(isoOf(new Date(ps.okAt || ps.failAt)))}. Alerts may be paused until it’s back.`;
  if (!show) return;
  const rows = ALERT_ROWS.filter(([k]) => k !== 'weigh' || scale() !== 'none');
  /* v93: never rebuild the list under a box that's being changed. On iPhone the time wheel sends a change each time it settles,
     and rebuilding the list replaced the box, which closed the wheel while Kan was still picking a time. Only the texts update. */
  const busy = document.activeElement, editing = busy && /^(INPUT|SELECT)$/.test(busy.tagName) && $('ntList').contains(busy);
  if (editing && rows.every(([k]) => $('ntW-' + k))) { rows.forEach(([k]) => { $('ntW-' + k).textContent = alertWhen(k); }); return; }
  $('ntList').innerHTML = rows.map(([k, name]) => `<div class="nt-row"><span class="nt-t"><b>${name}</b><small id="ntW-${k}">${esc(alertWhen(k))}</small></span><button type="button" class="nt-sw" role="switch" data-nt="${k}" aria-checked="${!!p[k]}" aria-label="${name}"></button></div>`
    + (k === 'weigh' && p.weigh ? `<div class="nt-weigh" id="ntWeigh"><label>Time<input type="time" id="ntWT" step="900" value="${hmOf(p.weighT)}"></label>${scale() === 'weekly' ? `<label>Day<select id="ntWD">${DAYS_LONG.map((d, i) => `<option value="${i}"${i === p.weighDay ? ' selected' : ''}>${d}</option>`).join('')}</select></label>` : ''}</div>` : '')).join('');
}
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function setAlertPref(patch) { pushSave({ prefs: { ...alertPrefs(), ...patch } }); renderAlerts(); alertsKick(); }
$('ntOn').onclick = alertsOn;
$('ntOff').onclick = alertsOff;
$('ntTest').onclick = alertsTest;
$('ntList').onclick = e => {
  const b = e.target.closest('[data-nt]'); if (!b) return;
  const k = b.dataset.nt, v = b.getAttribute('aria-checked') !== 'true';
  setAlertPref({ [k]: v }); haptic();
};
$('ntList').onchange = e => {
  if (e.target.id === 'ntWT') { const h = hOf(e.target.value); if (h != null && h >= 3 && h <= 14) setAlertPref({ weighT: h }); }   // v93: a time out of range is only refused once you're done picking
  if (e.target.id === 'ntWD') setAlertPref({ weighDay: +e.target.value });
};
$('ntList').addEventListener('focusout', e => {
  if (e.target.id !== 'ntWT') return;
  const h = hOf(e.target.value);
  if (!(h != null && h >= 3 && h <= 14)) toast('Pick a time between 3 AM and 2 PM');
  setTimeout(() => safe(renderAlerts), 0);    // the box shows the saved time again
});
// Opening the app from an alert: ./?open=log&slot=lunch | plan | weigh | checkin
function alertOpen(what, slot) {
  if (!S.onboarded || !what) return;
  if (SH.open) closeSheet();
  day = todayIso();
  if (what === 'checkin') { showTab('trends'); setTimeout(() => $('ciCard')?.scrollIntoView({ block: 'start', behavior: REDUCED ? 'auto' : 'smooth' }), 350); return; }
  showTab('today'); renderAll();
  if (what === 'log') { if (['breakfast', 'lunch', 'dinner'].includes(slot)) PUSH_SLOT = { slot, until: Date.now() + 15 * 6e4 }; setTimeout(() => safe(openSearch), 350); }
  else if (what === 'plan') setTimeout(() => safe(() => { if (!$('planBtn').hidden) openPlan(); }), 350);
  else if (what === 'weigh') setTimeout(() => { $('wForm').closest('.card').scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' }); if (!$('wForm').hidden) $('wIn').focus({ preventScroll: true }); }, 350);
}
const ALERT_LAUNCH = (() => { const q = new URLSearchParams(location.search), o = q.get('open'); if (!o) return null; try { history.replaceState(null, '', location.pathname); } catch (e) {} return { what: o, slot: q.get('slot') }; })();
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data?.cutlog === 'open') safe(() => alertOpen(e.data.open, e.data.slot)); });
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
  openAmount(entryFood(en), en.food ? { qty: en.qty, unit: en.unit, oil: en.oil, adds: en.adds } : { qty: 1, unit: 'serving' }, { editId: en.id });
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
    labelForm($('labelOut'), { kcal: per ? Math.round(per.k) : Math.round(f.kcal100), pro: per ? r1(per.p) : r1(f.pro100 || 0), fib: fibPerServ(f, per ? f.servingG : null), ...macPerServ(f, per ? f.servingG : null), servingG: f.servingG || (per ? null : 100) }, '', f.barcode || null, f.name, f.id);
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkNewDay(); renderAll(); if (Sync.user) flush(); setTimeout(() => safe(adjCheck), 1200); } });

/* app feel: no pinch zoom (iOS ignores the viewport setting) */
['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));

renderAll();
if (S.onboarded) { const md = loadDraft(); if (autoResume(md)) { markDraft('resumed', true); setTimeout(() => safe(() => resumeDraft(md.d, true)), 300); } }
if (!S.msInit && S.onboarded) { S.msInit = true; checkMilestones(true); }
if (!S.onboarded) showOnboarding(1);
else if (!REDUCED) document.body.classList.add('launch');
if (ALERT_LAUNCH) setTimeout(() => safe(() => alertOpen(ALERT_LAUNCH.what, ALERT_LAUNCH.slot)), 500);   // v91: opened from an alert (What's new waits for the next launch)
else { setTimeout(() => safe(newsOnLaunch), 800); setTimeout(() => safe(adjCheck), 1600); }   // v89
initSync();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
