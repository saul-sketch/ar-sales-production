#!/usr/bin/env python3
"""
AR Daily Reconciliation — cross-match GHL calendar 'showed' appointments against
the managers' Sales Report visits, by phone, day by day (newest → oldest).

Conclusions per day:
  matched       = a showed appointment whose contact phone IS a reported visit
  calendar_only = showed in calendar but NO visit reported (manager missed it, or false show)
  report_only   = visit reported but NO showed appointment (walk-in, or appt not marked)

Writes ar_reconciliation_daily (idempotent upsert by date). Sustainable: re-run
anytime; it recomputes the requested window from the live sources.

Usage: python3 reconcile.py [days_back]   (default 14)
"""
import json, re, sys, os, urllib.request, datetime

VAULT = os.path.expanduser("~/.claude/.ar-dialer-service-vault")
def vault(key):
    for line in open(VAULT):
        if line.startswith(key+"="):
            return line.split("=",1)[1].strip().strip('"')
    return None

SERVICE_TOKEN = vault("SERVICE_TOKEN")
BRIDGE = "https://wavedialer.fly.dev/service"
AR_LOC = "ez4QcQYqIRKvgT8fIQ22"
SUPA = "https://xwxjutaqouaeocvxawlw.supabase.co"
ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3eGp1dGFxb3VhZW9jdnhhd2x3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNTIxMzYsImV4cCI6MjA5MjYyODEzNn0.TOigRbaNL5z3Q7hd4llJyqrC6vZwn_-1R-5JudXtJmU"

def phone(p):
    d = re.sub(r"\D","",str(p or ""))
    return d[-10:] if len(d)>=10 else None

def http_get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())

STATUSES = ("showed", "noshow", "cancelled", "confirmed", "new", "invalid")

ALIAS = {}
def canon(name):
    """Mismo nombre canónico que muestra el tablero (crm_name_alias)."""
    return ALIAS.get(str(name or "").lower().strip(), name)

def load_mapping():
    """GHL user id → display name.

    Two sources, in this order:
      1. ar_agent_mapping  — la tabla manual. Manda, para no romper el histórico de
         quien ya tiene un nombre distinto al del CRM (p.ej. "Fabiola" vs "Fabiola Lorio").
      2. crm_roster        — TODA la gente del CRM, con su crm_user_id. Es el auto-alta:
         cualquiera que empiece a marcar aparece desde el primer día sin que nadie
         registre nada a mano. Sin esto, cada persona nueva caía en un balde "uid:<id>"
         y sus llamadas no se le acreditaban a nadie.

    El tablero resuelve nombres exactamente en este mismo orden, así que las llaves
    que escribimos aquí coinciden con las que él busca."""
    global ALIAS
    hdr = {"apikey": ANON, "Authorization": f"Bearer {ANON}"}
    out = {}
    # La tabla manual primero, para que crm_roster la PISE — el tablero resuelve en ese
    # mismo orden (roster antes que manual). Si aquí lo hiciéramos al revés, quien tenga
    # dos nombres distintos queda con la llave cambiada y sus llamadas no se ven: pasaba
    # con "Isiley M" en el CRM vs "Isiley" en la tabla manual (2.676 llamadas perdidas).
    manual = http_get(f"{SUPA}/rest/v1/ar_agent_mapping?select=dialer_user_id,sales_report_name", hdr)
    for m in manual:
        if m.get("dialer_user_id") and m.get("sales_report_name"):
            out[m["dialer_user_id"]] = m["sales_report_name"]
    try:
        roster = http_get(f"{SUPA}/rest/v1/crm_roster?select=crm_user_id,name", hdr)
        for r in roster:
            if r.get("crm_user_id") and r.get("name"):
                out[r["crm_user_id"]] = r["name"]
    except Exception as e:
        print(f"  aviso: no se pudo leer crm_roster ({str(e)[:40]}) — solo mapeo manual")
    # Última pasada: el MISMO alias que usa el tablero (crm_name_alias), para que la llave
    # que escribimos aquí sea idéntica a la que él busca. Sin esto, alguien guardado como
    # "Carlos B" queda invisible porque el tablero lo muestra como "Carlos Brito".
    try:
        ALIAS = {a["alias"]: a["canonical_name"]
                 for a in http_get(f"{SUPA}/rest/v1/crm_name_alias?select=alias,canonical_name", hdr)
                 if a.get("alias") and a.get("canonical_name")}
        for uid, nm in list(out.items()):
            out[uid] = canon(nm)
    except Exception as e:
        print(f"  aviso: no se pudo leer crm_name_alias ({str(e)[:40]})")
    return out

def cal_appts(day):
    """All calendar events happening on `day` (raw) — one fetch, reused for both
    the showed-reconciliation and the per-agent status breakdown."""
    url = f"{BRIDGE}/appointments?from={day}&to={day}&by=startTime&withPhone=true&loc={AR_LOC}"
    return http_get(url, {"X-Service-Token": SERVICE_TOKEN}).get("appointments", [])

