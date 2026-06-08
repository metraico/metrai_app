import json
import time
from datetime import date

import httpx
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

import api
from router import go_to
from utils.export import (
    _build_data_quality_report,
    _build_run_manifest,
    _build_zip,
    _prepare_export_dfs,
    show_error,
)


# =============================================================================
# Data loading helpers (cached in session_state)
# =============================================================================

def _ensure_entities(retailer_account_id):
    key = f"entities_{retailer_account_id}"
    if key not in st.session_state:
        try:
            st.session_state[key] = api.fetch_entities()
        except httpx.HTTPStatusError as e:
            show_error("Could not load entity catalogue", e, e.response)
            st.session_state[key] = {}
        except Exception as e:
            show_error("Could not load entity catalogue", e)
            st.session_state[key] = {}
    return st.session_state[key]




def _normalize_response(resp, *, config_block=None, sim_duration=None,
                        sim_start_date=None, sim_end_date=None,
                        store_target_wos=2):
    """Convert the engine response into the sim_results dict shape with proper dtypes."""
    sim_id = resp.get("simulation_id", "")

    weekly_pos_df = pd.DataFrame(resp.get("weekly_pos", []))
    weekly_shipments_df = pd.DataFrame(resp.get("weekly_shipments", []))
    supplier_dc_inv_df = pd.DataFrame(resp.get("supplier_dc_inventory", []))
    sales_hist_df = pd.DataFrame(resp.get("sales_history", []))
    store_inv_df = pd.DataFrame(resp.get("store_inventory", []))
    dc_inv_df = pd.DataFrame(resp.get("dc_inventory", []))
    sup_rec_df = pd.DataFrame(resp.get("supplier_receipts", []))
    str_rec_df = pd.DataFrame(resp.get("store_receipts", []))
    sup_orders_df = pd.DataFrame(resp.get("supplier_orders", []))
    sup_od_df = pd.DataFrame(resp.get("supplier_order_details", []))
    str_orders_df = pd.DataFrame(resp.get("store_orders", []))
    store_od_df = pd.DataFrame(resp.get("store_order_details", []))
    store_dc_map = resp.get("store_dc_map", {})
    items_df = pd.DataFrame(resp.get("items_meta", []))
    stores_df = pd.DataFrame(resp.get("stores_meta", []))
    dcs_df = pd.DataFrame(resp.get("dcs_meta", []))

    for col in ["demand_qty", "sales_qty", "lost_sales_qty", "sales_amount"]:
        if col in weekly_pos_df.columns:
            weekly_pos_df[col] = pd.to_numeric(weekly_pos_df[col], errors="coerce")
    if "is_promo_demand" in weekly_pos_df.columns:
        weekly_pos_df["is_promo_demand"] = weekly_pos_df["is_promo_demand"].map(
            lambda v: True if str(v) in ("1", "True", "true") else False
        )
    for col in ["ordered_qty", "shipped_qty", "fill_rate"]:
        if col in weekly_shipments_df.columns:
            weekly_shipments_df[col] = pd.to_numeric(weekly_shipments_df[col], errors="coerce")
    for col in ["sales_quantity", "sales_amount"]:
        if col in sales_hist_df.columns:
            sales_hist_df[col] = pd.to_numeric(sales_hist_df[col], errors="coerce")
    for col in ["on_hand_quantity", "on_order_quantity"]:
        if col in store_inv_df.columns:
            store_inv_df[col] = pd.to_numeric(store_inv_df[col], errors="coerce")
    for col in ["on_hand_quantity", "on_order_quantity"]:
        if col in supplier_dc_inv_df.columns:
            supplier_dc_inv_df[col] = pd.to_numeric(supplier_dc_inv_df[col], errors="coerce")

    # Derive start/end dates from weekly_pos if not provided (past runs)
    if sim_start_date is None or sim_end_date is None:
        if "pos_week" in weekly_pos_df.columns and not weekly_pos_df.empty:
            weeks_sorted = sorted(weekly_pos_df["pos_week"].unique())
            if sim_start_date is None and weeks_sorted:
                sim_start_date = date(int(weeks_sorted[0][:4]), 1, 1)
            if sim_end_date is None and weeks_sorted:
                sim_end_date = date(int(weeks_sorted[-1][:4]), 12, 31)
        else:
            sim_start_date = sim_start_date or date(2024, 1, 1)
            sim_end_date = sim_end_date or date(2026, 6, 30)

    return {
        "sim_id": sim_id,
        "sim_start_date": sim_start_date,
        "sim_end_date": sim_end_date,
        "sim_duration": sim_duration,
        "sim_config_block": config_block or {},
        "store_target_wos": store_target_wos,
        "items_df": items_df,
        "stores_df": stores_df,
        "weekly_pos_df": weekly_pos_df,
        "weekly_shipments_df": weekly_shipments_df,
        "supplier_dc_inv_df": supplier_dc_inv_df,
        "sales_hist_df": sales_hist_df,
        "store_inv_df": store_inv_df,
        "dc_inv_df": dc_inv_df,
        "sup_rec_df": sup_rec_df,
        "str_rec_df": str_rec_df,
        "sup_orders_df": sup_orders_df,
        "sup_od_df": sup_od_df,
        "str_orders_df": str_orders_df,
        "store_od_df": store_od_df,
        "store_dc_map": store_dc_map,
        "dcs_df": dcs_df,
    }




# =============================================================================
# Cached analytics loaders — keyed by (sim_id, item_id, store/dc id)
# =============================================================================

@st.cache_data(ttl=3600)
def _cached_store_sales(sim_id: str, item_id: str, store_id: str):
    try:
        return api.fetch_store_sales(sim_id, item_id=item_id, store_id=store_id)
    except Exception:
        return {}


@st.cache_data(ttl=3600)
def _cached_supply_chain_sales(sim_id: str, item_id: str):
    try:
        return api.fetch_supply_chain_sales(sim_id, item_id=item_id)
    except Exception:
        return {}


@st.cache_data(ttl=3600)
def _cached_store_inventory(sim_id: str, item_id: str, store_id: str):
    try:
        return api.fetch_store_inventory(sim_id, item_id=item_id, store_id=store_id)
    except Exception:
        return {}


@st.cache_data(ttl=3600)
def _cached_upstream_inventory(sim_id: str, item_id: str):
    try:
        return api.fetch_upstream_inventory(sim_id, item_id=item_id)
    except Exception:
        return {}


def _build_run_yaml_template(entities: dict) -> str:
    """Generate entity-first run config YAML with real codes and varied values."""
    import hashlib

    def _hash(code: str, lo: float, hi: float, step: float = 0.01) -> float:
        h = int(hashlib.md5(code.encode()).hexdigest(), 16)
        steps = int((hi - lo) / step)
        return round(lo + (h % (steps + 1)) * step, 2)

    def _hash_int(code: str, lo: int, hi: int) -> int:
        h = int(hashlib.md5(code.encode()).hexdigest(), 16)
        return lo + (h % (hi - lo + 1))

    suppliers = sorted(
        [d for d in (entities.get("dcs") or []) if d.get("dc_role") == "SUPPLIER_DC"],
        key=lambda d: d.get("dc_code", ""),
    )
    retailer_dcs = sorted(
        [d for d in (entities.get("dcs") or []) if d.get("dc_role") != "SUPPLIER_DC"],
        key=lambda d: d.get("dc_code", ""),
    )
    stores = sorted((entities.get("stores") or []), key=lambda s: s.get("store_code", ""))

    lines = [
        'run:',
        '  simulation_name: "My Simulation Run"',
        '  start_date: "2024-01-01"',
        '  end_date:   "2026-06-30"',
        '  seed: 42',
        '',
        '  store_target_wos:        2',
        '  retailer_dc_target_wos:  4',
        '  supplier_dc_initial_wos: 4',
    ]

    if suppliers:
        lines.append('')
        lines.append('  suppliers:')
        for s in suppliers:
            code = s.get("dc_code", "")
            on_time = _hash(code + "_ot", 0.88, 0.97)
            partial = _hash(code + "_pt", 0.03, 0.09)
            lead = _hash_int(code + "_lw", 1, 2)
            init_wos = _hash_int(code + "_iwos", 5, 8)
            lines.append(f'    {code}:')
            lines.append(f'      on_time:     {on_time}')
            lines.append(f'      partial:     {partial}')
            lines.append(f'      lead_weeks:  {lead}')
            lines.append(f'      initial_wos: {init_wos}')

    if retailer_dcs:
        lines.append('')
        lines.append('  dcs:')
        for d in retailer_dcs:
            code = d.get("dc_code", "")
            on_time = _hash(code + "_ot", 0.90, 0.97)
            partial = _hash(code + "_pt", 0.03, 0.07)
            lead = _hash_int(code + "_lw", 1, 2)
            wos = _hash_int(code + "_wos", 4, 6)
            init_wos = _hash_int(code + "_iwos", 4, 7)
            lines.append(f'    {code}:')
            lines.append(f'      on_time:             {on_time}')
            lines.append(f'      partial:             {partial}')
            lines.append(f'      lead_weeks_to_store: {lead}')
            lines.append(f'      target_wos:          {wos}')
            lines.append(f'      initial_wos:         {init_wos}')

    if stores:
        lines.append('')
        lines.append('  stores:')
        for s in stores:
            code = s.get("store_code", "")
            wos = _hash_int(code + "_wos", 2, 3)
            init_wos = _hash_int(code + "_iwos", 2, 4)
            lines.append(f'    {code}:')
            lines.append(f'      target_wos:  {wos}')
            lines.append(f'      initial_wos: {init_wos}')

    lines.append('')
    return '\n'.join(lines)


