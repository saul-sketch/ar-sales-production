#!/usr/bin/env node
/**
 * Barrido de citas "sin marcar": una cita cuya fecha ya pasó pero sigue en
 * estatus confirmed/new (nadie le dio click a llegó/no llegó/canceló en GHL).
 *
 * Solo actúa cuando hay certeza: si el teléfono del contacto aparece en un
 * reporte de visita (ar_daily_reports), la marca como "showed" en GHL.
 * Si no hay rastro del teléfono, NO LA TOCA — se deja para revisión manual.
 * (Decisión de Saúl 2026-07-19: solo auto-marcar llegó, nunca auto-marcar no-show.)
 *
 * Usage: node scripts/resolve-stale-appointments.js
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
const SUPA_SQL = `https://api.supabase.com/v1/projects/${V.SUPABASE_REF}/database/query`;
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3eGp1dGFxb3VhZW9jdnhhd2x3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNTIxMzYsImV4cCI6MjA5MjYyODEzNn0.TOigRbaNL5z3Q7hd4llJyqrC6vZwn_-1R-5JudXtJmU';
const SUPA_URL = 'https://xwxjutaqouaeocvxawlw.supabase.co';

function normPhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : (d || null);
}

async function sql(query) {
  const r = await fetch(SUPA_SQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${V.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('sql failed: ' + JSON.stringify(j));
  return j;
}

(async () => {
  console.log(`[${new Date().toISOString()}] Buscando citas sin marcar...`);

  // 1) Candidatas: fecha de cita ya pasó (con 4h de margen) y sigue confirmed/new
  const candidates = await sql(
    `select id, calendar_id, start_time from ghl_appointments
     where deleted=false and status in ('confirmed','new')
       and start_time < now() - interval '4 hours'
       and start_time > now() - interval '90 days'
     order by start_time desc limit 300`
  );
  console.log(`  ${candidates.length} candidatas`);
  if (!candidates.length) return;

  // 2) Teléfonos ya conocidos en reportes de visita (últimos 100 días)
  const visitRows = await sql(
    `select v->>'phone' as phone from ar_daily_reports, jsonb_array_elements(visits) v
     where date >= (current_date - interval '100 days') and v->>'phone' is not null`
  );
  const knownPhones = new Set(visitRows.map(r => normPhone(r.phone)).filter(Boolean));
  console.log(`  ${knownPhones.size} teléfonos únicos en reportes de visita`);

  let resolved = 0, skipped = 0, errors = 0;
  for (const c of candidates) {
    await new Promise(r => setTimeout(r, 150)); // no saturar la API de GHL
    try {
      const ar = await fetch(`${GHL}/calendars/events/appointments/${c.id}`, { headers: H });
      if (!ar.ok) { errors++; continue; }
      const appt = (await ar.json()).appointment || {};
      const contactId = appt.contactId;
      if (!contactId) { skipped++; continue; }

      const cr = await fetch(`${GHL}/contacts/${contactId}`, { headers: H });
      if (!cr.ok) { errors++; continue; }
      const contact = (await cr.json()).contact || {};
      const phone = normPhone(contact.phone);

      if (!phone || !knownPhones.has(phone)) { skipped++; continue; }

      // Match encontrado — marcar como "showed" en GHL
      const pr = await fetch(`${GHL}/calendars/events/appointments/${c.id}`, {
        method: 'PUT',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointmentStatus: 'showed' }),
      });
      if (!pr.ok) { errors++; continue; }

      // Reflejar en la copia local de inmediato (no esperar el próximo sync)
      await fetch(`${SUPA_URL}/rest/v1/ghl_appointments?id=eq.${c.id}`, {
        method: 'PATCH',
        headers: { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'showed' }),
      });

      resolved++;
      console.log(`  ✓ ${c.id} (${appt.title || ''}) → llegó (tel coincide con reporte)`);
    } catch (e) {
      errors++;
      console.warn(`  ! error en ${c.id}: ${e.message}`);
    }
  }
  console.log(`[${new Date().toISOString()}] Listo. Resueltas: ${resolved} · sin rastro (sin tocar): ${skipped} · errores: ${errors}`);
})().catch(e => { console.error('RESOLVE ERROR:', e.message); process.exit(1); });
