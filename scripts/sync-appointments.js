#!/usr/bin/env node
/**
 * Sync AR calendar appointments → Supabase table ghl_appointments.
 * Attributes each appointment to its BOOKER (createdBy.userId) — the setter who
 * agendó — NOT assignedUserId (which in GHL is the closer or nobody).
 *
 * Powers the "citas" column in ar-sales-production. Replaces the dialer feed's
 * appointment count (which was wrong because the bridge counted by assignee).
 *
 * Usage:
 *   node scripts/sync-appointments.js           # incremental (last 45 days booked)
 *   node scripts/sync-appointments.js --full     # backfill last 14 months
 *
 * Reads config from ~/.claude/.ar-ghl-appts-vault.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadVault() {
  const p = path.join(os.homedir(), '.claude', '.ar-ghl-appts-vault');
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const V = loadVault();
const GHL = 'https://services.leadconnectorhq.com';
const H = { Authorization: `Bearer ${V.AR_GHL_TOKEN}`, Version: '2021-04-15', Accept: 'application/json' };
const CALS = V.AR_CALENDARS.split(',');
const LOC = V.AR_LOCATION;

let fetchFailed = false;
async function fetchMonth(calId, startMs, endMs) {
  const url = `${GHL}/calendars/events?locationId=${LOC}&calendarId=${calId}&startTime=${startMs}&endTime=${endMs}`;
  const r = await fetch(url, { headers: H });
  if (!r.ok) { console.warn(`  fetch ${calId} ${new Date(startMs).toISOString().slice(0,7)} → ${r.status}`); fetchFailed = true; return []; }
  const j = await r.json();
  return j.events || [];
}

function esc(v) { return v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`; }

async function upsert(rows) {
  if (!rows.length) return;
  const values = rows.map(e => `(${esc(e.id)},${esc(e.created_by)},${esc(e.date_added)},${esc(e.start_time)},${esc(e.status)},${esc(e.calendar_id)},${esc(LOC)},${e.deleted ? 'true' : 'false'},${esc(e.title)},${esc(e.contact_id)})`).join(',');
  const sql = `insert into ghl_appointments (id, created_by_user_id, date_added, start_time, status, calendar_id, location_id, deleted, title, contact_id)
    values ${values}
    on conflict (id) do update set created_by_user_id=excluded.created_by_user_id, date_added=excluded.date_added,
      start_time=excluded.start_time, status=excluded.status, deleted=excluded.deleted, title=excluded.title,
      contact_id=excluded.contact_id, synced_at=now();`;
  for (let attempt = 1; attempt <= 7; attempt++) {
    let r;
    try {
      r = await fetch(`https://api.supabase.com/v1/projects/${V.SUPABASE_REF}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${V.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql }),
      });
      if (r.ok) return;
    } catch (e) { /* network blip → retry */ }
    if (attempt === 7) throw new Error(`upsert failed after retries`);
    await new Promise(res => setTimeout(res, 1200 * attempt));
  }
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${V.SUPABASE_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${V.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`sql ${r.status}`);
  return r.json();
}

// Una cita que se borra o se mueve en el CRM deja de venir en la lectura, pero la fila
// vieja se quedaba "viva" en la tabla y el tablero la seguia contando (6 de 100 citas
// de la semana del 9 al 15 de octubre). Aqui se marcan como borradas (reversible: si la
// cita reaparece, el upsert la deja viva otra vez). Solo si la lectura salio completa y
// el numero de faltantes es razonable; ante la duda no toca nada.
async function marcarBorradas(seen, start, end) {
  if (fetchFailed) { console.warn('Lectura incompleta: no se marcan borradas.'); return; }
  const rows = await sql(`select id from ghl_appointments where location_id='${LOC}' and deleted=false
    and start_time >= '${start.toISOString()}' and start_time <= '${end.toISOString()}'`);
  const faltan = rows.map(r => r.id).filter(id => !seen.has(id));
  if (!faltan.length) { console.log('Borradas: ninguna.'); return; }
  if (faltan.length > Math.max(10, rows.length * 0.15)) {
    console.warn(`Faltan ${faltan.length} de ${rows.length}: demasiadas, no se marcan (revisar a mano).`); return;
  }
  for (let i = 0; i < faltan.length; i += 100) {
    const ids = faltan.slice(i, i + 100).map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
    await sql(`update ghl_appointments set deleted=true, synced_at=now() where id in (${ids})`);
  }
  console.log(`Borradas en el CRM y marcadas aqui: ${faltan.length}`);
}

(async () => {
  const full = process.argv.includes('--full');
  const now = Date.now();
  const monthsBack = full ? 14 : 2;          // booking window (by startTime, wide enough to catch dateAdded)
  const start = new Date(now); start.setMonth(start.getMonth() - monthsBack); start.setDate(1);
  const end = new Date(now); end.setMonth(end.getMonth() + 3); // future appts already booked

  console.log(`Sync ${full ? 'FULL (14mo)' : 'incremental (2mo)'} · ${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)}`);
  const seen = new Set();
  const batch = [];
  let total = 0;

  // Iterate month-by-month (avoids GHL response caps), per calendar.
  for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) {
    const mStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const mEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime();
    for (const cal of CALS) {
      const events = await fetchMonth(cal, mStart, mEnd);
      for (const e of events) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        batch.push({
          id: e.id,
          created_by: e.createdBy && e.createdBy.userId ? e.createdBy.userId : null,
          date_added: e.dateAdded || null,
          start_time: e.startTime || null,
          status: e.appointmentStatus || e.status || null,
          calendar_id: cal,
          deleted: !!e.deleted,
          title: e.title || null,
          contact_id: e.contactId || null,
        });
        total++;
      }
    }
    while (batch.length >= 50) { await upsert(batch.splice(0, 50)); process.stdout.write('.'); await new Promise(r => setTimeout(r, 250)); }
  }
  if (batch.length) await upsert(batch);
  console.log(`\nDone. ${total} appointments upserted.`);
  await marcarBorradas(seen, start, end);
})().catch(e => { console.error('SYNC ERROR:', e.message); process.exit(1); });