def calls_by_agent(day, uid2name):
    """sales_report_name(lower) → dials that day, from the dialer ledger (/agents).
    Lets the per-week history show LLAM. per agent (ledger keeps ~35 days; the daily
    cron captures yesterday each run, so history accumulates permanently in Supabase)."""
    url = f"{BRIDGE}/agents?from={day}&to={day}&tz=-300"
    data = http_get(url, {"X-Service-Token": SERVICE_TOKEN})
    out = {}
    for a in data.get("agents", []):
        uid = a.get("agentUserId")
        # roster/manual → si el uid no está en ninguna, el nombre que da el propio marcador
        # (igual que el tablero). Solo si tampoco hay nombre cae al balde uid:<id>.
        name = uid2name.get(uid) or canon(a.get("agentName"))
        key = name.lower() if name else (f"uid:{uid}" if uid else None)
        if key: out[key] = out.get(key, 0) + (a.get("calls") or 0)
    return out

def showed_by_phone(appts):
    """phone → {title, agent} for SHOWED appts (for the visit reconciliation)."""
    out = {}
    for a in appts:
        if (a.get("status") or "").lower() != "showed": continue
        ph = phone(a.get("contactPhone"))
        if ph: out[ph] = {"title": a.get("title"), "agent": a.get("assignedUserId")}
    return out

def status_by_agent(appts, uid2name):
    """sales_report_name(lower) → {showed,noshow,cancelled,confirmed,new,invalid,other,total}.
    Straight from the GHL calendar status of each appointment, grouped by assigned agent.
    Agents without a Sales-Report mapping are keyed 'uid:<id>' so nothing is lost."""
    out = {}
    for a in appts:
        uid = a.get("assignedUserId")
        if not uid: continue
        name = uid2name.get(uid)
        key = name.lower() if name else f"uid:{uid}"
        st = (a.get("status") or "unknown").lower()
        d = out.setdefault(key, {s: 0 for s in STATUSES} | {"other": 0, "total": 0})
        d["total"] += 1
        if st in STATUSES: d[st] += 1
        else: d["other"] += 1
    return out

def sr_visits(day):
    url = f"{SUPA}/rest/v1/ar_daily_reports?select=visits&date=eq.{day}"
    data = http_get(url, {"apikey": ANON, "Authorization": f"Bearer {ANON}"})
    out = {}
    for r in data:
        for v in (r.get("visits") or []):
            ph = phone(v.get("phone"))
            if ph: out[ph] = {"name": v.get("name"), "closer": v.get("closer"), "sale": v.get("sale")}
    return out

def upsert(row):
    body = json.dumps([row]).encode()
    req = urllib.request.Request(
        f"{SUPA}/rest/v1/ar_reconciliation_daily?on_conflict=recon_date",
        data=body, method="POST",
        headers={"apikey": ANON, "Authorization": f"Bearer {ANON}",
                 "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"})
    urllib.request.urlopen(req, timeout=30).read()

def main():
    days_back = int(sys.argv[1]) if len(sys.argv)>1 else 14
    # newest → oldest, starting yesterday (today's data is incomplete)
    today = datetime.date(2026,6,1)  # passed-in date authority (no Date.now in this env via wrapper)
    # When run live, derive from system:
    try: today = datetime.date.today()
    except Exception: pass
    uid2name = load_mapping()
    print(f"Reconciliando {days_back} días (ayer → atrás) · {len(uid2name)} personas reconocidas\n")
    print(f"{'Fecha':12s} {'Showed':>6s} {'Report':>6s} {'Match':>5s} {'CalSolo':>7s} {'RepSolo':>7s} {'Match%':>6s}")
    for i in range(1, days_back+1):
        day = (today - datetime.timedelta(days=i)).isoformat()
        try:
            appts = cal_appts(day)
            cal = showed_by_phone(appts)
            by_agent = status_by_agent(appts, uid2name)
            # merge per-agent dials (so the weekly/daily history can show LLAM.)
            for key, c in calls_by_agent(day, uid2name).items():
                d = by_agent.setdefault(key, {s: 0 for s in STATUSES} | {"other": 0, "total": 0})
                d["calls"] = c
            for d in by_agent.values():
                d.setdefault("calls", 0)
            sr = sr_visits(day)
            cset, sset = set(cal), set(sr)
            matched = cset & sset
            cal_only = cset - sset
            rep_only = sset - cset
            mr = round(len(matched)/max(len(cset),1)*100, 1)
            detail = {
                "calendar_only": [{"phone": p[-4:], **cal[p]} for p in cal_only],
                "report_only":   [{"phone": p[-4:], **sr[p]} for p in rep_only],
                "by_agent_status": by_agent,
            }
            upsert({"recon_date": day, "showed_count": len(cal), "reported_count": len(sr),
                    "matched": len(matched), "calendar_only": len(cal_only),
                    "report_only": len(rep_only), "match_rate": mr, "detail": detail})
            print(f"  {day} {len(cal):>6} {len(sr):>6} {len(matched):>5} {len(cal_only):>7} {len(rep_only):>7} {mr:>5}%")
        except Exception as e:
            print(f"  {day}  ERROR: {str(e)[:60]}")
    print("\n✓ Guardado en ar_reconciliation_daily")

if __name__ == "__main__":
    main()
