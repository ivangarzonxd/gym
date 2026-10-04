// Gym Vancho — app de entrenamiento, progresión y nutrición.
// Estado en localStorage (caché/offline) + sincronización con Google Sheets vía Apps Script.

const KEY = 'planRetorno.v1';
const BASE_KCAL = 1700;
const PROTEIN_G = 150;
const FAT_G = 65;
const INC = { bar: 2.5, db: 2, mq: 2.5 };
const ROUND = { bar: 2.5, db: 2, mq: 2.5 };

// ---------- Estado ----------
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.v === 1) return s;
  } catch (e) {}
  return { v: 1, start: null, sessions: {}, daily: {}, food: {}, kcalAdjust: 0, cfg: { url: '', token: '' }, queue: {}, tab: 'hoy', lastSync: null };
}
let S = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
}

// ---------- Utilidades ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dkey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 86400000);
const addDays = (k, n) => { const d = parseD(k); d.setDate(d.getDate() + n); return dkey(d); };
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
const fmt = (n, dec = 1) => (n == null ? '–' : Number(n.toFixed(dec)).toLocaleString('es-ES'));
const roundTo = (x, step) => Math.round(x / step) * step;
const fmtTime = (s) => `${Math.floor(s / 60)}:${pad(s % 60)}`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const TODAY = () => dkey();
const FOOD_BY_NAME = Object.fromEntries(FOODS.map((f) => [f[0], f]));
const DAY_BY_ID = Object.fromEntries(DAYS.map((d) => [d.id, d]));

// ---------- Semana del plan / RIR ----------
function planWeek() {
  if (!S.start) return 1;
  return Math.floor(daysBetween(S.start, TODAY()) / 7) + 1;
}
function phase(week = planWeek()) {
  if (week % 6 === 0) return { rir: '4', label: 'Semana de descarga', deload: true, tip: 'Mismo ejercicio, −10 % de peso y una serie menos. Recuperas y vuelves más fuerte.' };
  if (week <= 2) return { rir: '3', label: 'Readaptación', tip: 'En TODAS las series: elige un peso con el que podrías hacer 3 reps más de las que pide la app, y para. Tendones y articulaciones primero.' };
  if (week <= 5) return { rir: '2', label: 'Construcción', tip: 'Elige un peso con el que podrías hacer 2 reps más de las que pide la app. Aquí empieza la progresión de verdad.' };
  return { rir: '1-2', label: 'Progresión', tip: 'Básicos con RIR 2; aislamientos pueden ir a RIR 1.' };
}

// ---------- Historial de ejercicios ----------
function sessionDates() {
  return Object.keys(S.sessions).sort();
}
// Series hechas de un ejercicio (por slug) en sesiones anteriores a `before`, de la más reciente a la más antigua
function history(slug, before = TODAY()) {
  const out = [];
  for (const date of sessionDates().reverse()) {
    if (date >= before) continue;
    const day = S.sessions[date];
    for (const did in day) {
      const sets = day[did][slug];
      if (!sets) continue;
      const done = sets.filter((x) => x.done && x.reps != null);
      if (done.length) out.push({ date, day: did, sets: done });
    }
  }
  return out;
}

// ---------- Motor de progresión (doble progresión) ----------
// Devuelve la prescripción de hoy: peso y reps objetivo por serie + mensaje.
function prescribe(dayId, row) {
  const [slug, nSets, rmin, rmax] = row;
  const ex = EX[slug];
  const ph = phase();
  const hist = history(slug);
  const base = nSets + (ex.main && planWeek() >= 3 ? 1 : 0);
  const sets = ph.deload ? Math.max(1, base - 1) : base;
  const step = ROUND[ex.inc] || 1;

  if (!hist.length) {
    return { sets, kg: ex.startKg ?? null, reps: Array(sets).fill(rmax), status: 'cal',
      msg: ex.start || `Primera vez: elige un peso con el que harías ${rmax + 3} reps. Haz ${rmax} y apunta; la app ajusta la siguiente serie.` };
  }
  const last = hist[0].sets;
  const w = Math.max(...last.map((x) => x.kg ?? 0));
  const repsLast = last.map((x) => x.reps);

  if (ex.inc === 'time' || ex.inc === 'bw') {
    const allTop = last.length >= nSets && repsLast.every((r) => r >= rmax);
    if (ex.inc === 'time') {
      const t = allTop ? Math.min(rmax, Math.max(...repsLast) + 5) : Math.min(rmax, Math.max(...repsLast) + 5);
      return { sets, kg: null, reps: Array(sets).fill(allTop ? rmax : t), status: allTop ? 'up' : 'same',
        msg: allTop ? `Ya aguantas ${rmax} s: pon un disco de 5 kg en la espalda o eleva los pies.` : `+5 s por serie respecto a la última vez.` };
    }
    if (allTop) {
      const kg = w < 0 ? Math.min(0, w + 5) : w + 2.5;
      return { sets, kg, reps: Array(sets).fill(rmin), status: 'up',
        msg: w < 0 ? `Llegaste a ${rmax}: quita 5 kg de asistencia (${kg} kg).` : `Llegaste a ${rmax}: añade lastre (${kg} kg) o haz las reps más lentas.` };
    }
    return { sets, kg: w || null, reps: last.map((x, i) => Math.min(rmax, (repsLast[i] ?? repsLast[repsLast.length - 1]) + 1)).concat(Array(Math.max(0, sets - last.length)).fill(rmin)).slice(0, sets),
      status: 'same', msg: 'Mismas condiciones, +1 rep por serie.' };
  }

  if (ph.deload) {
    const kg = roundTo(w * 0.9, step);
    return { sets, kg, reps: Array(sets).fill(rmin), status: 'deload', msg: `Descarga: ${fmt(kg)} kg (−10 %) y una serie menos. No busques récords.` };
  }

  const allTop = last.length >= nSets && repsLast.every((r) => r >= rmax);
  if (allTop) {
    const kg = w + INC[ex.inc];
    return { sets, kg, reps: Array(sets).fill(rmin), status: 'up',
      msg: `¡Completaste ${nSets}×${rmax}! Sube a ${fmt(kg)} kg y vuelve a ${rmin} reps.` };
  }
  // Dos sesiones seguidas por debajo del mínimo con el mismo peso → bajar 10 %
  const below = (s) => s.some((x) => x.reps < rmin);
  if (hist[1] && below(last) && below(hist[1].sets) && Math.max(...hist[1].sets.map((x) => x.kg ?? 0)) === w) {
    const kg = roundTo(w * 0.9, step);
    return { sets, kg, reps: Array(sets).fill(rmax), status: 'down',
      msg: `Dos sesiones sin llegar a ${rmin}: baja a ${fmt(kg)} kg y reconstruye. Es normal, no es retroceso.` };
  }
  const reps = [];
  for (let i = 0; i < sets; i++) {
    const r = repsLast[i] ?? repsLast[repsLast.length - 1];
    reps.push(Math.min(rmax, Math.max(rmin, r + 1)));
  }
  return { sets, kg: w, reps, status: 'same', msg: `Mismo peso (${fmt(w)} kg), intenta +1 rep en cada serie.` };
}

// Calentamiento calculado a partir del peso de trabajo
function warmups(ex, kg, first) {
  if (!kg || kg <= 0) return [];
  const step = ROUND[ex.inc] || 2.5;
  if (ex.main && first) {
    const out = [];
    if (ex.inc === 'bar') out.push({ kg: 20, reps: 10, label: 'Barra vacía' });
    for (const [pct, reps] of [[0.5, 6], [0.7, 4], [0.85, 2]]) {
      const w = roundTo(kg * pct, step);
      if (w > (out.length ? out[out.length - 1].kg : 0) && w < kg) out.push({ kg: w, reps, label: `${pct * 100} %` });
    }
    return out;
  }
  if (ex.warm || ex.main) {
    const w = roundTo(kg * 0.6, step);
    return w > 0 && w < kg ? [{ kg: w, reps: 8, label: '60 %' }] : [];
  }
  return [];
}