# Scenario-only YAML templates (no run: block — appended to run YAML at submit time)
_SCEN_TEMPLATES = {
    "promo_forecast": """\
# =============================================================================
# SCENARIO: Promo Forecast Behavior
# =============================================================================
# What this tests:
#   The system forecasts demand using the DB promo multiplier (e.g. 4x uplift).
#   You inject a gap between that forecast and actual shelf demand.
#   The trailing average then learns from the anomaly, distorting replenishment
#   in the weeks after the promo ends.
# =============================================================================

scenario:
  scenario_type: promo_forecast

  # List one entry per promo event you want to inject an anomaly into.
  promo_injections:
    - promo_name: "PEPSI_12PK_B2G2_SUPER_BOWL_2024"
      # promo_name must exactly match the name in the promos table.

      direction: over
      # direction: over (actual > forecast) or under (actual < forecast)

      magnitude_pct: 50
      # How far actual demand deviates from the forecast, in percent (1-200).
      # 50 -> actual = forecast x 1.50 (over) or x 0.50 (under)

      stores: all
      # Which stores: all  OR  [STR_W01, STR_E02]
""",
    "hidden_lost_sales": """\
# =============================================================================
# SCENARIO: Hidden Lost Sales
# =============================================================================
# What this tests:
#   DC deliveries to stores are disrupted for a defined window.
#   Suppressed sales corrupt the trailing average — causing under-ordering
#   in the weeks after deliveries resume.
#
# Disruption modes:
#   stockout — nothing ships (fulfillment_pct = 0)
#   outage   — partial fraction gets through (set fulfillment_pct 0-100)
#   delayed  — shipments deferred N days (set delay_days)
# =============================================================================

scenario:
  scenario_type: hidden_lost_sales

  disruptions:
    - dc: DC_EAST
      # dc must exactly match dc_code in distribution_centers table.

      items: all
      # items: all  OR  [2840016014, 1200080994]

      window_start: "2024-02-05"   # first affected day
      window_end:   "2024-02-11"   # last affected day (inclusive)

      mode: stockout
      # mode: stockout | outage | delayed
      # For outage: add   fulfillment_pct: 30
      # For delayed: add  delay_days: 5
""",
}


def _execute_yaml_run(yaml_text: str, retailer_account_id: str) -> bool:
    """POST yaml_text to /run/yaml (async), poll for completion, load meta. Returns True on success."""
    import yaml as _yaml
    from datetime import date as _date

    # ── Step 1: Submit simulation (returns immediately with simulation_id) ────
    try:
        resp = api.run_simulation_yaml(yaml_text)
    except httpx.ConnectError as exc:
        show_error(f"Cannot reach backend at {api.BACKEND_URL}", exc)
        return False
    except httpx.HTTPStatusError as exc:
        show_error("Simulation engine returned an error", exc, exc.response)
        return False
    except Exception as exc:
        show_error("Unexpected error", exc)
        return False

    sim_id = resp.get("simulation_id")
    if not sim_id:
        st.error("Simulation engine returned an empty response.")
        return False

    # ── Step 2: Poll until COMPLETED or FAILED ────────────────────────────────
    t0 = time.time()
    status_msg = st.empty()
    try:
        with st.spinner("Simulation running…"):
            while True:
                try:
                    cfg = api.fetch_simulation_status(sim_id)
                except Exception:
                    cfg = {}
                status = cfg.get("status", "RUNNING")
                elapsed = round(time.time() - t0)
                status_msg.caption(f"Status: **{status}** — {elapsed}s elapsed")
                if status == "COMPLETED":
                    break
                if status == "FAILED":
                    st.error(f"Simulation `{sim_id}` failed on the server. Check engine logs.")
                    return False
                time.sleep(3)
    finally:
        status_msg.empty()

    sim_duration = round(time.time() - t0, 1)

    # ── Step 3: Load entity metadata (items / stores / DCs) ──────────────────
    try:
        meta = api.fetch_sim_meta(sim_id)
    except Exception as exc:
        show_error("Could not load simulation metadata", exc)
        return False

    try:
        raw = _yaml.safe_load(yaml_text) or {}
        run_block = raw.get("run", {})
        sim_start     = _date.fromisoformat(str(run_block.get("start_date", "2024-01-01")))
        sim_end       = _date.fromisoformat(str(run_block.get("end_date",   "2026-06-30")))
        store_tgt_wos = int(run_block.get("store_target_wos", 2))
    except Exception:
        sim_start, sim_end, store_tgt_wos = (_date(2024, 1, 1), _date(2026, 6, 30), 2)

    st.session_state["sim_results"] = {
        "sim_id":          sim_id,
        "sim_start_date":  sim_start,
        "sim_end_date":    sim_end,
        "sim_duration":    sim_duration,
        "sim_config_block": {},
        "store_target_wos": store_tgt_wos,
        "items_df":        pd.DataFrame(meta.get("items_meta", [])),
        "stores_df":       pd.DataFrame(meta.get("stores_meta", [])),
        "dcs_df":          pd.DataFrame(meta.get("dcs_meta", [])),
        "store_dc_map":    meta.get("store_dc_map", {}),
        # analytics data loaded on-demand in _render_results
    }

    for k in ["_run_yaml_valid", "_show_scenario_step", "_wizard_scen_tile",
              "_wizard_scen_yaml", "_scen_yaml_valid", "_scenario_meta"]:
        st.session_state.pop(k, None)
    st.session_state.pop(f"runs_list_{retailer_account_id}", None)
    st.success(f"Simulation complete in {sim_duration}s. Run ID: `{sim_id}`")
    return True


