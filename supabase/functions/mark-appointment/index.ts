// Marca una cita como "showed"/"noshow" en GHL (fuente real) y refleja el
// cambio de inmediato en la copia local (ghl_appointments). Usada por la
// lista "Citas sin marcar" del dashboard — solo permite estos dos estatus,
// nunca cancelled/deleted/reprogramar, para limitar el radio de acción.
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const GHL_TOKEN = Deno.env.get("AR_GHL_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_STATUS = new Set(["showed", "noshow"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { ...cors, "Content-Type": "application/json" } });
  }
  if (!GHL_TOKEN) {
    return new Response(JSON.stringify({ error: "proxy_not_configured" }), { status: 503, headers: { ...cors, "Content-Type": "application/json" } });
  }
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const { appointmentId, status } = body || {};
  if (!appointmentId || !ALLOWED_STATUS.has(status)) {
    return new Response(JSON.stringify({ error: "invalid_input" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  try {
    const ghlRes = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${appointmentId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-04-15", "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ appointmentStatus: status }),
    });
    if (!ghlRes.ok) {
      const t = await ghlRes.text();
      // Si la cita ya no existe en GHL (borrada/duplicada), no tiene caso reintentar —
      // limpiamos la copia local para que desaparezca sola de la lista.
      let isDeleted = false;
      try {
        const chk = await fetch(`https://services.leadconnectorhq.com/calendars/events/appointments/${appointmentId}`, {
          headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-04-15", Accept: "application/json" },
        });
        if (chk.ok) { const j = await chk.json(); isDeleted = !!(j.appointment && j.appointment.deleted); }
      } catch { /* no crítico */ }

      if (isDeleted && SUPABASE_URL && SERVICE_KEY) {
        await fetch(`${SUPABASE_URL}/rest/v1/ghl_appointments?id=eq.${appointmentId}`, {
          method: "PATCH",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ deleted: true }),
        });
        return new Response(JSON.stringify({ error: "appointment_deleted" }), { status: 410, headers: { ...cors, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "ghl_update_failed", detail: t }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Refleja en la copia local para que el dashboard no espere el próximo sync
    if (SUPABASE_URL && SERVICE_KEY) {
      await fetch(`${SUPABASE_URL}/rest/v1/ghl_appointments?id=eq.${appointmentId}`, {
        method: "PATCH",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ status }),
      });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "upstream_failed", message: String(e) }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