// Ajuste dentro de la sesión: según la serie anterior hecha hoy
function inSessionHint(ex, row, sets, i, target) {
  const [, , rmin, rmax] = row;
  if (i === 0 || ex.inc === 'time' || ex.inc === 'bw') return null;
  const prev = sets[i - 1];
  if (!prev || !prev.done || prev.reps == null || prev.kg == null) return null;
  const step = ROUND[ex.inc] || 2.5;
  if (prev.reps >= rmax + 2) return { kg: prev.kg + INC[ex.inc], text: `Te sobraron reps: sube a ${fmt(prev.kg + INC[ex.inc])} kg` };
  if (prev.reps < rmin - 1) { const k = roundTo(prev.kg * 0.9, step); return { kg: k, text: `Te quedaste corto: baja a ${fmt(k)} kg` }; }
  return null;
}

// ---------- Sesiones ----------
function sessionFor(date, dayId) {
  S.sessions[date] ??= {};
  S.sessions[date][dayId] ??= {};
  return S.sessions[date][dayId];
}
function setsFor(date, dayId, slug, n) {
  const ses = sessionFor(date, dayId);
  ses[slug] ??= [];
  while (ses[slug].length < n) ses[slug].push({ kg: null, reps: null, done: false });
  return ses[slug];
}
function dayDone(date, dayId) {
  const ses = S.sessions[date]?.[dayId];
  if (!ses) return 0;
  let n = 0;
  for (const k in ses) n += ses[k].filter((x) => x.done).length;
  return n;
}
function trainedDays() {
  const out = [];
  for (const date of sessionDates()) for (const did in S.sessions[date]) if (dayDone(date, did) > 0) out.push({ date, day: did });
  return out;
}
function slotRow(day, idx) {
  const r = day.ex[idx];
  const sw = S.swaps?.[day.id + ':' + idx];
  return sw && EX[sw] ? [sw, ...r.slice(1)] : r;
}
function nextDay() {
  const tr = trainedDays();
  const order = DAYS.map((d) => d.id);
  if (!tr.length) return { day: 'd1' };
  const last = tr[tr.length - 1];
  const all = trainedDays();
  const today = TODAY();
  const doneToday = all.filter((t) => t.date === today);
  const y1 = all.some((t) => t.date === addDays(today, -1));
  const y2 = all.some((t) => t.date === addDays(today, -2));
  const y3 = all.some((t) => t.date === addDays(today, -3));
  return { day: order[(order.indexOf(last.day) + 1) % order.length], doneToday, rest: !doneToday.length && y1 && y2 && y3 };
}

// ---------- Nutrición ----------
function dailyOf(date = TODAY()) {
  S.daily[date] ??= { active: null, weight: null, waist: null, grip: false, creatine: false };
  return S.daily[date];
}
function kcalTarget(date = TODAY()) {
  const d = S.daily[date];
  const active = d?.active ?? null;
  return { target: Math.round(BASE_KCAL + S.kcalAdjust + (active ?? 500) / 2), active, provisional: active == null };
}
function foodOf(date = TODAY()) {
  S.food[date] ??= [];
  return S.food[date];
}
function foodTotals(date = TODAY()) {
  const t = { kcal: 0, p: 0, c: 0, f: 0, drinks: 0 };
  for (const it of S.food[date] || []) { t.kcal += it.kcal; t.p += it.p; t.c += it.c; t.f += it.f; t.drinks += it.drinks || 0; }
  return t;
}
function makeFoodEntry(food, grams, meal) {
  const [name, kcal, p, c, f, u, drinks] = food;
  const it = { id: uid(), meal, name, per: [kcal, p, c, f, drinks ? drinks / u[1] : 0], u };
  return setGrams(it, grams);
}
function setGrams(it, grams) {
  const [kcal, p, c, f, dpg] = it.per;
  const k = grams / 100;
  return Object.assign(it, { g: grams, kcal: Math.round(kcal * k), p: +(p * k).toFixed(1), c: +(c * k).toFixed(1), f: +(f * k).toFixed(1), drinks: +(dpg * grams).toFixed(2) });
}
const MEALS = ['desayuno', 'batido', 'almuerzo', 'merienda', 'cena', 'extra'];
const MEAL_NAME = { desayuno: 'Desayuno', batido: 'Batido post-gym', almuerzo: 'Almuerzo', merienda: 'Merienda (trabajo)', cena: 'Cena', extra: 'Extras y bebidas' };
// Comida que toca según la hora
function mealByHour(d = new Date()) {
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < 300) return 'cena'; // después de medianoche
  if (m < 13 * 60) return 'desayuno';
  if (m < 13 * 60 + 30) return 'batido';
  if (m < 15 * 60) return 'almuerzo';
  if (m < 21 * 60) return 'merienda';
  return 'cena';
}
function nextScheduleItem() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const toM = (t) => { const [h, m] = t.split(':').map(Number); return (h < 5 ? h + 24 : h) * 60 + m; };
  const cur = mins < 300 ? mins + 1440 : mins;
  return SCHEDULE.find((s) => toM(s[0]) >= cur - 15) || SCHEDULE[0];
}
function weekDrinks() {
  const today = TODAY();
  const dow = (parseD(today).getDay() + 6) % 7; // lunes = 0
  let n = 0;
  for (let i = 0; i <= dow; i++) n += foodTotals(addDays(today, -i)).drinks;
  return n;
}
// Tendencia de peso: compara media de la última semana con la de hace 2 semanas
function weightTrend() {
  const pts = Object.keys(S.daily).sort().filter((k) => S.daily[k].weight != null).map((k) => ({ date: k, w: S.daily[k].weight }));
  if (pts.length < 2) return { pts, msg: null };
  const last = pts[pts.length - 1];
  const ref = [...pts].reverse().find((p) => daysBetween(p.date, last.date) >= 13);
  if (!ref) return { pts, msg: null };
  const perWeek = ((ref.w - last.w) / daysBetween(ref.date, last.date)) * 7;
  let action = null;
  if (perWeek < 0.25) action = { delta: -150, text: `Bajas ${fmt(perWeek, 2)} kg/semana (objetivo 0,4-0,8). Recomendado: −150 kcal al día.` };
  else if (perWeek > 1) action = { delta: +150, text: `Bajas ${fmt(perWeek, 2)} kg/semana: demasiado rápido, perderías músculo. Recomendado: +150 kcal al día.` };
  return { pts, perWeek, action, msg: action ? null : `Bajas ${fmt(perWeek, 2)} kg/semana: ritmo perfecto, no toques nada.` };
}

