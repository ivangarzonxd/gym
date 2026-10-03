// Plan Retorno — app de entrenamiento, progresión y nutrición.
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
  if (week <= 2) return { rir: '3', label: 'Readaptación', tip: 'Te sobran 3 reps en cada serie. Tendones y articulaciones primero.' };
  if (week <= 5) return { rir: '2', label: 'Construcción', tip: 'Te sobran 2 reps. Aquí empieza la progresión de verdad.' };
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
  const sets = ph.deload ? Math.max(1, nSets - 1) : nSets;
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
function warmups(ex, kg) {
  if (!kg || kg <= 0) return [];
  const step = ROUND[ex.inc] || 2.5;
  if (ex.main) {
    const out = [];
    if (ex.inc === 'bar') out.push({ kg: 20, reps: 10, label: 'Barra vacía' });
    for (const [pct, reps] of [[0.5, 6], [0.7, 4], [0.85, 2]]) {
      const w = roundTo(kg * pct, step);
      if (w > (out.length ? out[out.length - 1].kg : 0) && w < kg) out.push({ kg: w, reps, label: `${pct * 100} %` });
    }
    return out;
  }
  if (ex.warm) {
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
function nextDay() {
  const tr = trainedDays().filter((t) => t.day !== 'd5');
  const order = ['d1', 'd2', 'd3', 'd4'];
  if (!tr.length) return { day: 'd1' };
  const last = tr[tr.length - 1];
  const all = trainedDays();
  const today = TODAY();
  const doneToday = all.filter((t) => t.date === today);
  const y1 = all.some((t) => t.date === addDays(today, -1));
  const y2 = all.some((t) => t.date === addDays(today, -2));
  return { day: order[(order.indexOf(last.day) + 1) % 4], doneToday, rest: !doneToday.length && y1 && y2 };
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
  if (!S.cfg.url) { el.className = 'sync off'; el.textContent = 'Sheets: sin configurar'; return; }
  if (syncing) { el.className = 'sync busy'; el.textContent = 'Sincronizando…'; return; }
  if (pending) { el.className = 'sync warn'; el.textContent = `${pending} pendiente${pending > 1 ? 's' : ''}${navigator.onLine ? '' : ' · sin conexión'}`; return; }
  el.className = 'sync ok'; el.textContent = 'Sheets al día';
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
const TABS = [
  { id: 'hoy', label: 'Hoy' },
  ...DAYS.map((d) => ({ id: d.id, label: `${d.short} ${d.title}` })),
  { id: 'comida', label: 'Comida' },
  { id: 'metodo', label: 'Método' },
  { id: 'ajustes', label: 'Ajustes' },
];

function render() {
  const tab = S.tab;
  $('#tabs').innerHTML = TABS.map((t) => `<button class="tab ${t.id === tab ? 'on' : ''} ${t.id === 'd5' ? 'opt' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('');
  $('#reset').hidden = !DAY_BY_ID[tab];
  const ph = phase();
  $('#week').textContent = `Semana ${planWeek()} · ${ph.label} · RIR ${ph.rir}`;
  const main = $('#main');
  if (tab === 'hoy') main.innerHTML = viewHoy();
  else if (DAY_BY_ID[tab]) main.innerHTML = viewDay(DAY_BY_ID[tab]);
  else if (tab === 'comida') main.innerHTML = viewComida();
  else if (tab === 'metodo') main.innerHTML = viewMetodo();
  else main.innerHTML = viewAjustes();
  renderSync();
  const on = $('#tabs .on');
  on?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

function bar(value, max, cls = '') {
  const pct = Math.min(100, (value / max) * 100 || 0);
  return `<div class="meter ${cls}"><div style="width:${pct}%"></div></div>`;
}

function viewHoy() {
  const today = TODAY();
  const nd = nextDay();
  const d = DAY_BY_ID[nd.day];
  const ph = phase();
  const kt = kcalTarget();
  const ft = foodTotals();
  const dl = dailyOf();
  const wt = weightTrend();
  const drinks = weekDrinks();
  const gripWeek = (() => { let n = 0; const dow = (parseD(today).getDay() + 6) % 7; for (let i = 0; i <= dow; i++) if (S.daily[addDays(today, -i)]?.grip) n++; return n; })();
  const recent = trainedDays().reverse().slice(0, 6);

  let next;
  if (nd.doneToday?.length) next = `<div class="hero done"><small>Hoy</small><h2>✔ Entrenado: ${nd.doneToday.map((t) => DAY_BY_ID[t.day].short + ' ' + DAY_BY_ID[t.day].title).join(' + ')}</h2><p>Próximo: <b>${d.short} · ${d.title}</b>. Ahora toca comer bien y descansar.</p></div>`;
  else if (nd.rest) next = `<div class="hero rest"><small>Recomendación</small><h2>Hoy descansa 😴</h2><p>Llevas 2 días seguidos. Caminata de 30-45 min y estiramientos. Próximo: <b>${d.short} · ${d.title}</b>.</p><button class="btn ghost" data-tab="${d.id}">Entrenar igualmente</button></div>`;
  else next = `<div class="hero"><small>Te toca</small><h2>${d.short} · ${d.title}</h2><p>${esc(d.sub)}</p><button class="btn" data-tab="${d.id}">Empezar entrenamiento →</button></div>`;

  return `
  ${next}
  ${(() => { const [h, what, det] = nextScheduleItem(); return `<div class="card nowcard"><time>${h}</time><div><b>${esc(what)}</b><p>${esc(det)}</p></div></div>`; })()}
  <div class="card creat ${dl.creatine ? 'done' : ''}"><div><b>💊 Creatina 5 g</b><p class="hint">Todos los días. Con el batido post-gym o con el almuerzo.</p></div><button class="btn small ${dl.creatine ? 'on' : 'ghost'}" data-act="creatine">${dl.creatine ? '✔ Tomada' : 'Marcar'}</button></div>
  <div class="card phase"><b>${ph.label} · RIR ${ph.rir}</b><p>${ph.tip}</p></div>

  <div class="card">
    <div class="row"><h3>🔥 Calorías de hoy</h3><button class="link" data-tab="comida">Registrar comida →</button></div>
    <div class="big">${fmt(ft.kcal, 0)} <small>/ ${fmt(kt.target, 0)} kcal</small></div>
    ${bar(ft.kcal, kt.target, ft.kcal > kt.target ? 'over' : '')}
    <div class="macros">
      <span>Proteína <b>${fmt(ft.p, 0)}/${PROTEIN_G} g</b></span>
      <span>Hidratos <b>${fmt(ft.c, 0)} g</b></span>
      <span>Grasa <b>${fmt(ft.f, 0)}/${FAT_G} g</b></span>
    </div>
    ${bar(ft.p, PROTEIN_G, 'prot')}
    <label class="field">
      <span>⌚ Calorías activas del Watch <em>(app Fitness → anillo rojo "Moverse")</em></span>
      <input type="number" inputmode="numeric" data-daily="active" value="${dl.active ?? ''}" placeholder="ej. 650">
    </label>
    <p class="hint">${kt.provisional ? 'Objetivo provisional (cuento 500 kcal activas). Mételas por la noche o cuando quieras: se recalcula.' : `Objetivo = ${BASE_KCAL}${S.kcalAdjust ? (S.kcalAdjust > 0 ? ' + ' : ' − ') + Math.abs(S.kcalAdjust) : ''} + mitad de ${kt.active} activas.`}</p>
  </div>

  <div class="card">
    <h3>⚖️ Peso y cintura <small>(1 vez por semana, en ayunas)</small></h3>
    <div class="grid2">
      <label class="field"><span>Peso (kg)</span><input type="number" inputmode="decimal" step="0.1" data-daily="weight" value="${dl.weight ?? ''}" placeholder="80,0"></label>
      <label class="field"><span>Cintura en el ombligo (cm)</span><input type="number" inputmode="decimal" step="0.5" data-daily="waist" value="${dl.waist ?? ''}" placeholder="—"></label>
    </div>
    ${spark(wt.pts)}
    ${wt.action ? `<div class="alert">${wt.action.text}<button class="btn small" data-act="adjust" data-delta="${wt.action.delta}">Aplicar ${wt.action.delta > 0 ? '+' : ''}${wt.action.delta} kcal</button></div>` : wt.msg ? `<p class="hint ok">${wt.msg}</p>` : `<p class="hint">Con 2 semanas de pesajes la app te dirá si ajustar calorías.</p>`}
  </div>

  <div class="grid2">
    <div class="card mini ${drinks > 4 ? 'bad' : ''}">
      <h4>🍺 Alcohol semana</h4>
      <div class="big">${fmt(drinks, 1)} <small>/ 4</small></div>
      <p class="hint">Se cuenta solo al registrar bebidas en Comida.</p>
    </div>
    <div class="card mini">
      <h4>✊ Hand grip en casa</h4>
      <div class="big">${gripWeek} <small>/ 3 días</small></div>
      <button class="btn small ${dl.grip ? 'on' : 'ghost'}" data-act="grip">${dl.grip ? '✔ Hecho hoy' : 'Marcar hoy'}</button>
      <p class="hint">4 series al fallo. Mejor en días de pierna o descanso.</p>
    </div>
  </div>

  <div class="card">
    <h3>📅 Últimos entrenamientos</h3>
    ${recent.length ? `<ul class="list">${recent.map((t) => `<li><span>${parseD(t.date).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' })}</span><b>${DAY_BY_ID[t.day].short} ${DAY_BY_ID[t.day].title}</b><em>${dayDone(t.date, t.day)} series</em></li>`).join('')}</ul>` : '<p class="hint">Aún no hay entrenamientos. ¡Hoy empieza todo!</p>'}
  </div>`;
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

function viewDay(day) {
  const today = TODAY();
  const done = dayDone(today, day.id);
  const total = day.ex.reduce((a, r) => a + prescribe(day.id, r).sets, 0);
  const week = planWeek();
  const cardio = CARDIO[day.cardio].find((c) => week >= c.weeks[0] && week <= c.weeks[1]);
  return `
  <div class="dayhead">
    <div><h2>${day.short} · ${day.title}${day.optional ? ' <span class="chip opt">Opcional</span>' : ''}</h2><p>${esc(day.sub)}</p></div>
    <div class="ring" style="--p:${(done / total) * 100}"><span>${done}/${total}</span></div>
  </div>
  <div class="card warmup"><b>🔥 Calentamiento (8 min)</b><p>5 min cinta a paso rápido + 10 rotaciones de hombro, 10 sentadillas sin peso, 10 aperturas con banda o brazos. El primer ejercicio incluye sus series de aproximación.</p></div>
  ${day.ex.map((r, idx) => exCard(day, r, idx)).join('')}
  <div class="card cardio">
    <h3>🏃 ${esc(cardio.title)}</h3>
    <ul>${cardio.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <p class="hint">⌚ En el Watch: Entreno → Correr en interior (o Caminar en interior). Zona 2 ≈ 110-135 ppm: puedes hablar en frases.</p>
  </div>
  <div class="card"><b>🧘 Vuelta a la calma (5 min)</b><p class="hint">Estira pecho, dorsal, cuádriceps y femoral 30 s cada uno. Bebe agua.</p></div>`;
}

function exCard(day, row, idx) {
  const [slug, , rmin, rmax, rest, tags] = row;
  const ex = EX[slug];
  const pr = prescribe(day.id, row);
  const today = TODAY();
  const sets = setsFor(today, day.id, slug, pr.sets);
  const hist = history(slug);
  const unit = ex.inc === 'time' ? 's' : 'reps';
  const nDone = sets.slice(0, pr.sets).filter((s) => s.done).length;
  const complete = nDone >= pr.sets;
  const wu = warmups(ex, pr.kg);
  const tagCls = (t) => (t === 'Fuerza' ? 'fuerza' : t === 'Viga' ? 'viga' : t.startsWith('Extra') || t === 'Dcho primero' ? 'asim' : t === 'Antebrazo' ? 'ante' : t === 'Core' ? 'core' : '');
  const lastTxt = hist.length ? `${hist[0].sets.map((s) => (s.kg != null ? fmt(s.kg) + '×' : '') + s.reps).join(' · ')} <em>(${parseD(hist[0].date).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })})</em>` : 'Primera vez';

  const rows = [];
  for (let i = 0; i < pr.sets; i++) {
    const s = sets[i];
    const hint = inSessionHint(ex, row, sets, i);
    const kgPh = hint?.kg ?? pr.kg;
    rows.push(`
    <div class="set ${s.done ? 'done' : ''}" data-day="${day.id}" data-slug="${slug}" data-i="${i}">
      <span class="sn">S${i + 1}</span>
      ${ex.inc === 'time' ? '<span class="kg na">—</span>' : `<label class="kg"><input type="number" inputmode="decimal" step="0.5" data-f="kg" value="${s.kg ?? ''}" placeholder="${kgPh ?? 'kg'}"><i>kg</i></label>`}
      <label class="rp"><input type="number" inputmode="numeric" data-f="reps" value="${s.reps ?? ''}" placeholder="${pr.reps[i] ?? rmax}"><i>${unit}</i></label>
      <button class="chk" data-act="set" aria-label="Serie hecha">${s.done ? '✔' : ''}</button>
      ${hint && !s.done ? `<div class="sethint">${hint.text}</div>` : ''}
    </div>`);
  }

  return `
  <article class="card ex ${complete ? 'complete' : ''}">
    <button class="exhead" data-act="toggle-ex">
      <span class="num">${idx + 1}</span>
      <span class="exname"><b>${esc(ex.name)}</b><small>${pr.sets} × ${rmin}-${rmax} ${unit} · RIR ${phase().rir} · descanso ${fmtTime(rest)}</small></span>
      <span class="exstate">${nDone}/${pr.sets}</span>
    </button>
    <div class="exbody">
      <div class="tags">${tags.map((t) => `<span class="chip ${tagCls(t)}">${esc(t)}</span>`).join('')}</div>
      <button class="imgwrap" data-act="zoom" data-img="${IMG + ex.img}" aria-label="Ampliar imagen"><img loading="lazy" src="${IMG + ex.img}" alt="${esc(ex.name)}" onerror="this.parentNode.classList.add('noimg')"><span>Ver en grande</span></button>
      <div class="prog ${pr.status}">
        <div><small>Última vez</small><p>${lastTxt}</p></div>
        <div><small>Hoy</small><p>${pr.kg != null ? `<b>${fmt(pr.kg)} kg</b> × ` : ''}${pr.reps.join(' · ')} ${unit}</p></div>
        <p class="msg">${esc(pr.msg)}</p>
      </div>
      ${wu.length ? `<div class="wu"><small>Aproximación (no se apuntan)</small><div>${wu.map((w) => `<span>${fmt(w.kg)} kg × ${w.reps}</span>`).join('')}</div></div>` : ''}
      ${ex.rightFirst ? '<div class="asimnote">👉 Brazo DERECHO primero. El izquierdo iguala las reps del derecho, nunca más.</div>' : ''}
      ${ex.extraRight ? '<div class="asimnote">👉 Solo lado DERECHO: serie extra para igualar el pectoral.</div>' : ''}
      <div class="sets">${rows.join('')}</div>
      <p class="note">${esc(ex.note)}</p>
      <a class="guide" href="${GUIDE + slug}" target="_blank" rel="noopener">Ver guía completa en Simply Fitness ↗</a>
    </div>
  </article>`;
}

let curMeal = null; // pestaña de comida elegida (si no, la que toca por la hora)
const mealNow = () => curMeal || mealByHour();

function foodItemsHtml(items) {
  return `<ul class="food">${items.map((x) => {
    const units = x.u && x.g ? x.g / x.u[1] : 0;
    const ulabel = units ? ` <em>≈ ${fmt(units, 1)} ${esc(x.u[0])}</em>` : '';
    return `<li>
      <span>${esc(x.name)}${ulabel}</span>
      ${x.per ? `<label class="fg"><input type="number" inputmode="decimal" data-food-g="${x.id}" value="${x.g}"><i>g</i></label>` : '<span></span>'}
      <span>${x.kcal} kcal · ${fmt(x.p, 0)} P</span>
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
  const inMeal = list.filter((x) => x.meal === meal);
  const others = inMeal.filter((x) => !MENU[meal].some(([, names]) => names.includes(x.name)));
  const summary = MEALS.map((m) => {
    const items = list.filter((x) => x.meal === m);
    if (!items.length) return '';
    return `<li><b>${MEAL_NAME[m]}</b> <em>${kcalOf(m)} kcal</em><p>${items.map((x) => x.name + (x.u && x.g ? ` ×${fmt(x.g / x.u[1], 1)}` : '')).join(' · ')}</p></li>`;
  }).join('');

  return `
  <div class="card">
    <div class="big">${fmt(ft.kcal, 0)} <small>/ ${fmt(kt.target, 0)} kcal</small></div>
    ${bar(ft.kcal, kt.target, ft.kcal > kt.target ? 'over' : '')}
    <p class="hint">${left >= 0 ? `Te quedan <b>${fmt(left, 0)} kcal</b>` : `Te has pasado <b>${fmt(-left, 0)} kcal</b>: mañana sin cambios, un día no arruina nada.`}${kt.provisional ? ' · objetivo provisional hasta meter las calorías del Watch' : ''}</p>
    <div class="macros"><span>Proteína <b>${fmt(ft.p, 0)}/${PROTEIN_G} g</b></span><span>Hidratos <b>${fmt(ft.c, 0)} g</b></span><span>Grasa <b>${fmt(ft.f, 0)}/${FAT_G} g</b></span></div>
    ${bar(ft.p, PROTEIN_G, 'prot')}
    <p class="hint ${pLeft <= 0 ? 'ok' : ''}">${pLeft > 0 ? `Te faltan <b>${fmt(pLeft, 0)} g de proteína</b>${pLeft > 40 ? ' → 2º batido o tu kit (huevo cocido, lata de atún).' : '.'}` : '✔ Proteína del día cubierta.'}</p>
  </div>

  <div class="mealtabs">${MEALS.map((m) => `<button class="mtab ${m === meal ? 'on' : ''}" data-act="meal" data-meal="${m}">${MEAL_NAME[m]}<small>${kcalOf(m) ? kcalOf(m) + ' kcal' : '—'}</small></button>`).join('')}</div>

  <div class="card">
    <div class="row"><h3>${MEAL_NAME[meal]}</h3><b>${kcalOf(meal)} kcal</b></div>
    <p class="hint">Toca <b>+</b> por cada unidad que comiste: 2 huevos = + +. Las cantidades son de comida ya hecha.</p>
    ${MENU[meal].map(([h, names]) => `<h4>${esc(h)}</h4><div class="menu">${names.map((n) => menuRow(n, meal, list)).join('')}</div>`).join('')}
    ${others.length ? `<h4>Otros que añadiste</h4>${foodItemsHtml(others)}` : ''}
  </div>

  <div class="card">
    <h3>🔎 ¿No está en el menú?</h3>
    <label class="field"><span>Buscar (se añade a ${MEAL_NAME[meal].toLowerCase()})</span><input id="f-q" type="search" placeholder="sardinas, pera, cerveza…" autocomplete="off"></label>
    <div id="f-res" class="results"></div>
    <details class="manual"><summary>Comida fuera de casa / a ojo (kcal manual)</summary>
      <div class="grid2">
        <label class="field"><span>Qué era</span><input id="m-name" placeholder="Menú del día"></label>
        <label class="field"><span>kcal aprox.</span><input id="m-kcal" type="number" inputmode="numeric" placeholder="800"></label>
        <label class="field"><span>Proteína (g, opcional)</span><input id="m-p" type="number" inputmode="numeric" placeholder="40"></label>
        <button class="btn" data-act="manual-add">Añadir</button>
      </div>
      <p class="hint">Referencias: menú del día 900-1.200 · hamburguesa con patatas 1.100 · pizza mediana 1.000-1.300 · bocadillo de jamón 450 · kebab 800.</p>
    </details>
  </div>

  ${summary ? `<div class="card"><h3>📋 Resumen de hoy</h3><ul class="daysum">${summary}</ul></div>` : ''}

  ${nutritionGuide()}`;
}

function nutritionGuide() {
  return `
  <h2 class="sec">🕐 Tu día tipo</h2>
  <div class="card">
    <ul class="sched">${SCHEDULE.map(([h, t, d]) => `<li><time>${h}</time><div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join('')}</ul>
    <p class="hint">Días sin gym: mismo horario, y la creatina (con o sin batido) va con el almuerzo.</p>
  </div>

  <div class="card">
    <h3>🥤 Proteína en polvo y creatina</h3>
    <ul class="tips">
      <li><b>Cacito</b> = el medidor de plástico que viene dentro del bote. Suele ser ≈30 g de polvo ≈ 24 g de proteína (mira la etiqueta de tu bote).</li>
      <li><b>Al llegar del gym:</b> 1 cacito + 5 g de creatina, todo junto en 300 ml de agua. Agitas y listo.</li>
      <li><b>2º batido solo si hace falta:</b> si a las 18:00 la app dice que te faltan más de 40 g de proteína. Si el almuerzo fue fuerte, no.</li>
      <li><b>Creatina 5 g todos los días</b>, también los de descanso. Sin fase de carga. Lo que importa es no saltártela, no la hora.</li>
      <li>Si tu proteína es <b>whey concentrada</b> lleva algo de lactosa. Si te da gases, cámbiala por <b>whey isolate</b> o vegetal.</li>
      <li>Con creatina, 3 L de agua al día. Los primeros días puedes subir 1-1,5 kg: es agua dentro del músculo, no grasa. Fíate de la cintura.</li>
    </ul>
  </div>

  <div class="card">
    <h3>🏠 Piso compartido: tu kit de proteína</h3>
    <p class="hint">Comes lo que toque y completas con cosas tuyas, sin cocinar aparte ni quitarle nada a nadie.</p>
    <ul class="tips">
      <li><b>Huevos cocidos en tanda:</b> el domingo cueces 6-8 y aguantan 4-5 días en la nevera. 1-2 al lado del plato = +12-25 g de proteína.</li>
      <li><b>Una lata de atún o sardinas</b> encima del arroz: +15-25 g en 10 segundos.</li>
      <li><b>Pechuga de pavo en lonchas</b> o <b>claras de huevo de botella</b> (en tortilla rápida).</li>
      <li>¿Ración pequeña de carne? Sírvete <b>menos arroz o patata</b> y suma tu kit. La proteína es lo que manda.</li>
      <li>Si un día no llegas, para eso está el 2º batido. Sin dramas.</li>
    </ul>
  </div>

  <div class="card">
    <h3>🛒 Lista de compra (Mercadona, económico)</h3>
    <table class="rules">
      <tr><td>Proteína</td><td>Huevos (docena) · atún al natural (pack de latas) · sardinas y caballa en lata · mejillones en escabeche · claras de huevo en botella · pechuga de pavo en lonchas · pechuga de pollo en bandeja · garbanzos y lentejas cocidos en bote</td></tr>
      <tr><td>Fruta</td><td>Plátanos · mandarinas · manzanas · kiwis (la más barata de temporada)</td></tr>
      <tr><td>Desayuno</td><td>Pan de molde integral · copos de avena · leche sin lactosa o bebida de soja (tiene proteína)</td></tr>
      <tr><td>Picoteo bueno</td><td>Cacahuetes tostados · crema de cacahuete 100 % · tortitas de maíz · chocolate negro 85 %</td></tr>
    </table>
    <p class="hint">Lo que más te va a ayudar: huevos, latas de atún/sardinas y plátanos. Baratos, duran y no hay que cocinar.</p>
  </div>

  <div class="card">
    <h3>🍽️ Cuando te sirvas tú</h3>
    <ul class="tips">
      <li><b>Arroz: 1 taza</b> (un puño cerrado y poco más). Si hay legumbre, media taza basta.</li>
      <li><b>Patata frita O plátano macho, no los dos.</b></li>
      <li><b>Garbanzos/lentejas con salchicha:</b> coge 1 salchicha y añade un huevo cocido de tu kit.</li>
      <li><b>Pasta con panceta:</b> plato normal (no doble) + una lata de atún.</li>
      <li><b>Ensalada o tomate</b> cuando haya: llena sin sumar casi nada.</li>
      <li>Primero la proteína, luego el resto. Si te llenas, que sobre arroz, no carne.</li>
    </ul>
  </div>

  <div class="card">
    <h3>🏪 La máquina del trabajo</h3>
    <table class="rules">
      <tr><td>✅ Mejor</td><td><b>Barrita de proteínas</b> · <b>frutos secos o cacahuetes</b></td></tr>
      <tr><td>🟡 Si no hay otra</td><td>Barrita de cereales · bolsa pequeña de patatas</td></tr>
      <tr><td>❌ Evita</td><td>Bollería, chocolatinas, galletas y refrescos normales: 220-300 kcal de azúcar sin proteína, y a la hora tienes más hambre</td></tr>
    </table>
    <p class="hint">Lo ideal es no necesitarla: un plátano o una mandarina en la mochila. Ojo: muchas chocolatinas y barritas llevan leche (lactosa).</p>
  </div>

  <div class="card">
    <h3>📏 Cómo medir sin volverte loco</h3>
    <ul class="tips">
      <li>Todo está en <b>unidades de casa</b>: huevos, rebanadas, tazas, cazos, latas, muslos. No hace falta báscula.</li>
      <li>Taza de arroz = una taza de desayuno normal llena. Cazo = el cucharón de servir.</li>
      <li>Mejor aproximado que no apuntar: con que se parezca, la báscula semanal dirá si vamos bien.</li>
    </ul>
  </div>

  <div class="card">
    <h3>🎯 Cintura e hidratación</h3>
    <ul class="tips">
      <li><b>Agua:</b> 3 L al día (+0,5 L los días de gym). Un vaso grande al levantarte.</li>
      <li><b>Pasos:</b> 8.000-10.000 al día con el Watch. Es lo que más grasa abdominal quema fuera del gym.</li>
      <li><b>Sueño:</b> 7-8 h. Dormir poco sube el cortisol y la grasa se acumula en la barriga.</li>
      <li><b>Sal y ultraprocesados:</b> reducirlos deshincha la cintura en días.</li>
      <li><b>Lactosa oculta:</b> embutidos, salchichas, pan de molde, salsas y bollería. Lee las etiquetas. La leche "sin lactosa" sí puedes tomarla.</li>
    </ul>
  </div>

  <div class="card">
    <h3>🍺 Tus reglas de alcohol</h3>
    <p class="hint">1 consumición = 1 caña = 1 copa de vino = 1 chupito (llevan casi el mismo alcohol).</p>
    <table class="rules">
      <tr><td>Partido / día normal</td><td><b>0,0 o nada</b> · máx. 1</td></tr>
      <tr><td>Llega visita</td><td><b>Máx. 2</b></td></tr>
      <tr><td>Cumpleaños / evento</td><td><b>Máx. 3</b>, luego agua o 0,0</td></tr>
      <tr><td>Límite semanal</td><td><b>4</b> · nunca 2 días seguidos ni justo después de entrenar</td></tr>
    </table>
    <h4>Para tener algo en la mano</h4>
    <p>Cerveza 0,0 / tostada 0,0 (≈20 kcal) · tónica zero con limón en vaso de tubo (parece un gin-tonic) · agua con gas, limón y hielo · vermut o vino sin alcohol · kombucha · refresco zero.</p>
    <h4>¿Chupito de aguardiente o cerveza?</h4>
    <p>En alcohol, 1 chupito ≈ 1 caña. En calorías el chupito (≈100) gana al tercio (≈140) o a la pinta (≈220), pero se bebe en 2 segundos y caen en cadena. Lo mejor: destilado con refresco zero, bebido despacio.</p>
    <h4>Si bebes</h4>
    <p>Mantén la proteína, quita el hidrato de la cena, un vaso de agua entre copa y copa, y nada de picoteo. Evita cremas tipo Baileys: llevan lactosa.</p>
  </div>`;
}

function viewMetodo() {
  const lifts = ['barbell-bench-press', 'squat', 'barbell-row', 'barbell-deadlift', 'dumbbell-shoulder-press'];
  const e1rm = (kg, r) => kg * (1 + r / 30);
  const rowsL = lifts.map((slug) => {
    const h = history(slug, '9999-12-31');
    if (!h.length) return `<tr><td>${esc(EX[slug].name)}</td><td colspan="3" class="muted">Sin datos</td></tr>`;
    const best = (s) => Math.max(...s.sets.map((x) => e1rm(x.kg ?? 0, x.reps)));
    const first = h[h.length - 1], last = h[0];
    const b0 = best(first), b1 = best(last);
    return `<tr><td>${esc(EX[slug].name)}</td><td>${fmt(b0, 0)}</td><td>${fmt(b1, 0)}</td><td class="${b1 >= b0 ? 'up' : 'down'}">${b1 >= b0 ? '+' : ''}${fmt(((b1 - b0) / b0) * 100 || 0, 0)} %</td></tr>`;
  }).join('');
  return `
  <div class="card">
    <h3>📈 Tu fuerza (1RM estimado, kg)</h3>
    <table class="rules"><tr><th>Ejercicio</th><th>Inicio</th><th>Ahora</th><th></th></tr>${rowsL}</table>
    <p class="hint">Estimado con la mejor serie de cada sesión (fórmula de Epley). Así ves que ganas aunque cambien las reps.</p>
  </div>

  <div class="card">
    <h3>🧠 Cómo progresas: doble progresión</h3>
    <ol class="tips">
      <li>Cada ejercicio tiene un rango, ej. <b>3 × 8-10</b>.</li>
      <li>Todas las series con <b>el mismo peso</b> (series rectas). El peso más alto ya es la primera serie efectiva, porque antes haces la aproximación.</li>
      <li>Es normal que las reps bajen un poco serie a serie: 10 · 9 · 8. No bajes el peso por eso.</li>
      <li>Cada sesión intenta <b>+1 rep</b> en alguna serie con el mismo peso.</li>
      <li>Cuando hagas <b>todas las series al máximo del rango</b> → la app sube peso (+2,5 kg barra/máquina, +2 kg mancuerna) y vuelves al mínimo de reps.</li>
      <li>Si en una serie te sobran 2+ reps, la app te dice que subas en la siguiente. Si te quedas 2 reps corto, que bajes.</li>
      <li>Dos sesiones seguidas sin llegar al mínimo → −10 % y reconstruyes.</li>
      <li>Cada 6 semanas, <b>descarga</b>: −10 % y una serie menos. Así encadenas meses subiendo sin estancarte ni lesionarte.</li>
    </ol>
  </div>

  <div class="card">
    <h3>🏋️ Calentamiento de los básicos</h3>
    <p>En el primer ejercicio de cada día la app calcula tus series de aproximación: barra vacía × 10 → 50 % × 6 → 70 % × 4 → 85 % × 2 → series de trabajo. En los segundos ejercicios, 1 serie al 60 % × 8.</p>
  </div>

  <div class="card">
    <h3>🎯 RIR (reps en reserva)</h3>
    <p>Las reps que te quedan en el depósito al acabar. RIR 2 = podrías hacer 2 más con buena técnica, pero paras.</p>
    <ul class="tips"><li>Semanas 1-2: RIR 3 (readaptación)</li><li>Semanas 3-5: RIR 2</li><li>Semana 6: descarga</li><li>Semana 7+: RIR 1-2 (básicos siempre 2)</li></ul>
  </div>

  <div class="card">
    <h3>📆 Organización</h3>
    <ul class="tips">
      <li>Haz D1 → D2 → D3 → D4 en orden, el día que puedas. La pestaña <b>Hoy</b> te dice cuál toca.</li>
      <li>Máximo 2 días seguidos y luego 1 de descanso (caminata).</li>
      <li><b>D5 opcional</b> cuando vayas con compañía (fin de semana). Mejor no justo antes de un día de torso.</li>
      <li>Sesión: 8 min de calentamiento, 60-70 min de pesas, 20-30 min de cinta, 5 min de estiramientos.</li>
      <li><b>Clases grupales:</b> opcionales en días de descanso (ciclo indoor, baile, movilidad). Nunca en lugar de las pesas, y sin pierna intensa el día antes de D2/D4.</li>
    </ul>
  </div>`;
}

function viewAjustes() {
  const pending = Object.keys(S.queue).length;
  return `
  <div class="card">
    <h3>☁️ Google Sheets</h3>
    <p class="hint">Todo lo que apuntas se guarda en tu móvil y se copia a tu hoja de Google. Si cambias de móvil, "Recuperar" lo trae todo.</p>
    <label class="field"><span>URL de la Web App (Apps Script)</span><input id="c-url" value="${esc(S.cfg.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" autocorrect="off"></label>
    <label class="field"><span>Clave secreta</span><input id="c-token" type="password" value="${esc(S.cfg.token)}" placeholder="La que pusiste en el script" autocapitalize="off" autocorrect="off"></label>
    <div class="btns">
      <button class="btn" data-act="cfg-save">Guardar y probar</button>
      <button class="btn ghost" data-act="sync-now">Sincronizar (${pending})</button>
      <button class="btn ghost" data-act="restore">Recuperar desde Sheets</button>
      <button class="btn ghost" data-act="push-all">Subir todo de nuevo</button>
    </div>
    <p id="c-msg" class="hint">${S.lastSync ? 'Última sincronización: ' + new Date(S.lastSync).toLocaleString('es-ES') : ''}</p>
  </div>

  <div class="card">
    <h3>📅 Inicio del plan</h3>
    <label class="field"><span>Fecha de la semana 1</span><input id="c-start" type="date" value="${S.start || TODAY()}"></label>
    <button class="btn ghost" data-act="start-save">Guardar fecha</button>
    <p class="hint">Se fija sola el primer día que marques una serie. Controla RIR y semanas de descarga.</p>
  </div>

  <div class="card">
    <h3>🔥 Calorías</h3>
    <p>Base ${BASE_KCAL} kcal + mitad de las calorías activas del Watch. Ajuste actual: <b>${S.kcalAdjust > 0 ? '+' : ''}${S.kcalAdjust} kcal</b>.</p>
    <div class="btns"><button class="btn ghost" data-act="adjust" data-delta="-50">−50</button><button class="btn ghost" data-act="adjust" data-delta="50">+50</button><button class="btn ghost" data-act="adjust-reset">Reiniciar ajuste</button></div>
  </div>

  <div class="card">
    <h3>💾 Copia local</h3>
    <div class="btns"><button class="btn ghost" data-act="export">Exportar archivo</button><label class="btn ghost">Importar archivo<input id="imp" type="file" accept="application/json" hidden></label></div>
  </div>

  <p class="credit">Ilustraciones y guías de ejercicios: <a href="https://www.simplyfitness.com/es/pages/workout-exercise-guides" target="_blank" rel="noopener">Simply Fitness</a>.</p>`;
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
  const act = t.dataset.act;
  const today = TODAY();

  if (act === 'set') {
    const row = t.closest('.set');
    const { day, slug } = row.dataset;
    const i = +row.dataset.i;
    const dayRow = DAY_BY_ID[day].ex.find((r) => r[0] === slug);
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
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    return;
  }
  if (act === 'toggle-ex') { t.closest('.ex').classList.toggle('collapsed'); return; }
  if (act === 'zoom') { $('#zoomimg').src = t.dataset.img; $('#zoom').hidden = false; return; }
  if (act === 'zoom-close') { $('#zoom').hidden = true; return; }
  if (act === 'timer-stop') { clearInterval(timer?.id); $('#timer').hidden = true; return; }
  if (act === 'timer-add') { const left = Math.round((timer.end - Date.now()) / 1000) + 30; startTimer(left, timer.label); return; }
  if (act === 'reset-day') {
    const day = S.tab;
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
    a.href = URL.createObjectURL(blob); a.download = `plan-retorno-${today}.json`; a.click();
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

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 1800);
}

window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); if (S._day !== TODAY()) { S._day = TODAY(); render(); } } });
S._day = TODAY();
render();
sync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