def _render_new_simulation_wizard(retailer_account_id: str, entities: dict) -> bool:
    """3-step wizard: run config YAML → optional scenario → run."""
    import yaml as _yaml
    from datetime import date as _date

    st.markdown(
        "<style>textarea { font-family: 'Courier New', monospace !important;"
        " font-size: 13px !important; }</style>",
        unsafe_allow_html=True,
    )

    # ── Step 1: Run config YAML ───────────────────────────────────────────────
    st.subheader("Step 1 — Run Configuration")

    tpl_key = f"_run_yaml_tpl_{retailer_account_id}"
    if tpl_key not in st.session_state:
        try:
            st.session_state[tpl_key] = api.fetch_run_yaml_template()
        except Exception as e:
            show_error("Could not load YAML template", e)
            st.session_state[tpl_key] = _build_run_yaml_template(entities)

    yaml_text = st.text_area(
        "run_yaml",
        value=st.session_state.get("_run_yaml_text", st.session_state[tpl_key]),
        height=500,
        key="_run_yaml_ta",
        label_visibility="collapsed",
    )
    st.session_state["_run_yaml_text"] = yaml_text

    if st.button("Validate", key="_run_yaml_validate", use_container_width=False):
        st.session_state.pop("_run_yaml_valid", None)
        st.session_state.pop("_show_scenario_step", None)
        st.session_state.pop("_scen_yaml_valid", None)
        try:
            raw = _yaml.safe_load(yaml_text)
            if not isinstance(raw, dict) or not isinstance(raw.get("run"), dict):
                raise ValueError("YAML must contain a 'run:' block")
            run = raw["run"]
            s = _date.fromisoformat(str(run.get("start_date", "2024-01-01")))
            e = _date.fromisoformat(str(run.get("end_date", "2024-12-31")))
            if e <= s:
                raise ValueError("end_date must be after start_date")
            st.session_state["_run_yaml_valid"] = True
            st.success("Run config looks good — choose an option below.")
        except Exception as exc:
            st.error(str(exc))

    if not st.session_state.get("_run_yaml_valid"):
        return False

    # ── Step 2: Scenario decision ─────────────────────────────────────────────
    st.divider()
    st.subheader("Step 2 — Add a scenario? (optional)")
    col_run, col_scen = st.columns(2)

    with col_run:
        if st.button("▶ Run as-is", type="primary", use_container_width=True, key="_run_asis"):
            return _execute_yaml_run(yaml_text, retailer_account_id)

    with col_scen:
        if st.button("+ Add Scenario", use_container_width=True, key="_add_scen"):
            st.session_state["_show_scenario_step"] = True
            st.session_state.pop("_wizard_scen_tile", None)
            st.session_state.pop("_scen_yaml_valid", None)

    if not st.session_state.get("_show_scenario_step"):
        return False

    # ── Step 3: Scenario YAML ─────────────────────────────────────────────────
    st.divider()
    st.subheader("Step 3 — Configure Scenario")
    st.caption("Select a scenario type, edit the YAML, then validate before running.")

    tile_labels = {
        "promo_forecast":    "Promo Forecast Behavior",
        "hidden_lost_sales": "Hidden Lost Sales",
    }
    tc1, tc2 = st.columns(2)
    current_tile = st.session_state.get("_wizard_scen_tile")
    with tc1:
        if st.button(
            f"{'✓ ' if current_tile == 'promo_forecast' else ''}{tile_labels['promo_forecast']}",
            use_container_width=True,
            key="_tile_pf",
            type="primary" if current_tile == "promo_forecast" else "secondary",
        ):
            if current_tile != "promo_forecast":
                st.session_state["_wizard_scen_tile"] = "promo_forecast"
                st.session_state.pop("_wizard_scen_yaml", None)
                st.session_state.pop("_scen_yaml_valid", None)
    with tc2:
        if st.button(
            f"{'✓ ' if current_tile == 'hidden_lost_sales' else ''}{tile_labels['hidden_lost_sales']}",
            use_container_width=True,
            key="_tile_hls",
            type="primary" if current_tile == "hidden_lost_sales" else "secondary",
        ):
            if current_tile != "hidden_lost_sales":
                st.session_state["_wizard_scen_tile"] = "hidden_lost_sales"
                st.session_state.pop("_wizard_scen_yaml", None)
                st.session_state.pop("_scen_yaml_valid", None)

    selected_tile = st.session_state.get("_wizard_scen_tile")
    if not selected_tile:
        return False

    default_scen_yaml = _SCEN_TEMPLATES[selected_tile]
    scen_yaml_text = st.text_area(
        "scenario_yaml",
        value=st.session_state.get("_wizard_scen_yaml", default_scen_yaml),
        height=420,
        key=f"_scen_yaml_ta_{selected_tile}",
        label_visibility="collapsed",
    )
    st.session_state["_wizard_scen_yaml"] = scen_yaml_text

    sv_col, sr_col = st.columns(2)

    with sv_col:
        if st.button("Validate Scenario", key="_scen_validate", use_container_width=True):
            st.session_state.pop("_scen_yaml_valid", None)
            try:
                # Parse dates from run YAML for server-side validation
                raw_run = _yaml.safe_load(yaml_text) or {}
                run_b = raw_run.get("run", {})
                s_date = str(run_b.get("start_date", "2024-01-01"))
                e_date = str(run_b.get("end_date",   "2024-12-31"))
                # The engine's parse_scenario_yaml expects the scenario contents
                # at top level (scenario_type, promo_injections, etc.) — not wrapped
                # under a "scenario:" key. Extract the inner dict and dump that.
                raw_scen = _yaml.safe_load(scen_yaml_text) or {}
                scen_block = raw_scen.get("scenario") or raw_scen
                import yaml as _yaml_mod
                scen_only = _yaml_mod.dump(scen_block, default_flow_style=False)
                result = api.validate_scenario(
                    start_date=s_date, end_date=e_date, scenario_yaml=scen_only
                )
                if result.get("warnings"):
                    for w in result["warnings"]:
                        st.warning(w)
                st.session_state["_scen_yaml_valid"] = True
                st.success("Scenario looks good — click Run Simulation.")
                if result.get("preview"):
                    import pandas as _pd
                    st.dataframe(_pd.DataFrame(result["preview"]), use_container_width=True, hide_index=True)
            except Exception as exc:
                st.error(str(exc))

    scen_validated = st.session_state.get("_scen_yaml_valid", False)

    with sr_col:
        if st.button(
            "▶ Run Simulation",
            key="_scen_run",
            type="primary",
            use_container_width=True,
            disabled=not scen_validated,
        ):
            # Merge: run block from run YAML + scenario block from scenario YAML
            try:
                raw_run = _yaml.safe_load(yaml_text) or {}
                raw_scen = _yaml.safe_load(scen_yaml_text) or {}
                scen_block = raw_scen.get("scenario") or raw_scen
                import yaml as _yaml_mod
                combined = _yaml_mod.dump(
                    {"run": raw_run.get("run", {}), "scenario": scen_block},
                    default_flow_style=False, sort_keys=False,
                )
            except Exception as exc:
                st.error(f"Could not merge YAMLs: {exc}")
                return False
            return _execute_yaml_run(combined, retailer_account_id)

    return False


def _load_past_run(run_id):
    """Load a past simulation using analytics APIs — metadata only, charts load on demand."""
    with st.spinner(f"Loading run {run_id[:8]}…"):
        # Fetch saved config for dates / store_target_wos
        config_block = {}
        try:
            cfg_resp = api.fetch_run_config(run_id)
            config_block = cfg_resp.get("full_config") or {}
        except Exception as e:
            show_error("Could not load run config", e)
            return False

        # Fetch entity metadata via analytics API
        try:
            meta = api.fetch_sim_meta(run_id)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                st.error(f"Run `{run_id}` not found. It may need to be re-run.")
            elif e.response.status_code == 409:
                st.error(f"Run `{run_id}` has not completed yet.")
            else:
                show_error("Could not load past run", e, e.response)
            return False
        except Exception as e:
            show_error("Could not load past run", e)
            return False

    start_date_str = config_block.get("start_date")
    end_date_str   = config_block.get("end_date")
    sim_start = pd.to_datetime(start_date_str).date() if start_date_str else None
    sim_end   = pd.to_datetime(end_date_str).date()   if end_date_str   else None

    st.session_state["sim_results"] = {
        "sim_id":           run_id,
        "sim_start_date":   sim_start,
        "sim_end_date":     sim_end,
        "sim_duration":     None,
        "sim_config_block": config_block,
        "store_target_wos": int(config_block.get("store_target_wos", 2)),
        "items_df":         pd.DataFrame(meta.get("items_meta", [])),
        "stores_df":        pd.DataFrame(meta.get("stores_meta", [])),
        "dcs_df":           pd.DataFrame(meta.get("dcs_meta", [])),
        "store_dc_map":     meta.get("store_dc_map", {}),
        # No pre-loaded data frames — _render_results loads charts via analytics APIs on demand
    }
    return True


