// Secure proxy: holds the dialer SERVICE_TOKEN server-side and exposes only
// aggregate per-agent counts (no client PII) to the public AR Sales Production app.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const SERVICE_TOKEN = Deno.env.get("DIALER_SERVICE_TOKEN") ?? "";
const DIALER = "https://wavedialer.fly.dev/service";
const ALLOWED = new Set(["agents", "calls", "ping", "roster"]); // NOT /appointments (has contactId PII). roster = CRM users + WaveDialer team (no PII).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!SERVICE_TOKEN) {
    return new Response(JSON.stringify({ error: "proxy_not_configured" }), { status: 503, headers: { ...cors, "Content-Type": "application/json" } });
  }
  // Desfase de Florida frente a UTC en minutos (240 verano / 300 invierno), como espera el marcador.
  const floridaOffset = () => {
    const v = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
      .formatToParts(new Date()).find((x) => x.type === "timeZoneName")?.value || "";
    const m = v.match(/GMT([+-])(\d+)(?::(\d+))?/);
    return m ? -(m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10)) : 240;
  };
  const url = new URL(req.url);
  const resource = url.searchParams.get("resource") || "agents";
  if (!ALLOWED.has(resource)) {
    return new Response(JSON.stringify({ error: "resource_not_allowed" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const tz = url.searchParams.get("tz") || String(floridaOffset());
  const target = `${DIALER}/${resource}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tz=${encodeURIComponent(tz)}`;
  try {
    const r = await fetch(target, { headers: { "X-Service-Token": SERVICE_TOKEN } });
    const body = await r.text();
    return new Response(body, { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "upstream_failed", message: String(e) }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
