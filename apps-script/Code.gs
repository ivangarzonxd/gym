// Gym Vancho — backend en Google Sheets.
// 1) Cambia TOKEN por una clave tuya (la misma que pondrás en Ajustes de la app).
// 2) Implementar → Nueva implementación → Aplicación web → Ejecutar como: Yo · Acceso: Cualquier usuario.
const TOKEN = 'CAMBIA-ESTA-CLAVE';

const SHEETS = {
  Series: ['id', 'date', 'day', 'ex', 'name', 'set', 'kg', 'reps', 'done'],
  Diario: ['id', 'date', 'active', 'target', 'eaten', 'protein', 'weight', 'waist', 'drinks', 'grip', 'creatine'],
  Comidas: ['id', 'date', 'meal', 'name', 'g', 'kcal', 'p', 'c', 'f', 'drinks'],
};
const TYPE_SHEET = { set: 'Series', daily: 'Diario', food: 'Comidas' };

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'JSON inválido' }); }
  if (body.token !== TOKEN) return out({ ok: false, error: 'Clave incorrecta' });
  if (body.action === 'ping') return out({ ok: true });
  if (body.action === 'pull') return out({ ok: true, series: rows('Series'), diario: rows('Diario'), comidas: rows('Comidas') });
  if (body.action === 'push') {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      for (const ev of body.events || []) {
        const name = TYPE_SHEET[ev.type];
        if (!name) continue;
        const remove = (ev.type === 'set' && !ev.done) || (ev.type === 'food' && ev.del);
        if (remove) deleteRow(name, ev.id);
        else upsert(name, SHEETS[name].map((h) => (ev[h] == null ? '' : ev[h])));
      }
    } finally {
      lock.releaseLock();
    }
    return out({ ok: true });
  }
  return out({ ok: false, error: 'Acción desconocida' });
}

function doGet() {
  return out({ ok: true, app: 'Gym Vancho' });
}

function sheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, SHEETS[name].length).setFontWeight('bold');
    sh.getRange('A:B').setNumberFormat('@'); // id y fecha como texto
  }
  return sh;
}

function findRow(sh, id) {
  const hit = sh.getRange('A:A').createTextFinder(String(id)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function upsert(name, values) {
  const sh = sheet(name);
  const r = findRow(sh, values[0]);
  if (r) sh.getRange(r, 1, 1, values.length).setValues([values]);
  else sh.appendRow(values);
}

function deleteRow(name, id) {
  const sh = sheet(name);
  const r = findRow(sh, id);
  if (r > 1) sh.deleteRow(r);
}

function rows(name) {
  const sh = sheet(name);
  const data = sh.getDataRange().getValues();
  const head = data.shift();
  return data.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] instanceof Date ? Utilities.formatDate(r[i], 'Europe/Madrid', 'yyyy-MM-dd') : r[i]])));
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