// ---------- Sincronización con Google Sheets ----------
function enqueue(ev) {
  S.queue[ev.type + ':' + ev.id] = ev;
  save();
  scheduleSync();
}
function queueSet(date, dayId, slug, i, set) {
  enqueue({ type: 'set', id: `${date}|${dayId}|${slug}|${i + 1}`, date, day: dayId, ex: slug, name: EX[slug].name, set: i + 1, kg: set.kg, reps: set.reps, done: set.done });
}
function queueDaily(date) {
  const d = dailyOf(date);
  const t = foodTotals(date);
  enqueue({ type: 'daily', id: date, date, active: d.active, target: kcalTarget(date).target, eaten: t.kcal, protein: Math.round(t.p), weight: d.weight, waist: d.waist, drinks: t.drinks, grip: d.grip, creatine: !!d.creatine });
}
function queueFood(date, it, del = false) {
  enqueue({ type: 'food', id: it.id, date, meal: it.meal, name: it.name, g: it.g, kcal: it.kcal, p: it.p, c: it.c, f: it.f, drinks: it.drinks, del });
  queueDaily(date);
}
let syncTimer = null;
let syncing = false;
function scheduleSync(ms = 1500) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, ms);
}
async function api(payload) {
  const res = await fetch(S.cfg.url, { method: 'POST', body: JSON.stringify({ token: S.cfg.token, ...payload }) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Error');
  return data;
}
async function sync() {
  if (!S.cfg.url || syncing || !navigator.onLine) return renderSync();
  const events = Object.values(S.queue);
  if (!events.length) return renderSync();
  syncing = true; renderSync();
  try {
    await api({ action: 'push', events });
    for (const ev of events) if (S.queue[ev.type + ':' + ev.id] === ev) delete S.queue[ev.type + ':' + ev.id];
    S.lastSync = new Date().toISOString();
    save();
  } catch (e) {
    console.warn('sync', e);
  }
  syncing = false; renderSync();
}
async function restore() {
  const data = await api({ action: 'pull' });
  for (const r of data.series || []) {
    if (!r.done) continue;
    const sets = setsFor(r.date, r.day, r.ex, r.set);
    sets[r.set - 1] = { kg: r.kg === '' ? null : Number(r.kg), reps: r.reps === '' ? null : Number(r.reps), done: true };
  }
  for (const r of data.diario || []) {
    const d = dailyOf(r.date);
    d.active = r.active === '' ? null : Number(r.active);
    d.weight = r.weight === '' ? null : Number(r.weight);
    d.waist = r.waist === '' ? null : Number(r.waist);
    d.grip = r.grip === true || r.grip === 'TRUE';
    d.creatine = r.creatine === true || r.creatine === 'TRUE';
  }
  for (const r of data.comidas || []) {
    const list = foodOf(r.date);
    if (!list.some((x) => x.id === r.id)) list.push({ id: r.id, meal: r.meal, name: r.name, g: Number(r.g), kcal: Number(r.kcal), p: Number(r.p), c: Number(r.c), f: Number(r.f), drinks: Number(r.drinks) || 0 });
  }
  if (!S.start) { const ds = sessionDates(); if (ds.length) S.start = ds[0]; }
  save();
}
function renderSync() {
  const el = $('#sync');
  if (!el) return;
  const pending = Object.keys(S.queue).length;
  if (!S.cfg.url) { el.className = 'sync off'; el.textContent = ''; return; }
  if (syncing) { el.className = 'sync busy'; el.textContent = 'Guardando…'; return; }
  if (pending) { el.className = 'sync warn'; el.textContent = navigator.onLine ? 'Pendiente' : 'Sin conexión'; return; }
  el.className = 'sync ok'; el.textContent = 'Guardado';
}

// ---------- Temporizador de descanso ----------
let timer = null;
let audioCtx = null;
function beep() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < 3; i++) {
      const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.25;
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    }
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}
function startTimer(sec, label) {
  try { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch (e) {}
  clearInterval(timer?.id);
  const end = Date.now() + sec * 1000;
  const bar = $('#timer');
  bar.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    bar.innerHTML = `<div class="tfill" style="width:${(left / sec) * 100}%"></div><span>Descanso · ${esc(label)}</span><b>${fmtTime(left)}</b><button data-act="timer-add">+30 s</button><button data-act="timer-stop">✕</button>`;
    if (left <= 0) { clearInterval(timer.id); beep(); bar.innerHTML = `<span>¡A por la siguiente serie!</span><button data-act="timer-stop">OK</button>`; }
  };
  timer = { id: setInterval(tick, 500), end, sec, label };
  tick();
}

// ---------- Render ----------
const ICONS = {
  hoy: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  entreno: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>',
  comida: '<path d="M7 3v7a2 2 0 0 0 4 0V3M9 12v9M16.5 3C15 3 14 5 14 8s1 4 2.5 4V21"/>',
  ajustes: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
};
const NAV = [['hoy', 'Hoy'], ['entreno', 'Entreno'], ['comida', 'Comida'], ['ajustes', 'Ajustes']];
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
let selDay = null; // día elegido en Entreno
let openEx = null; // ejercicio desplegado (null = el primero sin terminar)

function render() {
  if (!NAV.some(([id]) => id === S.tab)) S.tab = 'hoy';
  $('#nav').innerHTML = NAV.map(([id, l]) => `<button class="nv ${S.tab === id ? 'on' : ''}" data-tab="${id}">${svg(ICONS[id])}<span>${l}</span></button>`).join('');
  $('#title').textContent = S.tab === 'hoy' ? 'Gym Vancho' : NAV.find(([id]) => id === S.tab)[1];
  const main = $('#main');
  main.innerHTML = S.tab === 'hoy' ? viewHoy() : S.tab === 'entreno' ? viewEntreno() : S.tab === 'comida' ? viewComida() : viewAjustes();
  renderSync();
}

