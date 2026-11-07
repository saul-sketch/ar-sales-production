// @ts-nocheck
// Publica en Discord el reporte diario de ventas (#leadership-sales-force) y las
// entrevistas de reclutamiento (#hiring-reclutamiento) — Saúl 2026-11-07.
// Reemplaza el webhook que estaba escrito en la página pública (borrado el 06-nov
// porque quedó expuesto). Lo corre pg_cron cada 2 minutos: busca reportes nuevos
// (primer envío del día por sede) que todavía no se publicaron, arma el mismo
// mensaje que armaba la página y lo publica con el bot del Command Center.
// Funciona sin importar desde qué copia de la página se mandó el reporte.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const BOT_TOKEN = Deno.env.get("AR_DISCORD_BOT_TOKEN") ?? "";
const CRON_KEY = Deno.env.get("AR_CRON_KEY") ?? "";
const CHANNEL_ID = Deno.env.get("AR_SALES_REPORT_CHANNEL") ?? "1467965309309685877";
const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Cada aviso sale con su propio nombre (Saúl 2026-11-07): webhook guardado SOLO aquí
// en el servidor. Si falta, publica con el bot del Command Center.
const SALES_WEBHOOK = Deno.env.get("AR_SALES_WEBHOOK") ?? "";
const RECRUIT_WEBHOOK = Deno.env.get("AR_RECRUIT_WEBHOOK") ?? "";
const RECRUIT_CHANNEL_ID = Deno.env.get("AR_RECRUIT_CHANNEL") ?? "1467964924121714728";
const SUPA_HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
const currentUser = "";