def _execute_rerun(run_id, retailer_account_id, user_id):
    """Fetch the saved config for `run_id` and POST /run with it (new sim_id)."""
    try:
        cfg_resp = api.fetch_run_config(run_id)
    except httpx.HTTPStatusError as e:
        show_error("Could not load saved config for rerun", e, e.response)
        return
    except Exception as e:
        show_error("Could not load saved config for rerun", e)
        return

    config_block = cfg_resp.get("full_config")
    if not config_block:
        st.error("This run has no saved config (older run). Use the form to set up a new simulation.")
        return

    # Ensure the rerun is attributed to the current user/account
    config_block = dict(config_block)
    config_block["retailer_account_id"] = retailer_account_id
    if user_id:
        config_block["created_by"] = user_id

    t0 = time.time()
    with st.spinner("Rerunning simulation with saved config…"):
        try:
            resp = api.run_simulation(config_block)
        except httpx.ConnectError as e:
            show_error(f"Cannot reach backend at {api.BACKEND_URL}", e)
            return
        except httpx.TimeoutException as e:
            show_error("Simulation request timed out", e)
            return
        except httpx.HTTPStatusError as e:
            show_error("Simulation engine returned an error", e, e.response)
            return
        except Exception as e:
            show_error("Unexpected error", e)
            return

    sim_duration = round(time.time() - t0, 1)
    sim_start = pd.to_datetime(config_block.get("start_date")).date() if config_block.get("start_date") else None
    sim_end = pd.to_datetime(config_block.get("end_date")).date() if config_block.get("end_date") else None

    st.session_state["sim_results"] = _normalize_response(
        resp,
        config_block=config_block,
        sim_duration=sim_duration,
        sim_start_date=sim_start,
        sim_end_date=sim_end,
        store_target_wos=int(config_block.get("store_target_wos", 2)),
    )
    new_sim_id = st.session_state["sim_results"]["sim_id"]
    st.session_state["_active_run_id"] = new_sim_id
    st.success(f"Rerun complete. New Run ID: `{new_sim_id}`")


# =============================================================================
# Tab 2 — Results section (KPIs, charts, tables, validation, export)
# =============================================================================

