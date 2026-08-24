#!/usr/bin/env python3
"""Unifica los nombres dentro del histórico ya cerrado (ar_reconciliation_daily).

El histórico se fue guardando con la escritura que existía cada día ("Fabiola" en mayo,
"Fabiola Iorio" después), así que una misma persona quedó partida en varias llaves. El
tablero ya las junta al mostrarlas, pero el dato guardado sigue sucio y cada cierre nuevo
lo arrastra. Esto lo limpia de una vez.

Es una transformación PURA de lo ya guardado: no consulta al marcador ni al calendario,
así que no puede perder nada. Verifica que el total de llamadas de cada día sea idéntico
antes y después; si no cuadra, ese día no se escribe.

Uso: python3 unify-history-names.py [--aplicar]    (sin --aplicar solo muestra qué haría)
"""
import json, sys, urllib.request, os

SUPA = "https://xwxjutaqouaeocvxawlw.supabase.co"
ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3eGp1dGFxb3VhZW9jdnhhd2x3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNTIxMzYsImV4cCI6MjA5MjYyODEzNn0.TOigRbaNL5z3Q7hd4llJyqrC6vZwn_-1R-5JudXtJmU"
H = {"apikey": ANON, "Authorization": f"Bearer {ANON}"}
APLICAR = "--aplicar" in sys.argv

def get(url):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=90).read())

alias_rows = get(f"{SUPA}/rest/v1/crm_name_alias?select=alias,canonical_name")
ALIAS = {a["alias"]: a["canonical_name"] for a in alias_rows if a.get("alias") and a.get("canonical_name")}
_ros = get(f"{SUPA}/rest/v1/crm_roster?select=crm_user_id,name")
ROSTER = {(r["name"] or "").lower(): r["name"] for r in _ros if r.get("name")}
# Para rescatar los baldes "uid:<id>": quién es esa persona, por su ID.
POR_ID = {a["crm_user_id"]: a["canonical_name"] for a in alias_rows
          if a.get("crm_user_id") and a.get("canonical_name")}
for r in _ros:
    if r.get("crm_user_id") and r.get("name"):
        POR_ID.setdefault(r["crm_user_id"], r["name"])
for m in get(f"{SUPA}/rest/v1/ar_agent_mapping?select=dialer_user_id,sales_report_name"):
    if m.get("dialer_user_id") and m.get("sales_report_name"):
        POR_ID.setdefault(m["dialer_user_id"], m["sales_report_name"])

def canon(k):
    # Balde sin nombre: si hoy sabemos de quién es ese ID, se le devuelve su nombre.
    # Si no (la cuenta ya no existe en ningún lado), se queda como está — no se inventa.
    if k.startswith("uid:"):
        nm = POR_ID.get(k[4:])
        if not nm: return k
        k = nm.lower()
    c = ALIAS.get(k)
    if c: return c.lower()
    n = ROSTER.get(k)
    return n.lower() if n else k

rows = get(f"{SUPA}/rest/v1/ar_reconciliation_daily?select=recon_date,detail&order=recon_date.asc")
print(f"{len(rows)} días cerrados\n")
cambiados, saltados = 0, 0
for r in rows:
    det = r.get("detail") or {}
    bas = det.get("by_agent_status") or {}
    if not bas: continue
    nuevo = {}
    for k, v in bas.items():
        ck = canon(k)
        d = nuevo.setdefault(ck, {})
        for f, n in (v or {}).items():
            if isinstance(n, (int, float)): d[f] = (d.get(f) or 0) + n
            else: d.setdefault(f, n)
    if nuevo == bas:
        continue
    # invariante: el total de cada métrica no puede cambiar
    def tot(x, f): return sum((y.get(f) or 0) for y in x.values())
    mal = [f for f in ("calls", "contacts", "minutes", "sms", "total") if tot(bas, f) != tot(nuevo, f)]
    if mal:
        print(f"  {r['recon_date']}  SALTADO — no cuadra en {mal}")
        saltados += 1
        continue
    fusion = len(bas) - len(nuevo)
    print(f"  {r['recon_date']}  {len(bas)} → {len(nuevo)} personas ({fusion} unidas) · {tot(bas,'calls')} llamadas intactas")
    cambiados += 1
    if APLICAR:
        det["by_agent_status"] = nuevo
        body = json.dumps([{"recon_date": r["recon_date"], "detail": det}]).encode()
        req = urllib.request.Request(f"{SUPA}/rest/v1/ar_reconciliation_daily?on_conflict=recon_date",
            data=body, method="POST",
            headers={**H, "Content-Type": "application/json",
                     "Prefer": "resolution=merge-duplicates,return=minimal"})
        urllib.request.urlopen(req, timeout=30).read()

print(f"\n{cambiados} días a limpiar · {saltados} saltados")
print("(simulación — corre con --aplicar para escribir)" if not APLICAR else "✓ aplicado")