async function sendDiscord(webhook: string, channelId: string, body: unknown) {
  if (webhook) {
    return await fetch(`${webhook}?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  return await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST", headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// ── Mismo armado del mensaje que tenía la página (index.html de ar-daily-visits) ──
async function buildReportMessage(report: any) {
  const DISCORD_USER_SAUL = '1242195465760542723';
  const DISCORD_USER_CHARLES = '1468206071133900915';

  const visits = report.visits || [];
  const applied = visits.filter(v => v.applied === true).length;
  const approved = visits.filter(v => v.result === 'approved').length;
  const denied = visits.filter(v => v.result === 'denied').length;
  const sales = visits.filter(v => v.sale === true);
  const totalSales = sales.length;

  // Color by sales count
  let color = 15679044; // red
  if (totalSales >= 4) color = 1102505;       // green
  else if (totalSales >= 1) color = 16092171; // amber

  // Visits by scheduled_by (new field) — count ALL visits not just sales
  const byChannel = { 'Self-gen': 0, 'Call Center': 0, 'Walk-in': 0 };
  let walkInNoInfo = 0;
  visits.forEach(v => {
    if (v.scheduled_by && byChannel[v.scheduled_by] !== undefined) {
      byChannel[v.scheduled_by]++;
      if (v.scheduled_by === 'Walk-in' && v.no_contact) walkInNoInfo++;
    }
  });
  const channelLine = `Self-gen: **${byChannel['Self-gen']}**  ·  Call Center: **${byChannel['Call Center']}**  ·  Walk-in: **${byChannel['Walk-in']}**${walkInNoInfo > 0 ? ` (${walkInNoInfo} sin info)` : ''}`;

  // Closers (with 0.5/0.5 split when 2 closers per Saúl's comp rule)
  const closerShares = {};
  sales.forEach(v => {
    const c1 = v.closer && v.closer.trim() && v.closer.toLowerCase() !== 'n/a' ? v.closer.trim() : null;
    const c2 = v.closer2 && v.closer2.trim() && v.closer2.toLowerCase() !== 'n/a' ? v.closer2.trim() : null;
    if (c1 && c2) { closerShares[c1] = (closerShares[c1] || 0) + 0.5; closerShares[c2] = (closerShares[c2] || 0) + 0.5; }
    else if (c1) closerShares[c1] = (closerShares[c1] || 0) + 1;
    else if (c2) closerShares[c2] = (closerShares[c2] || 0) + 1;
  });
  const fmtShare = v => Number.isInteger(v) ? String(v) : v.toFixed(1);
  const closersLine = Object.keys(closerShares).length
    ? Object.entries(closerShares).sort((a,b) => b[1]-a[1]).map(([n, s]) => `• ${n} (${fmtShare(s)})`).join('\n')
    : '—';

  // Sales detail (max 10 to respect Discord limit)
  const isEmpty = s => !s || !String(s).trim() || ['n/a','na','—','-'].includes(String(s).trim().toLowerCase());
  const salesDetail = sales.slice(0, 10).map(v => {
    const name = (v.name && v.name.trim()) ? v.name.trim() : (v.no_contact ? '— sin info —' : '—');
    const vehicle = !isEmpty(v.vehicle) ? v.vehicle.trim() : '—';
    const lender = !isEmpty(v.lender) ? v.lender.trim() : '—';
    const c1 = !isEmpty(v.closer) ? v.closer.trim() : null;
    const c2 = !isEmpty(v.closer2) ? v.closer2.trim() : null;
    const setter = !isEmpty(v.setter) ? v.setter.trim() : null;
    const isSelfGen = v.scheduled_by === 'Self-gen' || v.subgen === true;
    const closerLabel = c1 && c2 ? `${c1} + ${c2}` : (c1 || c2 || '—');
    const setterPart = setter ? ` · Setter ${setter}` : '';
    const sgBadge = isSelfGen ? '  🌟 **SELF-GEN**' : '';
    return `• ${name} — ${vehicle} — ${lender} — Closer ${closerLabel}${setterPart}${sgBadge}`;
  }).join('\n');
  const salesDetailLine = sales.length === 0 ? '_Sin ventas hoy_' : salesDetail + (sales.length > 10 ? `\n_…y ${sales.length - 10} más_` : '');

  // Date label
  const d = new Date(report.date + 'T00:00:00');
  const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const monthsFull = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const dateNice = `${d.getDate()} ${months[d.getMonth()]}`;

  // Month-to-date + pace + Δ vs previous month
  let paceLine = '';
  try {
    const yy = d.getFullYear();
    const mm = d.getMonth(); // 0-indexed
    const monthStart = `${yy}-${String(mm+1).padStart(2,'0')}-01`;
    const monthEnd = new Date(yy, mm+1, 0); // last day of current month
    const monthEndISO = `${yy}-${String(mm+1).padStart(2,'0')}-${String(monthEnd.getDate()).padStart(2,'0')}`;
    const daysInMonth = monthEnd.getDate();
    const dayOfMonth = d.getDate();
    // Previous month range
    const prevMm = mm === 0 ? 11 : mm - 1;
    const prevYy = mm === 0 ? yy - 1 : yy;
    const prevStart = `${prevYy}-${String(prevMm+1).padStart(2,'0')}-01`;
    const prevEnd = new Date(prevYy, prevMm+1, 0);
    const prevEndISO = `${prevYy}-${String(prevMm+1).padStart(2,'0')}-${String(prevEnd.getDate()).padStart(2,'0')}`;

    const res = await fetch(`${SUPA_URL}/rest/v1/ar_daily_reports?select=date,location,visits&date=gte.${prevStart}&date=lte.${monthEndISO}&location=eq.${encodeURIComponent(report.location)}`, { headers: SUPA_HEADERS });
    if (res.ok) {
      const rows = await res.json();
      let mtd = 0, prev = 0;
      rows.forEach(r => {
        const isCur = r.date >= monthStart && r.date <= monthEndISO;
        const isPrev = r.date >= prevStart && r.date <= prevEndISO;
        const salesInDay = (r.visits || []).filter(v => v.sale === true).length;
        if (isCur) mtd += salesInDay;
        else if (isPrev) prev += salesInDay;
      });
      const pace = dayOfMonth > 0 ? Math.round(mtd / dayOfMonth * daysInMonth) : mtd;
      const delta = pace - prev;
      const arrow = delta > 0 ? '▲' : (delta < 0 ? '▼' : '●');
      const sign = delta > 0 ? '+' : '';
      const prevLabel = monthsFull[prevMm];
      let deltaPart = '';
      if (prev > 0) {
        deltaPart = `  ·  ${arrow} **${sign}${delta}** vs ${prevLabel} (${prev})`;
      } else {
        deltaPart = `  ·  ${prevLabel} sin data`;
      }
      paceLine = `Llevamos **${mtd}** en ${dayOfMonth} día${dayOfMonth===1?'':'s'}  ·  pace **${pace}** al cierre${deltaPart}`;
    }
  } catch (e) {
    console.warn('pace calc failed:', e);
  }

  const body = {
    content: `<@${DISCORD_USER_SAUL}> <@${DISCORD_USER_CHARLES}>`,
    allowed_mentions: { users: [DISCORD_USER_SAUL, DISCORD_USER_CHARLES] },
    embeds: [{
      title: `📊 ${report.location} — ${dateNice}`,
      description: `Enviado por **${report.submitted_by || currentUser}**`,
      color,
      fields: [
        {
          name: 'Funnel del día',
          value: `Visitas: **${visits.length}**  ·  Aplicaron: **${applied}**  ·  Aprobados: **${approved}**  ·  Negados: **${denied}**  ·  Ventas: **${totalSales}**`,
          inline: false
        },
        {
          name: 'Visitas por canal',
          value: channelLine,
          inline: false
        },
        {
          name: 'Closers que cerraron',
          value: closersLine,
          inline: false
        },
        {
          name: 'Detalle ventas',
          value: salesDetailLine.slice(0, 1020),
          inline: false
        },
        ...(paceLine ? [{
          name: `📈 Mes (${monthsFull[d.getMonth()]}) — ${report.location}`,
          value: paceLine,
          inline: false
        }] : [])
      ],
      footer: { text: 'AR Sales Reports' }
    }]
  };

  return body;
}

// ── Entrevistas de reclutamiento (antes: webhook "Reclutamiento - Closers" en la
// página pública ar-recruitment-scorecard; mismo mensaje que armaba esa página) ──
const BENCHMARK_PASS = 35, BENCHMARK_BORDERLINE = 28;
const DISCORD_USER_HEADHUNTER = "1467993058158186678";
const RECRUIT_SAUL = "1242195465760542723", RECRUIT_CHARLES = "1468206071133900915";
function buildInterviewMessage(row) {
  const total = row.total_score ?? 0;
  const cls = total >= BENCHMARK_PASS ? "pass" : total >= BENCHMARK_BORDERLINE ? "borderline" : "fail";
  const colorMap = { pass: 1102505, borderline: 16092171, fail: 15679044 };
  const emojiMap = { pass: "✅", borderline: "⚠️", fail: "❌" };
  const verdictLabel = { pass: "Aprobado — Agendar con Saúl", borderline: "Borderline — Saúl decide", fail: "No pasa" };
  const scoreMap = {};
  (row.scores || []).forEach((x) => { scoreMap[x.question_id] = x.score; });
  const breakdown = [1,2,3,4,5,6,7,8,9,10].map((q) => `Q${q}=${scoreMap[q] ?? "–"}`).join(" · ");
  // El teléfono viaja como primera línea "☎ …" de las notas.
  let notes = row.notes || "", phone = "";
  const m = notes.match(/^☎ (.*)\n———\n/);
  if (m) { phone = m[1]; notes = notes.slice(m[0].length); }
  const when = new Date(row.submitted_at || Date.now());
  const dateNice = when.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "America/New_York" });
  const ids = cls === "fail" ? [DISCORD_USER_HEADHUNTER] : [DISCORD_USER_HEADHUNTER, RECRUIT_SAUL, RECRUIT_CHARLES];
  return {
    content: ids.map((u) => `<@${u}>`).join(" "),
    allowed_mentions: { users: ids },
    embeds: [{
      title: `${emojiMap[cls]} Nueva entrevista — ${row.candidate_name}`,
      color: colorMap[cls],
      fields: [
        { name: "Score", value: `**${total}/50** · ${verdictLabel[cls]}`, inline: false },
        { name: "📞 Teléfono", value: phone || "—", inline: false },
        { name: "Edad", value: row.age ? `${row.age} años` : "—", inline: true },
        { name: "Locación", value: row.location || "—", inline: true },
        { name: "Entrevistador", value: row.interviewer || "—", inline: true },
        { name: "Duración", value: row.duration_minutes ? `${row.duration_minutes} min` : "—", inline: true },
        { name: "Detalle", value: breakdown, inline: false },
        { name: "Notas", value: (notes || "—").slice(0, 1000), inline: false },
      ],
      footer: { text: `AR Recruitment Scorecard · ${dateNice}` },
      timestamp: when.toISOString(),
    }],
  };
}

// Publica las filas nuevas de una tabla una sola vez (ar_discord_posted guarda los id).
async function publishNew(table, build, webhook, channelId) {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const rRes = await fetch(`${SUPA_URL}/rest/v1/${table}?select=*&submitted_at=gte.${since}&order=submitted_at.asc`, { headers: SUPA_HEADERS });
  if (!rRes.ok) return { table, error: "db_read_failed" };
  const recent = await rRes.json();
  let posted = new Set();
  if (recent.length) {
    const pRes = await fetch(`${SUPA_URL}/rest/v1/ar_discord_posted?select=report_id&report_id=in.(${recent.map((r) => r.id).join(",")})`, { headers: SUPA_HEADERS });
    if (!pRes.ok) return { table, error: "db_read_failed" };
    posted = new Set((await pRes.json()).map((p) => p.report_id));
  }
  const pending = recent.filter((r) => !posted.has(r.id));
  const results = [];
  for (const row of pending) {
    // Reservar primero: si dos corridas se cruzan, solo una publica.
    const claim = await fetch(`${SUPA_URL}/rest/v1/ar_discord_posted`, {
      method: "POST", headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify({ report_id: row.id }),
    });
    if (!claim.ok) continue;
    const d = await sendDiscord(webhook, channelId, await build(row));
    if (!d.ok) {
      // Soltar la reserva para que la próxima corrida lo intente de nuevo.
      await fetch(`${SUPA_URL}/rest/v1/ar_discord_posted?report_id=eq.${row.id}`, { method: "DELETE", headers: SUPA_HEADERS });
      results.push({ id: row.id, ok: false, status: d.status });
    } else results.push({ id: row.id, ok: true });
  }
  return { table, checked: pending.length, results };
}

serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!BOT_TOKEN || !CRON_KEY || !SERVICE_KEY) return json(503, { error: "not_configured" });
  if (req.headers.get("x-cron-key") !== CRON_KEY) return json(401, { error: "unauthorized" });
  const sales = await publishNew("ar_daily_reports", buildReportMessage, SALES_WEBHOOK, CHANNEL_ID);
  // Reclutamiento solo con su webhook: el bot no está en ese canal.
  const recruit = RECRUIT_WEBHOOK
    ? await publishNew("ar_interview_scorecards", buildInterviewMessage, RECRUIT_WEBHOOK, RECRUIT_CHANNEL_ID)
    : { table: "ar_interview_scorecards", skipped: "no_webhook" };
  return json(200, { sales, recruit });
});