def _render_results():
    r = st.session_state.get("sim_results")
    if not r:
        st.info("Configure parameters above and click **▶ Run Simulation** to start.")
        return

    sim_id = r["sim_id"]
    start_date = r["sim_start_date"]
    end_date = r["sim_end_date"]
    items_df = r["items_df"]
    stores_df = r["stores_df"]
    store_dc_map = r["store_dc_map"]
    dcs_df = r.get("dcs_df", pd.DataFrame())
    sim_duration = r.get("sim_duration")
    sim_config_block = r.get("sim_config_block", {})
    store_target_wos = r.get("store_target_wos", 2)

    # Fallback DataFrames for past runs (loaded via _normalize_response / _load_past_run)
    weekly_pos_df = r.get("weekly_pos_df", pd.DataFrame())
    weekly_shipments_df = r.get("weekly_shipments_df", pd.DataFrame())
    supplier_dc_inv_df = r.get("supplier_dc_inv_df", pd.DataFrame())
    sales_hist_df = r.get("sales_hist_df", pd.DataFrame())
    store_inv_df = r.get("store_inv_df", pd.DataFrame())
    dc_inv_df = r.get("dc_inv_df", pd.DataFrame())
    sup_rec_df = r.get("sup_rec_df", pd.DataFrame())
    str_rec_df = r.get("str_rec_df", pd.DataFrame())
    sup_orders_df = r.get("sup_orders_df", pd.DataFrame())
    sup_od_df = r.get("sup_od_df", pd.DataFrame())
    str_orders_df = r.get("str_orders_df", pd.DataFrame())
    store_od_df = r.get("store_od_df", pd.DataFrame())

    scenario_meta = st.session_state.get("_scenario_meta")

    n_items = len(items_df)
    n_stores = len(stores_df)
    n_dcs = len(set(store_dc_map.values())) if store_dc_map else 0
    n_suppliers = len(dcs_df) if not dcs_df.empty else 0
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Items", n_items)
    m2.metric("Stores", n_stores)
    m3.metric("DCs", n_dcs)
    m4.metric("Suppliers", n_suppliers)

    if scenario_meta:
        stype = scenario_meta.get("type", "")
        if stype == "promo_forecast":
            windows = scenario_meta.get("promo_windows") or []
            if windows:
                promos_summary = "; ".join(
                    f"*{pw['promo_name']}* {pw['window_start']}→{pw['window_end']} ({pw['factor']:.2f}x)"
                    for pw in windows
                )
                st.info(
                    f"**Scenario: Promo Forecast Behavior** — {promos_summary}. "
                    f"System ordered for the forecast; shelf demand differed. "
                    f"Red shading = anomaly window."
                )
        elif stype == "hidden_lost_sales":
            disruptions = scenario_meta.get("disruptions") or []
            if disruptions:
                dc_summary = "; ".join(
                    f"DC *{d['dc']}* {d['window_start']}→{d['window_end']} ({d['mode']})"
                    for d in disruptions
                )
                st.info(
                    f"**Scenario: Hidden Lost Sales** — {dc_summary}. "
                    f"Suppressed deliveries corrupt the trailing average — "
                    f"watch for under-ordering in subsequent weeks. "
                    f"Red shading = disruption window."
                )

    if weekly_pos_df.empty and sales_hist_df.empty:
        st.warning("Simulation returned no sales data.")
        return

    # Pick whichever frame has store/item ids — prefer weekly_pos, then sales_history.
    # Build store/item selector lists.
    # For fresh runs (analytics flow), data frames are empty but metadata frames are populated.
    # For past runs, data frames are populated via _normalize_response.
    _selector_source = next(
        (df for df in (weekly_pos_df, sales_hist_df, store_inv_df)
         if not df.empty and {"store_id", "item_id"}.issubset(df.columns)),
        pd.DataFrame(),
    )

    st.divider()
    store_code_map = stores_df.set_index("store_id")["store_code"].to_dict() if not stores_df.empty else {}

    if not _selector_source.empty:
        stores_list = sorted(_selector_source["store_id"].unique().tolist())
        items_list  = sorted(_selector_source["item_id"].unique().tolist())
    else:
        # Analytics flow: derive from metadata DataFrames
        stores_list = sorted(stores_df["store_id"].astype(str).unique().tolist()) if not stores_df.empty else []
        items_list  = sorted(items_df["item_id"].astype(str).unique().tolist())   if not items_df.empty  else []

    stores_display = {store_code_map.get(sid, sid): sid for sid in stores_list}

    if "item_description" in items_df.columns:
        item_label_map = items_df.set_index("item_id").apply(
            lambda r: r["item_description"] if r.get("item_description") else r["item_code"], axis=1
        ).to_dict() if not items_df.empty else {}
    else:
        item_label_map = items_df.set_index("item_id")["item_code"].to_dict() if not items_df.empty else {}
    items_display = {item_label_map.get(iid, iid): iid for iid in items_list}

    if not stores_list or not items_list:
        st.warning("No store/item identifiers found in any of the result tables.")
        return

    col_sel1, col_sel2 = st.columns(2)
    sel_store_label = col_sel1.selectbox("Store", list(stores_display.keys()))
    sel_store = stores_display[sel_store_label]
    sel_item_label = col_sel2.selectbox("Item", list(items_display.keys()))
    sel_item = items_display[sel_item_label]

    # Load analytics data on-demand (cached per sim_id + selection).
    # For past runs the data frames are already populated; for fresh runs we fetch from analytics APIs.
    _use_analytics = weekly_pos_df.empty and sales_hist_df.empty
    if _use_analytics:
        with st.spinner("Loading chart data…"):
            _store_sales_data    = _cached_store_sales(sim_id, sel_item, sel_store)
            _sc_sales_data       = _cached_supply_chain_sales(sim_id, sel_item)
            _store_inv_data      = _cached_store_inventory(sim_id, sel_item, sel_store)
            _upstream_inv_data   = _cached_upstream_inventory(sim_id, sel_item)

        weekly_pos_df        = pd.DataFrame(_store_sales_data.get("weekly_pos", []))
        store_inv_df         = pd.DataFrame(_store_sales_data.get("store_inventory", []))
        weekly_shipments_df  = pd.DataFrame(_sc_sales_data.get("weekly_shipments", []))
        dc_inv_df            = pd.DataFrame(_upstream_inv_data.get("dc_inventory", []))
        supplier_dc_inv_df   = pd.DataFrame(_upstream_inv_data.get("supplier_dc_inventory", []))

        for col in ["demand_qty", "sales_qty", "lost_sales_qty", "sales_amount"]:
            if col in weekly_pos_df.columns:
                weekly_pos_df[col] = pd.to_numeric(weekly_pos_df[col], errors="coerce")
        if "is_promo_demand" in weekly_pos_df.columns:
            weekly_pos_df["is_promo_demand"] = weekly_pos_df["is_promo_demand"].map(
                lambda v: True if str(v) in ("1", "True", "true") else False
            )
        for col in ["ordered_qty", "shipped_qty", "fill_rate"]:
            if col in weekly_shipments_df.columns:
                weekly_shipments_df[col] = pd.to_numeric(weekly_shipments_df[col], errors="coerce")
        for col in ["on_hand_quantity", "on_order_quantity", "available_quantity"]:
            for df in (store_inv_df, dc_inv_df, supplier_dc_inv_df):
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors="coerce")

        # For analytics flow these are not available — set empty so debug tables degrade gracefully
        sales_hist_df = pd.DataFrame()
        sup_rec_df = str_rec_df = sup_orders_df = sup_od_df = str_orders_df = store_od_df = pd.DataFrame()

    # Build anomaly windows scoped to the selected store + item.
    # promo_forecast: each injection has item_ids + store_ids — only show red for matches.
    # hidden_lost_sales: show window for all stores (whole DC is disrupted).
    _active_promo_windows: list[tuple] = []
    scen_start_ts = scen_end_ts = None

    if scenario_meta:
        stype_m = scenario_meta.get("type", "")
        if stype_m == "promo_forecast":
            for pw in (scenario_meta.get("promo_windows") or []):
                item_ids  = pw.get("item_ids")  or []
                store_ids = pw.get("store_ids") or []
                if ((not item_ids)  or sel_item  in item_ids) and \
                   ((not store_ids) or sel_store in store_ids):
                    _active_promo_windows.append((
                        pd.Timestamp(pw["window_start"]),
                        pd.Timestamp(pw["window_end"]),
                    ))
        elif stype_m == "hidden_lost_sales":
            for d in (scenario_meta.get("disruptions") or []):
                _active_promo_windows.append((
                    pd.Timestamp(d["window_start"]),
                    pd.Timestamp(d["window_end"]),
                ))
        if _active_promo_windows:
            scen_start_ts = _active_promo_windows[0][0]
            scen_end_ts   = _active_promo_windows[0][1]

    _scen_active = bool(_active_promo_windows)

    # Filter dataframes for selection. Always sort by the time column afterwards —
    # Plotly draws scatter lines in array order, and dataframe filters preserve whatever
    # order the upstream gave us. Without an explicit sort the line zigzags.
    def _sort(df, col):
        return df.sort_values(col, kind="stable").reset_index(drop=True) if (not df.empty and col in df.columns) else df

    # For analytics flow, data is already filtered by sel_store/sel_item; skip redundant filter.
    s_weekly_pos = (
        weekly_pos_df.copy() if _use_analytics
        else weekly_pos_df[
            (weekly_pos_df["store_id"] == sel_store) & (weekly_pos_df["item_id"] == sel_item)
        ].copy()
    ) if not weekly_pos_df.empty else pd.DataFrame()
    s_weekly_pos = _sort(s_weekly_pos, "pos_week")

    s_shipments = (
        weekly_shipments_df.copy() if _use_analytics
        else weekly_shipments_df[weekly_shipments_df["item_id"] == sel_item].copy()
    ) if not weekly_shipments_df.empty else pd.DataFrame()
    s_shipments = _sort(s_shipments, "shipment_week")

    s_sales_w = sales_hist_df[
        (sales_hist_df["store_id"] == sel_store) & (sales_hist_df["item_id"] == sel_item)
    ].copy() if not sales_hist_df.empty else pd.DataFrame()
    s_sales_w = _sort(s_sales_w, "sales_week")

    s_inv_w = (
        store_inv_df.copy() if _use_analytics
        else store_inv_df[
            (store_inv_df["store_id"] == sel_store) & (store_inv_df["item_id"] == sel_item)
        ].copy()
    ) if not store_inv_df.empty else pd.DataFrame()
    s_inv_w = _sort(s_inv_w, "inventory_week" if "inventory_week" in s_inv_w.columns else "sales_week")

    # KPIs from weekly_pos
    if not s_weekly_pos.empty:
        total_demand  = s_weekly_pos["demand_qty"].sum() if "demand_qty" in s_weekly_pos.columns else 0
        total_sales   = s_weekly_pos["sales_qty"].sum()  if "sales_qty"  in s_weekly_pos.columns else 0
        total_lost    = s_weekly_pos["lost_sales_qty"].sum() if "lost_sales_qty" in s_weekly_pos.columns else 0
        total_revenue = s_weekly_pos["sales_amount"].sum()   if "sales_amount"   in s_weekly_pos.columns else 0
        fill_rate     = total_sales / total_demand * 100 if total_demand > 0 else 0
        total_demand_str  = f"{total_demand:,.0f}"
        total_sales_str   = f"{total_sales:,.0f}"
        total_lost_str    = f"{total_lost:,.0f}"
        fill_rate_str     = f"{fill_rate:.1f}%"
        total_revenue_str = f"${total_revenue:,.0f}"
    else:
        total_sales   = s_sales_w["sales_quantity"].sum() if not s_sales_w.empty else 0
        total_revenue = s_sales_w["sales_amount"].sum()   if not s_sales_w.empty else 0
        total_demand_str  = "—"
        total_sales_str   = f"{total_sales:,.0f}"
        total_lost_str    = "—"
        fill_rate_str     = "—"
        total_revenue_str = f"${total_revenue:,.0f}"

    k1, k2, k3, k4, k5 = st.columns(5)
    k1.metric("Total Demand", total_demand_str)
    k2.metric("Total Sales",  total_sales_str)
    k3.metric("Lost Sales",   total_lost_str)
    k4.metric("Fill Rate",    fill_rate_str)
    k5.metric("Revenue",      total_revenue_str)

    # Promo weeks from weekly_pos
    promo_weeks = set()
    if not s_weekly_pos.empty and "is_promo_demand" in s_weekly_pos.columns and "pos_week" in s_weekly_pos.columns:
        promo_weeks = set(s_weekly_pos[s_weekly_pos["is_promo_demand"] == True]["pos_week"].unique())

    def _overlaps_any_anomaly(x0, x1):
        """True if date range overlaps with any scenario anomaly window."""
        for ws, we in _active_promo_windows:
            if x0 <= we + pd.Timedelta(days=1) and x1 >= ws:
                return True
        return False

    def _add_promo_weekly(fig, weeks_list):
        added_promo = added_anom = False
        anom_weeks: set = set()
        stype_w = (scenario_meta or {}).get("type", "")
        for ws, we in _active_promo_windows:
            d = ws.date()
            end = we.date()
            while d <= end:
                iso = d.isocalendar()
                anom_weeks.add(f"{iso[0]}-W{iso[1]:02d}")
                d += pd.Timedelta(days=1).to_pytimedelta()
        # promo_forecast: only mark weeks where this item actually has promo demand
        if stype_w == "promo_forecast":
            anom_weeks = anom_weeks & promo_weeks
        for i, w in enumerate(weeks_list):
            if w in anom_weeks:
                fig.add_vrect(
                    x0=i - 0.5, x1=i + 0.5,
                    fillcolor="rgba(220,30,30,0.35)", layer="below",
                    line_color="rgba(255,60,60,0.9)", line_width=1,
                    name="Anomaly Week" if not added_anom else None,
                    showlegend=not added_anom, legendgroup="anom_w",
                )
                added_anom = True
            elif w in promo_weeks:
                fig.add_vrect(
                    x0=i - 0.5, x1=i + 0.5,
                    fillcolor="rgba(255,180,0,0.22)", layer="below", line_width=0,
                    name="Promo Week" if not added_promo else None,
                    showlegend=not added_promo, legendgroup="promo_w",
                )
                added_promo = True

    # Weekly POS chart
    st.divider()
    st.subheader("Inventory & Sales Charts")
    st.markdown("#### Weekly POS: Demand vs Sales vs Store Inventory")
    fig_weekly = go.Figure()
    if not s_weekly_pos.empty:
        weeks_list = sorted(s_weekly_pos["pos_week"].unique().tolist())
        if not s_inv_w.empty:
            inv_w_key = "inventory_week" if "inventory_week" in s_inv_w.columns else "sales_week"
            weekly_df = s_weekly_pos.merge(
                s_inv_w[[inv_w_key, "on_hand_quantity"]].rename(columns={inv_w_key: "pos_week"}),
                on="pos_week", how="left",
            )
        else:
            weekly_df = s_weekly_pos.copy()
            weekly_df["on_hand_quantity"] = 0

        if "demand_qty" in weekly_df.columns:
            fig_weekly.add_trace(go.Bar(
                x=weekly_df["pos_week"], y=weekly_df["demand_qty"],
                name="Demand", marker_color="#BAD7F2", opacity=0.85,
            ))
        if "sales_qty" in weekly_df.columns:
            fig_weekly.add_trace(go.Bar(
                x=weekly_df["pos_week"], y=weekly_df["sales_qty"],
                name="Sales", marker_color="#2E86AB", opacity=0.9,
            ))
        if "lost_sales_qty" in weekly_df.columns:
            fig_weekly.add_trace(go.Bar(
                x=weekly_df["pos_week"], y=weekly_df["lost_sales_qty"],
                name="Lost Sales", marker_color="#F1948A", opacity=0.9,
            ))
        if "on_hand_quantity" in weekly_df.columns:
            fig_weekly.add_trace(go.Scatter(
                x=weekly_df["pos_week"], y=weekly_df["on_hand_quantity"],
                name="On-Hand (EOW)", mode="lines+markers",
                line=dict(color="#F4A261", width=2), yaxis="y2",
            ))
        _add_promo_weekly(fig_weekly, weeks_list)
    fig_weekly.update_layout(
        barmode="group",
        xaxis=dict(title="Week", tickangle=-45),
        yaxis=dict(title="Units (Demand / Sales)", side="left"),
        yaxis2=dict(title="Units (Store Inventory EOW)", overlaying="y", side="right", showgrid=False),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        height=420,
    )
    st.plotly_chart(fig_weekly, use_container_width=True)

    # Weekly Shipments chart (Supplier DC → Retailer DC)
    st.markdown("#### Weekly Shipments: Supplier DC → Retailer DC")
    fig_ship = go.Figure()
    if not s_shipments.empty and "shipment_week" in s_shipments.columns:
        ship_weeks = sorted(s_shipments["shipment_week"].unique().tolist())
        agg_ship = s_shipments.groupby("shipment_week", sort=True).agg(
            ordered_qty=("ordered_qty", "sum"),
            shipped_qty=("shipped_qty", "sum"),
        ).reset_index()
        fig_ship.add_trace(go.Bar(
            x=agg_ship["shipment_week"], y=agg_ship["ordered_qty"],
            name="Ordered", marker_color="#BAD7F2", opacity=0.85,
        ))
        fig_ship.add_trace(go.Bar(
            x=agg_ship["shipment_week"], y=agg_ship["shipped_qty"],
            name="Shipped", marker_color="#2E86AB", opacity=0.9,
        ))
        if len(agg_ship) > 0:
            fill_rates = (agg_ship["shipped_qty"] / agg_ship["ordered_qty"].replace(0, float("nan"))) * 100
            fig_ship.add_trace(go.Scatter(
                x=agg_ship["shipment_week"], y=fill_rates,
                name="Fill Rate %", mode="lines+markers",
                line=dict(color="#E84855", width=2), yaxis="y2",
            ))
    fig_ship.update_layout(
        barmode="group",
        xaxis=dict(title="Week", tickangle=-45),
        yaxis=dict(title="Units", side="left"),
        yaxis2=dict(title="Fill Rate %", overlaying="y", side="right", showgrid=False, range=[0, 110]),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        height=380,
    )
    st.plotly_chart(fig_ship, use_container_width=True)

    # Store Inventory chart
    st.markdown("#### Weekly Store Inventory: On-Hand vs On-Order")
    fig_store_inv = go.Figure()
    _s_inv_chart = s_inv_w if not s_inv_w.empty else (
        store_inv_df[
            (store_inv_df["store_id"] == sel_store) & (store_inv_df["item_id"] == sel_item)
        ] if not store_inv_df.empty else pd.DataFrame()
    )
    if not _s_inv_chart.empty and "inventory_week" in _s_inv_chart.columns:
        _s_inv_chart = _sort(_s_inv_chart, "inventory_week")
        if "on_hand_quantity" in _s_inv_chart.columns:
            fig_store_inv.add_trace(go.Bar(
                x=_s_inv_chart["inventory_week"], y=_s_inv_chart["on_hand_quantity"],
                name="On-Hand", marker_color="#BAD7F2", opacity=0.9,
            ))
        if "on_order_quantity" in _s_inv_chart.columns:
            fig_store_inv.add_trace(go.Bar(
                x=_s_inv_chart["inventory_week"], y=_s_inv_chart["on_order_quantity"],
                name="On-Order", marker_color="#2E86AB", opacity=0.85,
            ))
    fig_store_inv.update_layout(
        barmode="group",
        xaxis=dict(title="Week", tickangle=-45),
        yaxis=dict(title="Units"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        height=360,
    )
    st.plotly_chart(fig_store_inv, use_container_width=True)

    # Upstream Inventory chart (DC + Supplier DC)
    st.markdown("#### Upstream Inventory: Retailer DC & Supplier DC")
    fig_up_inv = go.Figure()
    _dc_chart = (
        dc_inv_df.copy() if _use_analytics
        else dc_inv_df[dc_inv_df["item_id"] == sel_item].copy()
    ) if not dc_inv_df.empty else pd.DataFrame()
    _sup_dc_chart = (
        supplier_dc_inv_df.copy() if _use_analytics
        else supplier_dc_inv_df[supplier_dc_inv_df["item_id"] == sel_item].copy()
    ) if not supplier_dc_inv_df.empty else pd.DataFrame()

    if not _dc_chart.empty and "inventory_week" in _dc_chart.columns:
        _dc_agg = _dc_chart.groupby("inventory_week", sort=True).agg(
            on_hand=("on_hand_quantity", "sum"),
            on_order=("on_order_quantity", "sum"),
        ).reset_index()
        fig_up_inv.add_trace(go.Bar(
            x=_dc_agg["inventory_week"], y=_dc_agg["on_hand"],
            name="DC On-Hand", marker_color="#6DB65B", opacity=0.9,
        ))
        fig_up_inv.add_trace(go.Bar(
            x=_dc_agg["inventory_week"], y=_dc_agg["on_order"],
            name="DC On-Order", marker_color="#3B7A57", opacity=0.75,
        ))
    if not _sup_dc_chart.empty and "inventory_week" in _sup_dc_chart.columns:
        _sup_agg = _sup_dc_chart.groupby("inventory_week", sort=True).agg(
            on_hand=("on_hand_quantity", "sum"),
            on_order=("on_order_quantity", "sum"),
        ).reset_index()
        fig_up_inv.add_trace(go.Bar(
            x=_sup_agg["inventory_week"], y=_sup_agg["on_hand"],
            name="Supplier DC On-Hand", marker_color="#F4A261", opacity=0.9,
        ))
        fig_up_inv.add_trace(go.Bar(
            x=_sup_agg["inventory_week"], y=_sup_agg["on_order"],
            name="Supplier DC On-Order", marker_color="#C96B1A", opacity=0.75,
        ))
    fig_up_inv.update_layout(
        barmode="group",
        xaxis=dict(title="Week", tickangle=-45),
        yaxis=dict(title="Units"),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        height=400,
    )
    st.plotly_chart(fig_up_inv, use_container_width=True)

    # Raw output tables
    all_dfs = _prepare_export_dfs(
        filter_store=None, filter_item=None,
        items_df=items_df, stores_df=stores_df, dcs_df=dcs_df, dc_inv_df=dc_inv_df,
        sup_orders_df=sup_orders_df, sup_od_df=sup_od_df, sup_rec_df=sup_rec_df,
        str_orders_df=str_orders_df, store_od_df=store_od_df, str_rec_df=str_rec_df,
        sales_hist_df=sales_hist_df, store_inv_df=store_inv_df,
        weekly_pos_df=weekly_pos_df, weekly_shipments_df=weekly_shipments_df,
        supplier_dc_inv_df=supplier_dc_inv_df,
        store_dc_map=store_dc_map, start_date=start_date, end_date=end_date,
    )
    dq_report = _build_data_quality_report(
        store_inv_df, dc_inv_df, sales_hist_df, weekly_pos_df,
        sup_orders_df, sup_od_df, str_orders_df, store_od_df,
        sim_duration_seconds=sim_duration,
    )
    manifest = _build_run_manifest(
        sim_id=sim_id, config_block=sim_config_block,
        export_dfs=all_dfs, validation_passed=dq_report["validation_passed"],
    )
    extra_files = {
        "run_manifest.json": json.dumps(manifest, indent=2),
        "data_quality_report.json": json.dumps(dq_report, indent=2),
    }

    # ── Scenario audit expanders (after charts) ───────────────────────────────
    _scenario_yaml = sim_config_block.get("scenario_yaml", "").strip()
    if _scenario_yaml:
        # Full YAML: prefer session-saved original (has run: block + comments),
        # fall back to reconstructing from stored config fields
        _full_yaml_key = f"_full_yaml_{r['sim_id']}"
        _full_yaml = st.session_state.get(_full_yaml_key)
        if not _full_yaml:
            import yaml as _yaml_mod
            _run_fields = [
                "simulation_name", "start_date", "end_date", "seed",
                "store_target_wos", "store_reorder_wos",
                "retailer_dc_target_wos", "retailer_dc_reorder_wos", "supplier_dc_initial_wos",
                "smoothing_weeks",
                "supplier_dc_to_retailer_dc_lead_weeks", "retailer_dc_to_store_lead_weeks",
                "sup_on_time", "sup_partial", "dc_on_time", "dc_partial",
                "dc_on_time_by_dc", "dc_partial_by_dc",
                "retailer_dc_target_wos_by_dc", "store_target_wos_by_store",
            ]
            _run_block = {k: sim_config_block[k] for k in _run_fields if k in sim_config_block}
            try:
                _scen_block = _yaml_mod.safe_load(_scenario_yaml) or {}
            except Exception:
                _scen_block = {}
            _full_yaml = _yaml_mod.dump(
                {"run": _run_block, "scenario": _scen_block},
                default_flow_style=False, sort_keys=False,
            )

        with st.expander("Scenario YAML", expanded=False):
            st.code(_full_yaml, language="yaml")

        _preview_key = f"_scen_preview_{r['sim_id']}"
        if _preview_key not in st.session_state:
            try:
                _vr = api.validate_scenario(
                    start_date=sim_config_block.get("start_date", "2024-01-01"),
                    end_date=sim_config_block.get("end_date", "2024-12-31"),
                    scenario_yaml=_scenario_yaml,
                )
                st.session_state[_preview_key] = _vr
            except Exception:
                st.session_state[_preview_key] = None

        _vr = st.session_state.get(_preview_key)
        if _vr and _vr.get("preview"):
            with st.expander("Scenario Configuration Preview", expanded=False):
                if _vr.get("warnings"):
                    for _w in _vr["warnings"]:
                        st.warning(_w)
                st.dataframe(
                    pd.DataFrame(_vr["preview"]),
                    use_container_width=True,
                    hide_index=True,
                )

    st.divider()
    tab_export, tab_debug = st.tabs(["Export", "Debugging"])

    with tab_debug:
        st.subheader(f"Raw Output Tables — {sel_store_label} / {sel_item_label}")

        with st.expander("Weekly POS"):
            st.dataframe(s_weekly_pos.reset_index(drop=True))
        with st.expander("Weekly Shipments (Supplier DC → Retailer DC)"):
            st.dataframe(s_shipments.reset_index(drop=True))
        with st.expander("Weekly Store Inventory"):
            st.dataframe(s_inv_w.reset_index(drop=True))
        with st.expander("Supplier DC Inventory"):
            st.dataframe(supplier_dc_inv_df[supplier_dc_inv_df["item_id"] == sel_item].reset_index(drop=True) if not supplier_dc_inv_df.empty and "item_id" in supplier_dc_inv_df.columns else pd.DataFrame())
        with st.expander("Weekly Sales History"):
            st.dataframe(s_sales_w.reset_index(drop=True))

        def _has(df, *cols):
            return not df.empty and all(c in df.columns for c in cols)

        if _has(str_rec_df, "store_id", "item_id"):
            with st.expander("Store Receipts"):
                st.dataframe(str_rec_df[(str_rec_df["store_id"] == sel_store) & (str_rec_df["item_id"] == sel_item)].reset_index(drop=True))
        if _has(store_od_df, "store_id", "item_id"):
            with st.expander("Store Order Details"):
                st.dataframe(store_od_df[(store_od_df["store_id"] == sel_store) & (store_od_df["item_id"] == sel_item)].reset_index(drop=True))
        if _has(str_orders_df, "store_id"):
            with st.expander("Store Orders (header)"):
                st.dataframe(str_orders_df[str_orders_df["store_id"] == sel_store].reset_index(drop=True))
        if _has(sup_rec_df, "item_id"):
            with st.expander("Supplier Receipts"):
                st.dataframe(sup_rec_df[sup_rec_df["item_id"] == sel_item].reset_index(drop=True))
        if _has(sup_orders_df, "dc_id"):
            with st.expander("Supplier Orders (for DC serving this store)"):
                sel_dc = store_dc_map.get(sel_store)
                st.dataframe((sup_orders_df[sup_orders_df["dc_id"] == sel_dc] if sel_dc else sup_orders_df).reset_index(drop=True))
        if _has(sup_od_df, "item_id"):
            with st.expander("Supplier Order Details"):
                st.dataframe(sup_od_df[sup_od_df["item_id"] == sel_item].reset_index(drop=True))
        if _has(dc_inv_df, "dc_id", "item_id"):
            with st.expander("DC Inventory (Weekly)"):
                sel_dc = store_dc_map.get(sel_store)
                st.dataframe((dc_inv_df[(dc_inv_df["dc_id"] == sel_dc) & (dc_inv_df["item_id"] == sel_item)] if sel_dc else dc_inv_df).reset_index(drop=True))

        with st.expander("run_manifest.json"):
            st.code(extra_files["run_manifest.json"], language="json")
        with st.expander("data_quality_report.json"):
            st.code(extra_files["data_quality_report.json"], language="json")

    with tab_export:
        st.subheader("Output Data Feeds")

        sel_store_code_series = stores_df.loc[stores_df["store_id"] == sel_store, "store_code"]
        sel_store_code = sel_store_code_series.iloc[0] if not sel_store_code_series.empty else sel_store

        feed_mode = st.radio(
            "View / download",
            [f"Filtered — {sel_store_code} / {sel_item_label}", "All Stores & Items"],
            horizontal=True, key="feed_mode",
        )
        filtered_mode = feed_mode.startswith("Filtered")
        fs = sel_store if filtered_mode else None
        fi = sel_item if filtered_mode else None

        export_dfs = _prepare_export_dfs(
            filter_store=fs, filter_item=fi,
            items_df=items_df, stores_df=stores_df, dcs_df=dcs_df, dc_inv_df=dc_inv_df,
            sup_orders_df=sup_orders_df, sup_od_df=sup_od_df, sup_rec_df=sup_rec_df,
            str_orders_df=str_orders_df, store_od_df=store_od_df, str_rec_df=str_rec_df,
            sales_hist_df=sales_hist_df, store_inv_df=store_inv_df,
            weekly_pos_df=weekly_pos_df, weekly_shipments_df=weekly_shipments_df,
            supplier_dc_inv_df=supplier_dc_inv_df,
            store_dc_map=store_dc_map, start_date=start_date, end_date=end_date,
        )

        for fname, df in export_dfs.items():
            with st.expander(fname.replace(".csv", ""), expanded=False):
                st.dataframe(df, use_container_width=True)

        st.markdown("#### Download")
        dl_col1, dl_col2 = st.columns(2)
        with dl_col1:
            zip_filtered = _build_zip(
                _prepare_export_dfs(
                    filter_store=sel_store, filter_item=sel_item,
                    items_df=items_df, stores_df=stores_df, dcs_df=dcs_df, dc_inv_df=dc_inv_df,
                    sup_orders_df=sup_orders_df, sup_od_df=sup_od_df, sup_rec_df=sup_rec_df,
                    str_orders_df=str_orders_df, store_od_df=store_od_df, str_rec_df=str_rec_df,
                    sales_hist_df=sales_hist_df, store_inv_df=store_inv_df,
                    weekly_pos_df=weekly_pos_df, weekly_shipments_df=weekly_shipments_df,
                    supplier_dc_inv_df=supplier_dc_inv_df,
                    store_dc_map=store_dc_map, start_date=start_date, end_date=end_date,
                ),
                extra_files=extra_files,
            )
            st.download_button(
                label=f"⬇ Download filtered ({sel_store_code} / {sel_item_label})",
                data=zip_filtered,
                file_name=f"metrai_export_{sel_store_code}_{sel_item_label}.zip",
                mime="application/zip", use_container_width=True,
            )
        with dl_col2:
            zip_all = _build_zip(all_dfs, extra_files=extra_files)
            st.download_button(
                label="⬇ Download all data",
                data=zip_all, file_name="metrai_export_all.zip",
                mime="application/zip", use_container_width=True,
            )


# =============================================================================
# Page entry
# =============================================================================

def _restore_scenario_meta_from_config(run_id: str, retailer_account_id: str):
    """Rebuild _scenario_meta from stored run config so highlights work on past runs."""
    import re as _re
    try:
        cfg_resp   = api.fetch_run_config(run_id)
        full_cfg   = cfg_resp.get("full_config") or {}
        notes      = full_cfg.get("notes", "")
        yaml_text  = full_cfg.get("scenario_yaml", "").strip()

        # ── YAML scenario (new path) — re-validate to get promo_windows ──────
        if yaml_text:
            try:
                result = api.validate_scenario(
                    start_date=full_cfg.get("start_date", "2024-01-01"),
                    end_date=full_cfg.get("end_date", "2024-12-31"),
                    scenario_yaml=yaml_text,
                )
                stype = result.get("scenario_type", "")
                if stype == "promo_forecast":
                    st.session_state["_scenario_meta"] = {
                        "type": "promo_forecast",
                        "promo_windows": [
                            {
                                "promo_id":     pw.get("promo_id", ""),
                                "promo_name":   pw.get("promo_name", ""),
                                "window_start": pw.get("window_start", ""),
                                "window_end":   pw.get("window_end", ""),
                                "factor":       pw.get("factor", 1.0),
                                "item_ids":     pw.get("item_ids", []),
                                "store_ids":    pw.get("store_ids", []),
                            }
                            for pw in result.get("promo_windows", [])
                        ],
                    }
                elif stype == "hidden_lost_sales":
                    disruptions = result.get("disruptions", [])
                    if disruptions:
                        st.session_state["_scenario_meta"] = {
                            "type":        "hidden_lost_sales",
                            "disruptions": [
                                {
                                    "dc":           d.get("dc", ""),
                                    "window_start": d.get("window_start", ""),
                                    "window_end":   d.get("window_end", ""),
                                    "mode":         d.get("mode", ""),
                                }
                                for d in disruptions
                            ],
                        }
            except Exception:
                pass
            return

        # ── Legacy scalar scenario (old form-based path) ──────────────────────
        if not notes:
            return
        m_type = _re.search(r"\[SCENARIO:(\w+)\]", notes)
        if not m_type:
            return
        stype = m_type.group(1)

        if stype == "hidden_lost_sales":
            ms = _re.search(r"shortage_start=([\d-]+)", notes)
            me = _re.search(r"shortage_end=([\d-]+)", notes)
            mf = _re.search(r"shortage_factor=([\d.]+)", notes)
            if not ms or not me:
                return
            sf = float(mf.group(1)) if mf else 0.0
            st.session_state["_scenario_meta"] = {
                "type":         "hidden_lost_sales",
                "start_date":   ms.group(1),
                "end_date":     me.group(1),
                "shortage_pct": round((1.0 - sf) * 100),
            }
            return

        m = _re.search(r"promo_id=([\w-]+).*?factor=([\d.]+)", notes)
        if not m:
            return
        promo_id, factor = m.group(1), float(m.group(2))
        promos = api.fetch_promos()
        promo  = next((p for p in promos if p["promo_id"] == promo_id), None)
        if not promo:
            return
        st.session_state["_scenario_meta"] = {
            "type":       stype,
            "promo_name": promo["promo_name"],
            "promo_id":   promo_id,
            "factor":     factor,
            "start_date": promo["start_date"],
            "end_date":   promo["end_date"],
        }
    except Exception:
        pass


def render():
    retailer_account_id = st.query_params.get("retailer_account_id") or st.session_state.get("retailer_account_id")
    user_id = st.session_state.get("user_id")
    run_id = st.query_params.get("run_id")

    if not retailer_account_id:
        st.error("No account in session. Please sign in again.")
        return

    # Auto-load a past run if needed.
    # Skip when sim_results is already populated with this run's fresh response
    # (e.g. just returned from the scenario wizard — live response has realized_demand_qty).
    active = st.session_state.get("_active_run_id")
    already_fresh = st.session_state.get("sim_results", {}).get("sim_id") == run_id
    if run_id and active != run_id and not already_fresh:
        loaded = _load_past_run(run_id)
        if loaded:
            st.session_state["_active_run_id"] = run_id
            _restore_scenario_meta_from_config(run_id, retailer_account_id)
    elif run_id and already_fresh:
        st.session_state["_active_run_id"] = run_id

    # Header
    sim_results = st.session_state.get("sim_results")

    if run_id and sim_results:
        col_back, col_title, col_rerun, col_new = st.columns([1, 4, 2, 2])
        if col_back.button("← Back"):
            st.session_state.pop("_active_run_id", None)
            go_to("runs", id=retailer_account_id)
        col_title.subheader("Simulation Run")
        col_title.caption(f"Run: `{run_id}`")
        if col_rerun.button("↻ Rerun this configuration", type="primary", use_container_width=True):
            _execute_rerun(run_id, retailer_account_id, user_id)
            st.session_state.pop(f"runs_list_{retailer_account_id}", None)
            st.rerun()
        if col_new.button("+ New Simulation", use_container_width=True):
            st.session_state.pop("sim_results", None)
            st.session_state.pop("_active_run_id", None)
            st.session_state.pop(f"_run_yaml_tpl_{retailer_account_id}", None)
            st.session_state.pop("_run_yaml_text", None)
            go_to("simulation", retailer_account_id=retailer_account_id)
        _render_results()
        return

    col_back, col_title = st.columns([1, 5])
    if col_back.button("← Back to runs"):
        st.session_state.pop("_active_run_id", None)
        go_to("runs", id=retailer_account_id)
    if run_id:
        col_title.title("Simulation Run")
    else:
        col_title.title("New Simulation")

    entities = _ensure_entities(retailer_account_id) or {}

    if not run_id:
        n_items     = len(entities.get("items", []))
        n_stores    = len(entities.get("stores", []))
        n_dcs       = len([d for d in entities.get("dcs", []) if d.get("dc_role") != "SUPPLIER_DC"])
        n_suppliers = len(entities.get("suppliers", []))
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Items",     n_items)
        c2.metric("Stores",    n_stores)
        c3.metric("DCs",       n_dcs)
        c4.metric("Suppliers", n_suppliers)

    st.divider()
    _render_new_simulation_wizard(retailer_account_id, entities)

    _render_results()
