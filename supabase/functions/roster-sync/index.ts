// roster-sync — mantiene public.crm_roster al día desde la fuente maestra.
//
// Fuente: proxy dialer-proxy?resource=roster  → cada usuario del CRM (nombre tal cual
// está en el CRM) + su equipo del WaveDialer (call-center | closers-orlando |
// closers-kissimmee). Destino: public.crm_roster, que leen el reporte de ventas, KPIs
// y dashboards (lectura instantánea, sin pegarle en vivo al teléfono en cada clic).
//
// Se dispara por pg_cron cada pocos minutos. Idempotente: upsert por crm_user_id.
// A quien ya no esté en el CRM lo marca active=false (NO se borra — su historia queda).
//
// Usa los secrets que Supabase inyecta solo: SUPABASE_URL, SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY. No requiere configurar nada extra.

const PROXY = "/functions/v1/dialer-proxy?resource=roster";

Deno.serve(async (_req) => {
  const started = Date.now();
  try {
    const supaUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supaUrl || !anon || !serviceRole) return json({ ok: false, error: "missing_env" }, 500);

    // 1) Traer la lista maestra (CRM + equipos) vía el proxy que ya guarda el token del teléfono
    const r = await fetch(`${supaUrl}${PROXY}`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    });
    if (!r.ok) return json({ ok: false, error: "proxy_" + r.status }, 502);
    const data = await r.json();
    const roster: Array<{ id: string; name: string; team: string | null }> = data.roster || [];
    if (!roster.length) return json({ ok: false, error: "empty_roster" }, 502);

    const nowIso = new Date().toISOString();
    const rows = roster
      .filter((p) => p.id && p.name)
      .map((p) => ({ crm_user_id: p.id, name: p.name, team: p.team ?? null, active: true, synced_at: nowIso }));

    const rest = `${supaUrl}/rest/v1/crm_roster`;
    const H = { apikey: serviceRole, Authorization: `Bearer ${serviceRole}`, "Content-Type": "application/json" };

    // 2) Upsert (merge por crm_user_id) — nombres y equipos siempre reflejan el CRM
    const up = await fetch(`${rest}?on_conflict=crm_user_id`, {
      method: "POST",
      headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!up.ok) return json({ ok: false, error: "upsert_" + up.status, detail: await up.text() }, 500);

    // 3) A quien ya NO está en el CRM → active=false (nunca se borra: su historia queda intacta)
    const ids = rows.map((x) => `"${x.crm_user_id}"`).join(",");
    await fetch(`${rest}?active=eq.true&crm_user_id=not.in.(${ids})`, {
      method: "PATCH",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ active: false, synced_at: nowIso }),
    });

    return json({ ok: true, synced: rows.length, ms: Date.now() - started });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
