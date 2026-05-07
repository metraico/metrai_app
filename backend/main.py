import json
import os

import httpx
import psycopg2
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

SIM_ENGINE_URL = os.getenv("SIM_ENGINE_URL", "http://localhost:8001")
POSTGRES_DSN   = os.getenv("POSTGRES_DSN")

app = FastAPI(title="Metrai App Backend", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DUMMY_ACCOUNT_ID = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
DUMMY_USER_ID    = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"


def _pg_connect():
    return psycopg2.connect(POSTGRES_DSN)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Auth (dummy)
# ---------------------------------------------------------------------------

@app.post("/login")
def login(credentials: dict):
    if (credentials.get("username") == "demo"
            and credentials.get("password") == "demo123"):
        return {
            "user_id":    DUMMY_USER_ID,
            "account_id": DUMMY_ACCOUNT_ID,
            "full_name":  "Demo User",
        }
    raise HTTPException(status_code=401, detail="Invalid credentials")


# ---------------------------------------------------------------------------
# Run history
# ---------------------------------------------------------------------------

@app.get("/runs")
def get_runs(account_id: str = DUMMY_ACCOUNT_ID):
    if not POSTGRES_DSN:
        return []
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT simulation_id::text, simulation_name, simulation_status,
                       created_at, start_week, end_week, random_seed, notes
                FROM simulation_config
                WHERE account_id = %s
                ORDER BY created_at DESC
                LIMIT 50
                """,
                (account_id,),
            )
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
            for row in rows:
                for k, v in row.items():
                    if hasattr(v, "isoformat"):
                        row[k] = v.isoformat()
            return rows
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Entity catalogue (for network config dropdowns)
# ---------------------------------------------------------------------------

@app.get("/entities")
def get_entities(account_id: str = DUMMY_ACCOUNT_ID):
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            def q(sql, params):
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]

            acct = (account_id,)
            items     = q("SELECT item_id::text, item_code, item_description FROM items WHERE account_id = %s ORDER BY item_code", acct)
            stores    = q("SELECT store_id::text, store_code, store_name FROM stores WHERE account_id = %s ORDER BY store_code", acct)
            dcs       = q("SELECT dc_id::text, dc_code, dc_name FROM distribution_centers WHERE account_id = %s ORDER BY dc_code", acct)
            suppliers = q("SELECT supplier_id::text, supplier_code, supplier_name FROM suppliers WHERE account_id = %s ORDER BY supplier_code", acct)

            return {"items": items, "stores": stores, "dcs": dcs, "suppliers": suppliers}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Network mappings — read
# ---------------------------------------------------------------------------

@app.get("/mappings")
def get_mappings(account_id: str = DUMMY_ACCOUNT_ID):
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            def q(sql, params):
                cur.execute(sql, params)
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()]

            acct = (account_id,)

            store_items = q(
                "SELECT si.store_id::text, si.item_id::text "
                "FROM store_items si JOIN stores s ON si.store_id = s.store_id "
                "WHERE s.account_id = %s", acct,
            )
            dc_items = q(
                "SELECT di.dc_id::text, di.item_id::text "
                "FROM dc_items di JOIN distribution_centers dc ON di.dc_id = dc.dc_id "
                "WHERE dc.account_id = %s", acct,
            )
            supplier_items = q(
                "SELECT si.supplier_id::text, si.item_id::text "
                "FROM supplier_items si JOIN suppliers s ON si.supplier_id = s.supplier_id "
                "WHERE s.account_id = %s", acct,
            )
            store_mappings = q(
                "SELECT sm.from_store_id::text, sm.to_dc_id::text, sm.mapping_type "
                "FROM store_mappings sm JOIN stores s ON sm.from_store_id = s.store_id "
                "WHERE s.account_id = %s", acct,
            )
            dc_mappings = q(
                "SELECT dm.from_dc_id::text, dm.to_node_id::text, dm.mapping_type "
                "FROM dc_mappings dm JOIN distribution_centers dc ON dm.from_dc_id = dc.dc_id "
                "WHERE dc.account_id = %s", acct,
            )

            return {
                "store_items":    store_items,
                "dc_items":       dc_items,
                "supplier_items": supplier_items,
                "store_mappings": store_mappings,
                "dc_mappings":    dc_mappings,
            }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Network mappings — write (full replace per mapping type)
# ---------------------------------------------------------------------------

@app.post("/mappings")
def save_mappings(body: dict):
    account_id = body.get("account_id", DUMMY_ACCOUNT_ID)
    if not POSTGRES_DSN:
        raise HTTPException(status_code=503, detail="No POSTGRES_DSN configured")
    conn = _pg_connect()
    try:
        with conn.cursor() as cur:
            acct = (account_id,)

            # Delete all existing mappings for this account then re-insert
            cur.execute(
                "DELETE FROM store_items WHERE store_id IN "
                "(SELECT store_id FROM stores WHERE account_id = %s)", acct,
            )
            cur.execute(
                "DELETE FROM dc_items WHERE dc_id IN "
                "(SELECT dc_id FROM distribution_centers WHERE account_id = %s)", acct,
            )
            cur.execute(
                "DELETE FROM supplier_items WHERE supplier_id IN "
                "(SELECT supplier_id FROM suppliers WHERE account_id = %s)", acct,
            )
            cur.execute(
                "DELETE FROM store_mappings WHERE from_store_id IN "
                "(SELECT store_id FROM stores WHERE account_id = %s)", acct,
            )
            cur.execute(
                "DELETE FROM dc_mappings WHERE from_dc_id IN "
                "(SELECT dc_id FROM distribution_centers WHERE account_id = %s)", acct,
            )

            def bulk_insert(table: str, cols: list[str], rows: list[dict]):
                if not rows:
                    return
                placeholders = ", ".join([f"({', '.join(['%s'] * len(cols))})"] * len(rows))
                values = [row[c] for row in rows for c in cols]
                cur.execute(
                    f"INSERT INTO {table} ({', '.join(cols)}) VALUES {placeholders}",
                    values,
                )

            bulk_insert("store_items",    ["store_id", "item_id"],              body.get("store_items", []))
            bulk_insert("dc_items",       ["dc_id", "item_id"],                 body.get("dc_items", []))
            bulk_insert("supplier_items", ["supplier_id", "item_id"],           body.get("supplier_items", []))
            bulk_insert("store_mappings", ["from_store_id", "to_dc_id", "mapping_type"], body.get("store_mappings", []))
            bulk_insert("dc_mappings",    ["from_dc_id", "to_node_id", "mapping_type"],  body.get("dc_mappings", []))

        conn.commit()
        return {"status": "ok"}
    except Exception as exc:
        conn.rollback()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Simulation proxy
# ---------------------------------------------------------------------------

@app.post("/run")
async def run_simulation(req: dict):
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(f"{SIM_ENGINE_URL}/simulate", json=req)
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Simulation timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