function bar(value, max, cls = '') {
  const pct = Math.min(100, (value / max) * 100 || 0);
  return `<div class="meter ${cls}"><div style="width:${pct}%"></div></div>`;
}
function weekStart(k = TODAY()) { return addDays(k, -((parseD(k).getDay() + 6) % 7)); }
function doneThisWeek(dayId) { const ws = weekStart(); return trainedDays().some((t) => t.day === dayId && t.date >= ws); }
function scheduleHtml() {
  return `<ul class="sched">${SCHEDULE.map(([h, t, d, end]) => `<li><time>${h}${end ? '–' + end : ''}</time><div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join('')}</ul>`;
}

// ---------- Hoy ----------
function viewHoy() {
  const today = TODAY();
  const now = new Date();
  const wd = now.getDay();
  const nd = nextDay();
  const planned = DAYS.find((d) => d.wdn === wd);
  const ph = phase();
  const kt = kcalTarget();
  const ft = foodTotals();
  const dl = dailyOf();
  const wt = weightTrend();
  const drinks = weekDrinks();
  const gripWeek = (() => { let n = 0; const ws = weekStart(); for (let k = ws; k <= today; k = addDays(k, 1)) if (S.daily[k]?.grip) n++; return n; })();
  const doneToday = trainedDays().filter((t) => t.date === today);
  const [h, what, det, end] = nextScheduleItem();

  let training;
  if (doneToday.length) {
    const d = DAY_BY_ID[doneToday[0].day];
    training = `<span class="eyebrow">Entreno de hoy</span><div class="row"><h2>${d.title}</h2><span class="tick">✓</span></div>
      <p class="muted">Hecho: ${dayDone(today, d.id)} series. Ahora toca comer bien y descansar.</p>
      <button class="btn ghost block" data-act="go-day" data-day="${d.id}">Ver entreno</button>`;
  } else if (!planned) {
    const d = DAY_BY_ID[nd.day];
    training = `<span class="eyebrow">Hoy</span><h2>Descanso</h2>
      <p class="muted">${wd === 3 ? 'Caminata de 30-45 min o clase de Movilidad / Stretching. Gripper en casa.' : 'Descanso total. Gripper en casa.'}</p>
      <p class="muted small">Próximo entreno: ${d.wd}, ${d.title}.</p>`;
  } else {
    const d = DAY_BY_ID[nd.day];
    const after = d.cardio === 'intervalos' ? 'Correr 25 min al terminar' : '10 min caminando' + (d.klass ? ' + clase (' + d.klass + ')' : '');
    training = `<span class="eyebrow">Entreno de hoy${d.id !== planned.id ? ' · te toca por orden' : ''}</span>
      <h2>${d.title}</h2><p class="muted">${esc(d.sub)}</p>
      <dl class="facts">
        <div><dt>Horario</dt><dd>11:00 – 13:00</dd></div>
        <div><dt>Zapatillas</dt><dd>${d.shoes === 'run' ? 'De correr' : 'Planas (Converse / Vans)'}</dd></div>
        <div><dt>Al terminar</dt><dd>${esc(after)}</dd></div>
        <div><dt>Intensidad</dt><dd>RIR ${ph.rir} · ${ph.label}</dd></div>
      </dl>
      <button class="btn block" data-act="go-day" data-day="${d.id}">Empezar entreno</button>`;
  }

  return `
  <section class="hero-img ${S.goalImg ? '' : 'empty'}">
    ${S.goalImg ? `<img src="${S.goalImg}" alt="Mi meta">` : ''}
    <label class="hero-empty"><input type="file" accept="image/*" id="goalimg" hidden><b>Añade tu imagen de meta</b><span>Toca para elegirla de tus fotos</span></label>
    <div class="hero-ov"><span>${cap(now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }))}</span><b>Semana ${planWeek()} · ${ph.label}</b></div>
  </section>

  <section class="panel">${training}</section>

  <section class="panel">
    <span class="eyebrow">Ahora</span>
    <div class="now"><time>${h}${end ? '–' + end : ''}</time><div><b>${esc(what)}</b><p class="muted">${esc(det)}</p></div></div>
    <details class="more"><summary>Ver horario del día</summary>${scheduleHtml()}</details>
  </section>

  <section class="panel">
    <div class="row"><span class="eyebrow">Comida</span><button class="link" data-tab="comida">Añadir comida</button></div>
    <div class="kpis">
      <div><b>${fmt(ft.kcal, 0)}</b><span>de ${fmt(kt.target, 0)} kcal</span></div>
      <div><b>${fmt(ft.p, 0)} g</b><span>de ${PROTEIN_G} g de proteína</span></div>
    </div>
    ${bar(ft.kcal, kt.target, ft.kcal > kt.target ? 'over' : '')}
    ${bar(ft.p, PROTEIN_G)}
  </section>

  <section class="panel">
    <span class="eyebrow">Hábitos de hoy</span>
    <button class="check" data-act="creatine"><span class="cb ${dl.creatine ? 'on' : ''}"></span><span><b>Creatina 5 g</b><small>Con el batido post-gym o con el almuerzo</small></span></button>
    <button class="check" data-act="grip"><span class="cb ${dl.grip ? 'on' : ''}"></span><span><b>Gripper en casa</b><small>${gripWeek} de 3 días esta semana · 4 series al fallo</small></span></button>
    <div class="check static"><span class="val ${drinks > 4 ? 'bad' : ''}">${fmt(drinks, 1)}</span><span><b>Alcohol esta semana</b><small>Máximo 4 consumiciones · se cuenta al registrarlo en Comida</small></span></div>
  </section>

  <section class="panel">
    <span class="eyebrow">Watch y báscula</span>
    <label class="field"><span>Calorías activas del Watch (app Fitness, anillo rojo)</span>
      <input type="number" inputmode="numeric" data-daily="active" value="${dl.active ?? ''}" placeholder="Ej. 650"></label>
    <p class="muted small">${kt.provisional ? 'Mientras no lo metas, cuento 500. Puedes ponerlo cuando quieras y el objetivo se recalcula.' : `Objetivo de hoy: ${BASE_KCAL}${S.kcalAdjust ? (S.kcalAdjust > 0 ? ' + ' : ' − ') + Math.abs(S.kcalAdjust) : ''} + la mitad de ${kt.active} = ${kt.target} kcal.`}</p>
    <div class="grid2">
      <label class="field"><span>Peso (kg)</span><input type="number" inputmode="decimal" step="0.1" data-daily="weight" value="${dl.weight ?? ''}" placeholder="80,0"></label>
      <label class="field"><span>Cintura (cm)</span><input type="number" inputmode="decimal" step="0.5" data-daily="waist" value="${dl.waist ?? ''}" placeholder="A la altura del ombligo"></label>
    </div>
    <p class="muted small">Peso y cintura: una vez por semana, en ayunas.</p>
    ${spark(wt.pts)}
    ${wt.action ? `<div class="alert">${wt.action.text}<button class="btn small" data-act="adjust" data-delta="${wt.action.delta}">Aplicar ${wt.action.delta > 0 ? '+' : ''}${wt.action.delta} kcal</button></div>` : wt.msg ? `<p class="ok small">${wt.msg}</p>` : ''}
  </section>`;
}

function spark(pts) {
  if (pts.length < 2) return '';
  const p = pts.slice(-16);
  const ws = p.map((x) => x.w);
  const min = Math.min(...ws) - 0.5, max = Math.max(...ws) + 0.5;
  const W = 320, H = 70;
  const xy = p.map((x, i) => [(i / (p.length - 1)) * (W - 10) + 5, H - 8 - ((x.w - min) / (max - min)) * (H - 16)]);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${xy.map((a) => a.join(',')).join(' ')}"/>${xy.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3"/>`).join('')}</svg>
  <div class="sparklbl"><span>${fmt(ws[0])} kg</span><span>${fmt(ws[ws.length - 1])} kg</span></div>`;
}

// ---------- Entreno ----------
function viewEntreno() {
  const today = TODAY();
  if (!selDay) { const p = DAYS.find((d) => d.wdn === new Date().getDay()); selDay = p ? p.id : nextDay().day; }
  const day = DAY_BY_ID[selDay];
  const rows = day.ex.map((r, idx) => slotRow(day, idx));
  const prs = rows.map((r) => prescribe(day.id, r));
  const total = prs.reduce((a, p) => a + p.sets, 0);
  const done = dayDone(today, day.id);
  const ph = phase();
  const week = planWeek();
  const cardio = CARDIO[day.cardio].find((c) => week >= c.weeks[0] && week <= c.weeks[1]);
  if (openEx === null) {
    const i = rows.findIndex((r, idx) => setsFor(today, day.id, r[0], prs[idx].sets).slice(0, prs[idx].sets).some((s) => !s.done));
    openEx = i >= 0 ? day.id + ':' + i : '';
  }
  return `
  <nav class="days">${DAYS.map((d) => `<button class="dchip ${d.id === day.id ? 'on' : ''}" data-act="day" data-day="${d.id}">${d.wd.slice(0, 3)}${doneThisWeek(d.id) ? '<i>✓</i>' : ''}</button>`).join('')}</nav>

  <header class="dh">
    <div><span class="eyebrow">${day.wd}</span><h2>${day.title}</h2><p class="muted">${esc(day.sub)}</p></div>
    <div class="count"><b>${done}</b>/${total}<small>series</small></div>
  </header>
  ${bar(done, total)}
  <dl class="facts">
    <div><dt>Zapatillas</dt><dd>${day.shoes === 'run' ? 'De correr (y planas para las pesas si puedes)' : 'Planas y duras (Converse / Vans)'}</dd></div>
    <div><dt>Intensidad</dt><dd>RIR ${ph.rir}: elige un peso con el que podrías hacer ${ph.rir === '1-2' ? '1-2' : ph.rir} reps más</dd></div>
  </dl>

  <details class="block"><summary>Calentamiento · 8 min</summary>
    <p>5 min de cinta a paso rápido, 10 rotaciones de hombro, 10 sentadillas sin peso y 10 aperturas de brazos. El primer ejercicio trae sus series de aproximación calculadas.</p>
    <p class="muted small">Los 2 primeros ejercicios no se mueven (los pesados y los press con mancuernas). Del 3º en adelante, si algo está ocupado, cambia el orden o usa "Cambiar ejercicio".</p>
  </details>

  <ol class="exlist">${rows.map((r, idx) => exItem(day, r, idx, prs[idx])).join('')}</ol>

  <details class="block"><summary>${esc(cardio.title)}</summary>
    <ul class="plain">${cardio.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <p class="muted small">Watch: Entreno → Correr (o Caminar) en interior. Zona 2 ≈ 110-135 ppm: puedes hablar en frases.</p>
  </details>
  ${day.klass ? `<div class="block"><b>Clase recomendada</b><p class="muted">${esc(day.klass)}. Resérvala en la app de VivaGym (hasta 7 días antes, máx. 2 al día).</p></div>` : ''}
  <div class="block"><b>Vuelta a la calma · 5 min</b><p class="muted">Estira pecho, dorsal, cuádriceps y femoral 30 s cada uno. Bebe agua.</p></div>
  <button class="textbtn" data-act="reset-day">Reiniciar las series de hoy de este día</button>`;
}

function exItem(day, row, idx, pr) {
  const [slug, , rmin, rmax, rest] = row;
  const ex = EX[slug];
  const key = day.id + ':' + idx;
  const sets = setsFor(TODAY(), day.id, slug, pr.sets);
  const nDone = sets.slice(0, pr.sets).filter((s) => s.done).length;
  const complete = nDone >= pr.sets;
  const open = openEx === key;
  const unit = ex.inc === 'time' ? 's' : 'reps';
  return `<li class="ex ${complete ? 'complete' : ''} ${open ? 'open' : ''}" id="ex-${key.replace(':', '-')}">
    <button class="exhead" data-act="open-ex" data-key="${key}">
      <span class="num">${complete ? '✓' : idx + 1}</span>
      <span class="exname"><b>${esc(ex.name)}</b><small>${pr.sets} × ${rmin}-${rmax} ${unit}${pr.kg != null ? ' · ' + fmt(pr.kg) + ' kg' : ''}</small></span>
      <span class="exstate">${nDone}/${pr.sets}</span>
    </button>
    ${open ? exBody(day, row, idx, pr, sets) : ''}
  </li>`;
}

function exBody(day, row, idx, pr, sets) {
  const [slug, , rmin, rmax, rest, tags] = row;
  const ex = EX[slug];
  const hist = history(slug);
  const unit = ex.inc === 'time' ? 's' : 'reps';
  const wu = warmups(ex, pr.kg, idx === 0);
  const opts = [day.ex[idx][0], ...(day.ex[idx][6] || [])];
  const key = day.id + ':' + idx;
  const lastTxt = hist.length ? `${hist[0].sets.map((s) => (s.kg != null ? fmt(s.kg) + '×' : '') + s.reps).join(' · ')}` : 'Primera vez';
  const notes = [];
  if (ex.rightFirst) notes.push('Brazo derecho primero. El izquierdo iguala las reps del derecho, nunca más.');
  if (ex.extraRight) notes.push('Solo el lado derecho: serie extra para igualar el pectoral.');
  if (tags.includes('Superserie') && tags.includes('Bíceps')) notes.push('Superserie: 1 serie de curl, 1 de tríceps sin descanso, descansa y repite.');

  const rowsHtml = [];
  for (let i = 0; i < pr.sets; i++) {
    const s = sets[i];
    const hint = inSessionHint(ex, row, sets, i);
    const kgPh = hint?.kg ?? pr.kg;
    rowsHtml.push(`
    <div class="set ${s.done ? 'done' : ''}" data-day="${day.id}" data-idx="${idx}" data-slug="${slug}" data-i="${i}">
      <span class="sn">${i + 1}</span>
      ${ex.inc === 'time' ? '<span class="kg na">—</span>' : `<label class="kg"><input type="number" inputmode="decimal" step="0.5" data-f="kg" value="${s.kg ?? ''}" placeholder="${kgPh ?? 'kg'}"><i>kg</i></label>`}
      <label class="rp"><input type="number" inputmode="numeric" data-f="reps" value="${s.reps ?? ''}" placeholder="${pr.reps[i] ?? rmax}"><i>${unit}</i></label>
      <button class="chk" data-act="set" aria-label="Serie hecha">${s.done ? '✓' : ''}</button>
      ${hint && !s.done ? `<div class="sethint">${hint.text}</div>` : ''}
    </div>`);
  }

  return `<div class="exbody">
    <button class="imgwrap" data-act="zoom" data-img="${IMG + ex.img}" aria-label="Ampliar imagen"><img src="${IMG + ex.img}" alt="${esc(ex.name)}" onerror="this.parentNode.classList.add('noimg')"></button>
    <div class="prog ${pr.status}">
      <div><small>Última vez</small><p>${lastTxt}</p></div>
      <div><small>Hoy</small><p><b>${pr.kg != null ? fmt(pr.kg) + ' kg × ' : ''}${pr.reps.join(' · ')}</b></p></div>
      <p class="msg">${esc(pr.msg)}</p>
    </div>
    ${notes.map((n) => `<p class="note-strong">${n}</p>`).join('')}
    ${wu.length ? `<div class="wu"><small>Aproximación (no se apuntan)</small><div>${wu.map((w) => `<span>${fmt(w.kg)} kg × ${w.reps}</span>`).join('')}</div></div>` : ''}
    <div class="sets"><div class="sethead"><span></span><span>Peso</span><span>Reps</span><span></span></div>${rowsHtml.join('')}</div>
    <p class="muted small">Descanso entre series: ${fmtTime(rest)}. Al marcar una serie arranca el temporizador.</p>
    <p class="tech">${esc(ex.note)}</p>
    <div class="exlinks">
      ${opts.length > 1 ? `<button class="textbtn" data-act="swap-open">Cambiar ejercicio</button>` : '<span></span>'}
      <a href="${GUIDE + slug}" target="_blank" rel="noopener">Guía completa ↗</a>
    </div>
    ${opts.length > 1 ? `<div class="swaps" hidden><small>¿Máquina ocupada o no la hay? Cada opción guarda su progreso:</small>${opts.map((o) => `<button class="${o === slug ? 'on' : ''}" data-act="swap" data-key="${key}" data-slug="${o}">${esc(EX[o].name)}${o === slug ? ' ✓' : ''}</button>`).join('')}</div>` : ''}
  </div>`;
}

// ---------- Comida ----------
let curMeal = null; // pestaña de comida elegida (si no, la que toca por la hora)
const mealNow = () => curMeal || mealByHour();

function foodItemsHtml(items) {
  return `<ul class="food">${items.map((x) => {
    const units = x.u && x.g ? x.g / x.u[1] : 0;
    const ulabel = units ? ` <em>≈ ${fmt(units, 1)} ${esc(x.u[0])}</em>` : '';
    return `<li>
      <span>${esc(x.name)}${ulabel}</span>
      ${x.per ? `<label class="fg"><input type="number" inputmode="decimal" data-food-g="${x.id}" value="${x.g}"><i>g</i></label>` : '<span></span>'}
      <span>${x.kcal} kcal</span>
      <button data-act="food-del" data-id="${x.id}" aria-label="Borrar">✕</button>
    </li>`;
  }).join('')}</ul>`;
}

function menuRow(name, meal, list) {
  const f = FOOD_BY_NAME[name];
  const [ul, ug] = f[5];
  const it = list.find((x) => x.meal === meal && x.name === name);
  const n = it ? it.g / ug : 0;
  return `<div class="mrow ${n ? 'on' : ''}">
    <div><b>${esc(name)}</b><small>1 ${esc(ul)} · ${Math.round((f[1] * ug) / 100)} kcal · ${fmt((f[2] * ug) / 100, 0)} g prot.</small></div>
    <div class="step">
      <button data-act="menu" data-name="${esc(name)}" data-d="-1" ${n ? '' : 'disabled'} aria-label="Quitar">−</button>
      <span>${fmt(n, 1)}</span>
      <button data-act="menu" data-name="${esc(name)}" data-d="1" aria-label="Añadir">+</button>
    </div>
  </div>`;
}

function viewComida() {
  const date = TODAY();
  const kt = kcalTarget();
  const ft = foodTotals();
  const list = foodOf(date);
  const meal = mealNow();
  const left = kt.target - ft.kcal;
  const pLeft = PROTEIN_G - ft.p;
  const kcalOf = (m) => list.filter((x) => x.meal === m).reduce((a, x) => a + x.kcal, 0);
  const others = list.filter((x) => x.meal === meal && !MENU[meal].some(([, names]) => names.includes(x.name)));
  const summary = MEALS.map((m) => {
    const items = list.filter((x) => x.meal === m);
    if (!items.length) return '';
    return `<li><div class="row"><b>${MEAL_NAME[m]}</b><span>${kcalOf(m)} kcal</span></div><p>${items.map((x) => x.name + (x.u && x.g ? ` ×${fmt(x.g / x.u[1], 1)}` : '')).join(' · ')}</p></li>`;
  }).join('');

  return `
  <section class="panel">
    <div class="kpis">
      <div><b>${fmt(ft.kcal, 0)}</b><span>de ${fmt(kt.target, 0)} kcal</span></div>
      <div><b>${fmt(ft.p, 0)} g</b><span>de ${PROTEIN_G} g de proteína</span></div>
    </div>
    ${bar(ft.kcal, kt.target, ft.kcal > kt.target ? 'over' : '')}
    ${bar(ft.p, PROTEIN_G)}
    <p class="muted small">${left >= 0 ? `Te quedan ${fmt(left, 0)} kcal.` : `Te has pasado ${fmt(-left, 0)} kcal; mañana sin cambios.`} ${pLeft > 0 ? `Te faltan ${fmt(pLeft, 0)} g de proteína${pLeft > 40 ? ': 2º batido o tu kit (huevo cocido, lata de atún).' : '.'}` : 'Proteína del día cubierta.'}</p>
  </section>

  <nav class="seg">${MEALS.map((m) => `<button class="${m === meal ? 'on' : ''}" data-act="meal" data-meal="${m}">${MEAL_NAME[m].replace(' (trabajo)', '').replace(' post-gym', '').replace(' y bebidas', '')}</button>`).join('')}</nav>

  <section class="panel">
    <div class="row"><h3>${MEAL_NAME[meal]}</h3><span class="muted">${kcalOf(meal)} kcal</span></div>
    <p class="muted small">Pulsa + por cada unidad que comiste (2 huevos = + +). Cantidades de comida ya hecha.</p>
    ${MENU[meal].map(([h, names]) => `<h4>${esc(h)}</h4><div class="menu">${names.map((n) => menuRow(n, meal, list)).join('')}</div>`).join('')}
    ${others.length ? `<h4>Otros añadidos</h4>${foodItemsHtml(others)}` : ''}
  </section>

  <section class="panel">
    <h3>¿No está en la lista?</h3>
    <label class="field"><span>Buscar (se añade a ${MEAL_NAME[meal].toLowerCase()})</span><input id="f-q" type="search" placeholder="Sardinas, pera, cerveza…" autocomplete="off"></label>
    <div id="f-res" class="results"></div>
    <details class="more"><summary>Comida fuera de casa (calorías a ojo)</summary>
      <div class="grid2">
        <label class="field"><span>Qué era</span><input id="m-name" placeholder="Menú del día"></label>
        <label class="field"><span>Kcal aprox.</span><input id="m-kcal" type="number" inputmode="numeric" placeholder="800"></label>
        <label class="field"><span>Proteína (g)</span><input id="m-p" type="number" inputmode="numeric" placeholder="40"></label>
        <button class="btn" data-act="manual-add">Añadir</button>
      </div>
      <p class="muted small">Referencias: menú del día 900-1.200 · hamburguesa con patatas 1.100 · pizza mediana 1.000-1.300 · bocadillo de jamón 450 · kebab 800.</p>
    </details>
  </section>

  ${summary ? `<section class="panel"><h3>Resumen de hoy</h3><ul class="daysum">${summary}</ul></section>` : ''}`;
}

// ---------- Ajustes y guías ----------
function guide(title, body) {
  return `<details class="gitem"><summary>${title}</summary><div>${body}</div></details>`;
}
function guidesHtml() {
  const lifts = ['barbell-bench-press', 'squat', 'barbell-row', 'barbell-deadlift', 'smith-machine-shoulder-press', 'incline-dumbbell-bench-press'];
  const e1rm = (kg, r) => kg * (1 + r / 30);
  const rowsL = lifts.map((slug) => {
    const h = history(slug, '9999-12-31');
    if (!h.length) return `<tr><td>${esc(EX[slug].name)}</td><td colspan="3" class="muted">Sin datos</td></tr>`;
    const best = (s) => Math.max(...s.sets.map((x) => e1rm(x.kg ?? 0, x.reps)));
    const b0 = best(h[h.length - 1]), b1 = best(h[0]);
    return `<tr><td>${esc(EX[slug].name)}</td><td>${fmt(b0, 0)}</td><td>${fmt(b1, 0)}</td><td class="${b1 >= b0 ? 'ok' : 'bad'}">${b1 >= b0 ? '+' : ''}${fmt(((b1 - b0) / b0) * 100 || 0, 0)} %</td></tr>`;
  }).join('');

  return [
    guide('Tu fuerza', `<table class="tbl"><tr><th>Ejercicio</th><th>Inicio</th><th>Ahora</th><th></th></tr>${rowsL}</table><p class="muted small">1RM estimado (kg) con la mejor serie de cada sesión.</p>`),
    guide('Tu semana y las clases', `<table class="tbl">${DAYS.map((d) => `<tr><td>${d.wd}</td><td><b>${d.title}</b><br><span class="muted">${d.cardio === 'intervalos' ? 'Correr 25 min' : '10 min suaves' + (d.klass ? ' + ' + esc(d.klass) : '')}</span></td></tr>`).join('')}
      <tr><td>Miércoles</td><td>Caminata o Movilidad / Stretching · gripper</td></tr><tr><td>Domingo</td><td>Descanso total · gripper</td></tr></table>
      <ul class="plain"><li>Cada músculo 2 veces por semana; el hombro lateral 3.</li><li>Si faltas un día, sigue el orden: la pantalla Hoy te dice cuál toca.</li><li>Press con mancuernas por encima de la cara: siempre de primeros.</li><li>Clases sí: Boxeo, Abdominales/Xpress, Movilidad, Stretching, Pilates. No por ahora: HIT, V-Cross, V-Power, V-Hybrid, Cycling tras pierna.</li><li>Si 2 semanas seguidas baja la fuerza, duermes mal o duelen las articulaciones: quita el sábado hasta recuperarte.</li></ul>`),
    guide('Cómo progresas', `<ol class="plain"><li>Cada ejercicio tiene un rango, por ejemplo 3 × 8-10.</li><li>Todas las series con el mismo peso. Es normal que las reps bajen un poco: 10 · 9 · 8.</li><li>Cada sesión intenta +1 rep con el mismo peso.</li><li>Cuando completas todas las series al máximo del rango, la app sube el peso (+2,5 kg barra o máquina, +2 kg mancuerna) y vuelves al mínimo de reps.</li><li>Si en una serie te sobran 2 o más reps, la app te dice que subas en la siguiente; si te quedas corto, que bajes.</li><li>Dos sesiones seguidas sin llegar al mínimo: −10 % y reconstruyes.</li><li>Cada 6 semanas, descarga: −10 % y una serie menos.</li></ol>`),
    guide('RIR (reps en reserva)', `<p>Las reps que te quedan en el depósito al acabar la serie. No es hacer menos reps de las que pide la app, sino elegir el peso: si pide 10 y estás en RIR 3, usa un peso con el que podrías hacer 13, haz 10 y para.</p><ul class="plain"><li>Semanas 1-2: RIR 3</li><li>Semanas 3-5: RIR 2</li><li>Semana 6: descarga</li><li>Semana 7 en adelante: RIR 1-2 (básicos siempre 2)</li></ul>`),
    guide('Calentamiento', `<p>Solo en el primer ejercicio del día: barra vacía × 10 → 50 % × 6 → 70 % × 4 → 85 % × 2. En los demás ejercicios grandes, 1 serie al 60 % × 8. En máquinas pequeñas y aislamientos, ninguna.</p>`),
    guide('Horario del día', scheduleHtml() + '<p class="muted small">Días sin gym: mismo horario; la creatina va con el almuerzo.</p>'),
    guide('Proteína en polvo y creatina', `<ul class="plain"><li><b>Cacito</b>: el medidor que viene en el bote (≈30 g de polvo ≈ 24 g de proteína).</li><li>Al llegar del gym: 1 cacito + 5 g de creatina en 300 ml de agua.</li><li>2º batido solo si a las 18:00 te faltan más de 40 g de proteína.</li><li>Creatina 5 g todos los días, también los de descanso.</li><li>Whey concentrada lleva algo de lactosa: si te sienta mal, isolate o vegetal.</li><li>Los primeros días con creatina puedes subir 1-1,5 kg de agua: fíate de la cintura.</li></ul>`),
    guide('Piso compartido: tu kit', `<ul class="plain"><li>Huevos cocidos en tanda el domingo (aguantan 4-5 días): 1-2 al lado del plato.</li><li>Una lata de atún o sardinas encima del arroz.</li><li>Pechuga de pavo en lonchas o claras de huevo de botella.</li><li>Si la ración de carne es pequeña, menos arroz o patata y suma tu kit.</li></ul>`),
    guide('Cuando te sirvas tú', `<ul class="plain"><li>Arroz: 1 taza (media si hay legumbre).</li><li>Patata frita o plátano macho, no los dos.</li><li>Legumbre con salchicha: 1 salchicha + 1 huevo cocido.</li><li>Pasta con panceta: plato normal + una lata de atún.</li><li>Primero la proteína; si te llenas, que sobre arroz.</li></ul>`),
    guide('Lista de compra (Mercadona)', `<table class="tbl"><tr><td>Proteína</td><td>Huevos, atún al natural, sardinas y caballa en lata, mejillones, claras en botella, pavo en lonchas, pechuga de pollo, garbanzos y lentejas en bote</td></tr><tr><td>Fruta</td><td>Plátanos, mandarinas, manzanas, kiwis</td></tr><tr><td>Desayuno</td><td>Pan de molde integral, avena, leche sin lactosa o bebida de soja</td></tr><tr><td>Picoteo</td><td>Cacahuetes tostados, crema de cacahuete 100 %, tortitas de maíz, chocolate 85 %</td></tr></table>`),
    guide('Máquina del trabajo', `<ul class="plain"><li><b>Mejor:</b> barrita de proteínas o frutos secos.</li><li><b>Si no hay otra:</b> barrita de cereales o bolsa pequeña de patatas.</li><li><b>Evita:</b> bollería, chocolatinas, galletas y refrescos normales.</li><li>Lo ideal: una fruta en la mochila.</li></ul>`),
    guide('Cintura, agua y sueño', `<ul class="plain"><li>Agua: 3 L al día (+0,5 L los días de gym).</li><li>Pasos: 8.000-10.000 al día.</li><li>Sueño: 7-8 h.</li><li>Menos sal y ultraprocesados.</li><li>Lactosa oculta: embutidos, salchichas, pan de molde, salsas y bollería. La leche sin lactosa sí.</li></ul>`),
    guide('Reglas de alcohol', `<table class="tbl"><tr><td>Partido / día normal</td><td>0,0 o nada · máx. 1</td></tr><tr><td>Llega visita</td><td>Máx. 2</td></tr><tr><td>Cumpleaños / evento</td><td>Máx. 3, luego agua o 0,0</td></tr><tr><td>Semana</td><td>Máx. 4 · nunca 2 días seguidos ni justo después de entrenar</td></tr></table>
      <p>Para tener algo en la mano: cerveza 0,0, tónica zero con limón, agua con gas y limón, vermut o vino sin alcohol, refresco zero.</p><p>1 chupito ≈ 1 caña de alcohol; el chupito tiene menos calorías que un tercio, pero se bebe rápido y caen en cadena. Si bebes: mantén la proteína, quita el hidrato de la cena y agua entre copas.</p>`),
  ].join('');
}

function viewAjustes() {
  const pending = Object.keys(S.queue).length;
  return `
  <section class="panel">
    <h3>Imagen de meta</h3>
    ${S.goalImg ? `<img class="goal-thumb" src="${S.goalImg}" alt="">` : '<p class="muted small">Aún no has puesto ninguna.</p>'}
    <div class="btns"><label class="btn ghost">${S.goalImg ? 'Cambiar imagen' : 'Elegir imagen'}<input type="file" accept="image/*" id="goalimg" hidden></label>${S.goalImg ? '<button class="btn ghost" data-act="goal-del">Quitar</button>' : ''}</div>
  </section>

  <section class="panel">
    <h3>Google Sheets</h3>
    <p class="muted small">Todo se guarda en el móvil y se copia a tu hoja. Si cambias de móvil, "Recuperar" lo trae todo.</p>
    <label class="field"><span>URL de la Web App</span><input id="c-url" value="${esc(S.cfg.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" autocorrect="off"></label>
    <label class="field"><span>Clave</span><input id="c-token" type="password" value="${esc(S.cfg.token)}" autocapitalize="off" autocorrect="off"></label>
    <div class="btns">
      <button class="btn" data-act="cfg-save">Guardar y probar</button>
      <button class="btn ghost" data-act="sync-now">Sincronizar (${pending})</button>
      <button class="btn ghost" data-act="restore">Recuperar</button>
      <button class="btn ghost" data-act="push-all">Subir todo</button>
    </div>
    <p id="c-msg" class="muted small">${S.lastSync ? 'Última sincronización: ' + new Date(S.lastSync).toLocaleString('es-ES') : ''}</p>
  </section>

  <section class="panel">
    <h3>Plan</h3>
    <label class="field"><span>Fecha de inicio (semana 1)</span><input id="c-start" type="date" value="${S.start || TODAY()}"></label>
    <div class="btns"><button class="btn ghost" data-act="start-save">Guardar fecha</button></div>
    <p class="muted small">Calorías: ${BASE_KCAL} + la mitad de las activas del Watch. Ajuste actual: ${S.kcalAdjust > 0 ? '+' : ''}${S.kcalAdjust} kcal.</p>
    <div class="btns"><button class="btn ghost" data-act="adjust" data-delta="-50">−50 kcal</button><button class="btn ghost" data-act="adjust" data-delta="50">+50 kcal</button><button class="btn ghost" data-act="adjust-reset">Sin ajuste</button></div>
  </section>

  <section class="panel">
    <h3>Copia de seguridad</h3>
    <div class="btns"><button class="btn ghost" data-act="export">Exportar archivo</button><label class="btn ghost">Importar archivo<input id="imp" type="file" accept="application/json" hidden></label></div>
  </section>

  <h3 class="sec">Guías</h3>
  <section class="guides">${guidesHtml()}</section>

  <p class="credit">Ilustraciones de ejercicios: <a href="https://www.simplyfitness.com/es/pages/workout-exercise-guides" target="_blank" rel="noopener">Simply Fitness</a></p>`;
}

function loadGoalImage(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const k = Math.min(1, 1000 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    S.goalImg = c.toDataURL('image/jpeg', 0.82);
    URL.revokeObjectURL(url);
    save(); render(); toast('Imagen guardada');
  };
  img.src = url;
}

// ---------- Búsqueda de alimentos ----------
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function searchFoods(q) {
  const res = $('#f-res');
  if (!res) return;
  const nq = norm(q.trim());
  if (nq.length < 2) { res.innerHTML = ''; return; }
  const words = nq.split(/\s+/);
  const local = FOODS.filter((f) => words.every((w) => norm(f[0]).includes(w))).slice(0, 8);
  res.innerHTML = local.map((f) => foodResult(f, 'local')).join('') +
    `<button class="offbtn" data-act="off-search" data-q="${esc(q)}">🔎 Buscar "${esc(q)}" en productos de supermercado (Open Food Facts)</button>`;
}
let offCache = [];
function foodResult(f, src, idx) {
  const u = f[5];
  return `<div class="fres" data-src="${src}" data-idx="${src === 'local' ? FOODS.indexOf(f) : idx}">
    <div><b>${esc(f[0])}</b><small>${Math.round(f[1])} kcal · ${fmt(f[2], 1)} P / 100 g</small></div>
    <div class="qty"><input type="number" inputmode="decimal" value="${u[1]}" aria-label="gramos"><i>g</i></div>
    <div class="units">${[1, 2].map((n) => `<button data-act="units" data-g="${u[1] * n}">${n} ${esc(u[0])}</button>`).join('')}</div>
    <button class="btn small" data-act="food-add">Añadir</button>
  </div>`;
}
async function offSearch(q) {
  const res = $('#f-res');
  res.insertAdjacentHTML('beforeend', '<p class="hint" id="off-load">Buscando…</p>');
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&json=1&page_size=12&fields=product_name,brands,nutriments&lc=es&cc=es`;
    const data = await (await fetch(url)).json();
    offCache = (data.products || []).filter((p) => p.product_name && p.nutriments && p.nutriments['energy-kcal_100g'] != null)
      .map((p) => [`${p.product_name}${p.brands ? ' · ' + p.brands.split(',')[0] : ''}`, +p.nutriments['energy-kcal_100g'], +(p.nutriments.proteins_100g || 0), +(p.nutriments.carbohydrates_100g || 0), +(p.nutriments.fat_100g || 0), ['ración', 100]]);
    $('#off-load')?.remove();
    res.insertAdjacentHTML('beforeend', offCache.length ? offCache.map((f, i) => foodResult(f, 'off', i)).join('') : '<p class="hint">Sin resultados.</p>');
  } catch (e) {
    $('#off-load').textContent = 'No se pudo buscar (¿sin conexión?).';
  }
}

