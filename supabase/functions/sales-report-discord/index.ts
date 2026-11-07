// Publica el reporte diario de ventas en #leadership-sales-force (Saúl 2026-11-07).
// Reemplaza el webhook que estaba escrito en la página pública (borrado el 06-nov
// porque quedó expuesto). Solo acepta llamadas con una sesión válida (x-ar-ses →
// ar_ses_ok) y publica con el bot del Command Center: el canal y las menciones
// los fija esta función, la página solo manda los embeds.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const BOT_TOKEN = Deno.env.get("AR_DISCORD_BOT_TOKEN") ?? "";
const CHANNEL_ID = Deno.env.get("AR_SALES_REPORT_CHANNEL") ?? "1467965309309685877";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MENTION_USERS = ["1242195465760542723", "1468206071133900915"]; // Saúl, Charles

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ar-ses",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sesionValida(token: string): Promise<boolean> {
  if (!token || !SUPABASE_URL || !ANON_KEY) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ar_ses_ok`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json", "x-ar-ses": token },
    body: "{}",
  });
  return r.ok && (await r.json()) === true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!BOT_TOKEN) return json(503, { error: "not_configured" });
  if (!(await sesionValida(req.headers.get("x-ar-ses") ?? ""))) return json(401, { error: "no_session" });

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const embeds = Array.isArray(body?.embeds) ? body.embeds.slice(0, 10) : [];
  if (!embeds.length) return json(400, { error: "invalid_input" });

  const r = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: MENTION_USERS.map((u) => `<@${u}>`).join(" "),
      allowed_mentions: { users: MENTION_USERS },
      embeds,
    }),
  });
  if (!r.ok) return json(502, { error: "discord_failed", status: r.status, detail: (await r.text()).slice(0, 300) });
  return json(200, { ok: true });
});