// ---------- Eventos ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-tab],[data-act]');
  if (!t) return;
  if (t.dataset.tab) { S.tab = t.dataset.tab; save(); render(); window.scrollTo(0, 0); return; }
  if (t.dataset.act === 'go-day' || t.dataset.act === 'day') {
    selDay = t.dataset.day; openEx = null; S.tab = 'entreno'; save(); render(); window.scrollTo(0, 0); return;
  }
  if (t.dataset.act === 'open-ex') {
    openEx = openEx === t.dataset.key ? '' : t.dataset.key;
    render(); scrollToEx(); return;
  }
  if (t.dataset.act === 'goal-del') { if (confirm('¿Quitar la imagen de meta?')) { delete S.goalImg; save(); render(); } return; }
  const act = t.dataset.act;
  const today = TODAY();

  if (act === 'set') {
    const row = t.closest('.set');
    const { day, slug } = row.dataset;
    const i = +row.dataset.i;
    const dayRow = slotRow(DAY_BY_ID[day], +row.dataset.idx);
    const pr = prescribe(day, dayRow);
    const sets = setsFor(today, day, slug, pr.sets);
    const s = sets[i];
    if (!s.done) {
      const kgIn = row.querySelector('[data-f=kg]');
      const rIn = row.querySelector('[data-f=reps]');
      s.kg = kgIn ? num(kgIn.value) ?? num(kgIn.placeholder) : null;
      s.reps = num(rIn.value) ?? num(rIn.placeholder);
      s.done = true;
      if (!S.start) S.start = today;
      startTimer(dayRow[4], EX[slug].name);
    } else {
      s.done = false;
    }
    queueSet(today, day, slug, i, s);
    save();
    const finished = sets.slice(0, pr.sets).every((x) => x.done);
    const y = window.scrollY;
    if (finished) { openEx = null; render(); scrollToEx(); }
    else { render(); window.scrollTo(0, y); }
    return;
  }
  if (act === 'swap-open') { t.closest('.exbody').querySelector('.swaps').hidden ^= true; return; }
  if (act === 'swap') {
    S.swaps ??= {};
    const [did, idx] = t.dataset.key.split(':');
    if (DAY_BY_ID[did].ex[+idx][0] === t.dataset.slug) delete S.swaps[t.dataset.key];
    else S.swaps[t.dataset.key] = t.dataset.slug;
    save(); const y = window.scrollY; render(); window.scrollTo(0, y); return;
  }
  if (act === 'zoom') { $('#zoomimg').src = t.dataset.img; $('#zoom').hidden = false; return; }
  if (act === 'zoom-close') { $('#zoom').hidden = true; return; }
  if (act === 'timer-stop') { clearInterval(timer?.id); $('#timer').hidden = true; return; }
  if (act === 'timer-add') { const left = Math.round((timer.end - Date.now()) / 1000) + 30; startTimer(left, timer.label); return; }
  if (act === 'reset-day') {
    const day = selDay;
    if (!DAY_BY_ID[day] || !confirm(`¿Borrar las series de hoy de ${DAY_BY_ID[day].short} ${DAY_BY_ID[day].title}?`)) return;
    const ses = S.sessions[today]?.[day];
    if (ses) for (const slug in ses) ses[slug].forEach((s, i) => { if (s.done) queueSet(today, day, slug, i, { ...s, done: false }); });
    if (S.sessions[today]) delete S.sessions[today][day];
    save(); render(); return;
  }
  if (act === 'grip') { const d = dailyOf(); d.grip = !d.grip; queueDaily(today); save(); render(); return; }
  if (act === 'adjust') { S.kcalAdjust += +t.dataset.delta; queueDaily(today); save(); render(); return; }
  if (act === 'adjust-reset') { S.kcalAdjust = 0; save(); render(); return; }
  if (act === 'meal') { curMeal = t.dataset.meal; const y = window.scrollY; render(); window.scrollTo(0, y); return; }
  if (act === 'menu') {
    const meal = mealNow();
    const f = FOOD_BY_NAME[t.dataset.name];
    const [, ug, step = 1] = f[5];
    const list = foodOf();
    const it = list.find((x) => x.meal === meal && x.name === f[0]);
    const g = Math.round(((it?.g || 0) + +t.dataset.d * step * ug) * 10) / 10;
    if (it && g <= 0) { list.splice(list.indexOf(it), 1); queueFood(today, it, true); }
    else if (it) { setGrams(it, g); queueFood(today, it); }
    else if (g > 0) { const n = makeFoodEntry(f, g, meal); list.push(n); queueFood(today, n); }
    save(); const y = window.scrollY; render(); window.scrollTo(0, y); return;
  }
  if (act === 'creatine') { const d = dailyOf(); d.creatine = !d.creatine; queueDaily(today); save(); render(); return; }
  if (act === 'units') { t.closest('.fres').querySelector('input').value = t.dataset.g; return; }
  if (act === 'food-add') {
    const box = t.closest('.fres');
    const f = box.dataset.src === 'local' ? FOODS[+box.dataset.idx] : offCache[+box.dataset.idx];
    const g = num(box.querySelector('input').value);
    if (!g) return;
    const it = makeFoodEntry(f, g, mealNow());
    foodOf().push(it); queueFood(today, it); save(); render(); toast(`${f[0]} · ${it.kcal} kcal`); return;
  }
  if (act === 'manual-add') {
    const kcal = num($('#m-kcal').value);
    if (!kcal) return;
    const it = { id: uid(), meal: mealNow(), name: $('#m-name').value || 'Comida manual', g: 0, kcal: Math.round(kcal), p: num($('#m-p').value) || 0, c: 0, f: 0, drinks: 0 };
    foodOf().push(it); queueFood(today, it); save(); render(); return;
  }
  if (act === 'food-del') {
    const list = foodOf();
    const idx = list.findIndex((x) => x.id === t.dataset.id);
    if (idx < 0) return;
    const [it] = list.splice(idx, 1);
    queueFood(today, it, true); save(); render(); return;
  }
  if (act === 'food-units') {
    const it = foodOf().find((x) => x.id === t.dataset.id);
    if (!it?.per) return;
    const g = Math.max(0, it.g + it.u[1] * +t.dataset.d);
    if (g === 0) { foodOf().splice(foodOf().indexOf(it), 1); queueFood(today, it, true); }
    else { setGrams(it, g); queueFood(today, it); }
    save(); const y = window.scrollY; render(); window.scrollTo(0, y); return;
  }
  if (act === 'off-search') { t.remove(); offSearch(t.dataset.q); return; }
  if (act === 'cfg-save') {
    S.cfg.url = $('#c-url').value.trim(); S.cfg.token = $('#c-token').value.trim(); save();
    const msg = $('#c-msg');
    msg.textContent = 'Probando…';
    try { await api({ action: 'ping' }); msg.textContent = '✔ Conectado con tu hoja.'; msg.className = 'hint ok'; sync(); }
    catch (err) { msg.textContent = '✕ No conecta: revisa la URL y la clave. (' + err.message + ')'; msg.className = 'hint bad'; }
    renderSync(); return;
  }
  if (act === 'sync-now') { await sync(); render(); return; }
  if (act === 'restore') {
    if (!confirm('¿Traer todos los datos de Google Sheets a este móvil? Se combinan con los que ya tienes.')) return;
    const msg = $('#c-msg');
    msg.textContent = 'Recuperando…';
    try { await restore(); render(); toast('Datos recuperados'); } catch (err) { msg.textContent = '✕ ' + err.message; }
    return;
  }
  if (act === 'push-all') {
    for (const date in S.sessions) for (const day in S.sessions[date]) for (const slug in S.sessions[date][day]) S.sessions[date][day][slug].forEach((s, i) => { if (s.done) queueSet(date, day, slug, i, s); });
    for (const date in S.food) for (const it of S.food[date]) queueFood(date, it);
    for (const date in S.daily) queueDaily(date);
    render(); return;
  }
  if (act === 'start-save') { S.start = $('#c-start').value || null; save(); render(); return; }
  if (act === 'export') {
    const blob = new Blob([JSON.stringify({ ...S, cfg: { url: S.cfg.url, token: '' } }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `gym-vancho-${today}.json`; a.click();
    return;
  }
});

// Inputs: guardar sin re-renderizar (no se pierde el foco)
document.addEventListener('change', (e) => {
  const el = e.target;
  const today = TODAY();
  if (el.dataset.f) {
    const row = el.closest('.set');
    const { day, slug } = row.dataset;
    const i = +row.dataset.i;
    const s = setsFor(today, day, slug, i + 1)[i];
    s[el.dataset.f] = num(el.value);
    if (s.done) queueSet(today, day, slug, i, s);
    save();
  } else if (el.dataset.foodG) {
    const it = foodOf().find((x) => x.id === el.dataset.foodG);
    const g = num(el.value);
    if (!it?.per || g == null) return;
    setGrams(it, g); queueFood(today, it); save();
    const y = window.scrollY; render(); window.scrollTo(0, y);
  } else if (el.dataset.daily) {
    dailyOf()[el.dataset.daily] = num(el.value);
    queueDaily(today); save(); render();
  } else if (el.id === 'goalimg' && el.files[0]) {
    loadGoalImage(el.files[0]);
  } else if (el.id === 'imp' && el.files[0]) {
    el.files[0].text().then((txt) => {
      try {
        const data = JSON.parse(txt);
        if (data.v !== 1) throw new Error('Archivo no válido');
        const cfg = S.cfg;
        S = { ...data, cfg, queue: {} };
        save(); render(); toast('Copia importada');
      } catch (err) { alert('No se pudo importar: ' + err.message); }
    });
  }
});
let searchT = null;
document.addEventListener('input', (e) => {
  if (e.target.id === 'f-q') { clearTimeout(searchT); searchT = setTimeout(() => searchFoods(e.target.value), 150); }
});

function scrollToEx() {
  const el = document.querySelector('.ex.open');
  if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 64);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 1800);
}

window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); if (S._day !== TODAY()) { S._day = TODAY(); render(); } } });
S._day = TODAY();
S.tab = 'hoy'; // la app siempre se abre en Hoy
render();
sync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
