import json
import re
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


# =============================================================================
# Run Simulation form
# =============================================================================

def _render_config_form(retailer_account_id, user_id):
    """Render the simulation config form. Returns (run_btn, config_dict)."""
    with st.container(border=True):
        st.subheader("Simulation Config")

        col_l, col_r = st.columns(2)

        with col_l:
            sim_name = st.text_input("Simulation Name", value="Default Run")
            sim_notes = st.text_area("Notes", value="", height=80)
            start_date = st.date_input("Start Date", value=date(2024, 1, 1))
            end_date = st.date_input("End Date", value=date(2024, 12, 31))
            replenishment_policy = st.selectbox(
                "Replenishment Policy",
                ["trailing_avg_28d", "promo_aware_7d", "baseline_only"],
                index=0,
            )
            policy_match = re.search(r"(\d+)d", replenishment_policy)
            default_smoothing = int(policy_match.group(1)) if policy_match else 28
            smoothing_days = st.number_input(
                "Demand Smoothing Window (days)",
                min_value=7, max_value=90, value=default_smoothing,
            )
            seed = st.number_input("Random Seed", min_value=0, value=42)

        with col_r:
            with st.expander("Store Config"):
                store_reorder_weeks = st.slider("Min Inventory Trigger (weeks of cover)", 1, 4, 2)
                store_target_weeks = st.slider("Store Target Stock (weeks)", 1, 8, 3)
                store_start_days = st.number_input("Starting Inventory (days)", 1, 60, 14)
                store_order_dow = st.selectbox(
                    "Store Order Day",
                    ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
                    index=0,
                )

            with st.expander("DC Config"):
                dc_reorder_weeks = st.slider("DC Min Inventory Trigger (weeks)", 1, 6, 2)
                dc_target_weeks = st.slider("DC Target Stock (weeks)", 2, 12, 5)
                dc_start_days = st.number_input("DC Starting Inventory (days)", 1, 90, 30)
                dc_review_dow = st.selectbox(
                    "DC Review Day",
                    ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
                    index=0,
                )

            with st.expander("Supplier Config"):
                sup_lead_min = st.number_input("Supplier lead time (min, days)", 1, 14, 3)
                sup_lead_max = st.number_input("Supplier lead time (max, days)", 1, 30, 7)
                sup_on_time = st.slider("Supplier on-time rate", 0.5, 1.0, 0.90, 0.05)
                sup_partial = st.slider("Supplier partial-delivery rate", 0.0, 0.5, 0.10, 0.05)

            with st.expander("DC → Store Config"):
                dc_lead_days = st.number_input("DC → Store lead time (days)", 1, 14, 2)
                dc_on_time = st.slider("DC → Store on-time rate", 0.5, 1.0, 0.95, 0.05)
                dc_partial = st.slider("DC → Store partial-delivery rate", 0.0, 0.3, 0.05, 0.05)

            entities = _ensure_entities(retailer_account_id) or {}
            dcs = entities.get("dcs", [])
            dc_on_time_by_dc = {}
            dc_partial_by_dc = {}
            dc_lead_days_by_dc = {}
            if dcs:
                with st.expander("Per-DC Rates"):
                    for d in dcs:
                        code = d.get("dc_code")
                        if not code:
                            continue
                        st.markdown(f"**{code}**")
                        dc_on_time_by_dc[code] = st.slider(
                            f"On-time ({code})", 0.5, 1.0, dc_on_time, 0.05,
                            key=f"dc_ot_{code}",
                        )
                        dc_partial_by_dc[code] = st.slider(
                            f"Partial ({code})", 0.0, 0.3, dc_partial, 0.05,
                            key=f"dc_pt_{code}",
                        )
                        dc_lead_days_by_dc[code] = st.number_input(
                            f"Lead days ({code})", 1, 14, int(dc_lead_days),
                            key=f"dc_ld_{code}",
                        )

        run_btn = st.button("▶ Run Simulation", type="primary", use_container_width=True)

    config = {
        "retailer_account_id": retailer_account_id,
        "created_by":          user_id,
        "simulation_name":     sim_name,
        "notes":               sim_notes,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "replenishment_policy": replenishment_policy,
        "smoothing_days": int(smoothing_days),
        "store_reorder_weeks": store_reorder_weeks,
        "store_target_weeks": store_target_weeks,
        "store_start_days": int(store_start_days),
        "store_order_dow": store_order_dow,
        "dc_reorder_weeks": dc_reorder_weeks,
        "dc_target_weeks": dc_target_weeks,
        "dc_start_days": int(dc_start_days),
        "dc_review_dow": dc_review_dow,
        "sup_lead_min": int(sup_lead_min),
        "sup_lead_max": int(sup_lead_max),
        "sup_on_time": sup_on_time,
        "sup_partial": sup_partial,
        "dc_on_time": dc_on_time,
        "dc_partial": dc_partial,
        "dc_lead_days": int(dc_lead_days),
        "dc_on_time_by_dc": dc_on_time_by_dc,
        "dc_partial_by_dc": dc_partial_by_dc,
        "dc_lead_days_by_dc": dc_lead_days_by_dc,
        "seed": int(seed),
        # carry these for results page (not posted to backend)
        "_start_date_obj": start_date,
        "_end_date_obj": end_date,
        "_store_reorder_weeks": store_reorder_weeks,
        "_store_target_weeks": store_target_weeks,
    }
    return run_btn, config


def _normalize_response(resp, *, config_block=None, sim_duration=None,
                        sim_start_date=None, sim_end_date=None,
                        store_reorder_weeks=2, store_target_weeks=3):
    """Convert the engine response into the sim_results dict shape with proper dtypes."""
    sim_id = resp.get("simulation_id", "")

    sales_daily_df = pd.DataFrame(resp.get("store_sales_daily", []))
    inv_daily_df = pd.DataFrame(resp.get("store_inventory_daily", []))
    sales_hist_df = pd.DataFrame(resp.get("sales_history", []))
    store_inv_df = pd.DataFrame(resp.get("store_inventory", []))
    dc_inv_df = pd.DataFrame(resp.get("dc_inventory", []))
    demand_df = pd.DataFrame(resp.get("demand", []))
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

    for col in ["demand_qty", "realized_demand_qty", "sales_qty", "lost_sales_qty", "sales_amount"]:
        if col in sales_daily_df.columns:
            sales_daily_df[col] = pd.to_numeric(sales_daily_df[col], errors="coerce")
    for col in ["on_hand_qty", "on_order_qty", "woc"]:
        if col in inv_daily_df.columns:
            inv_daily_df[col] = pd.to_numeric(inv_daily_df[col], errors="coerce")
    for col in ["sales_quantity", "sales_amount"]:
        if col in sales_hist_df.columns:
            sales_hist_df[col] = pd.to_numeric(sales_hist_df[col], errors="coerce")
    for col in ["on_hand_quantity", "on_order_quantity", "woc"]:
        if col in store_inv_df.columns:
            store_inv_df[col] = pd.to_numeric(store_inv_df[col], errors="coerce")
    if "date" in sales_daily_df.columns:
        sales_daily_df["date"] = pd.to_datetime(sales_daily_df["date"])
    if "date" in inv_daily_df.columns:
        inv_daily_df["date"] = pd.to_datetime(inv_daily_df["date"])
    if "demand_date" in demand_df.columns:
        demand_df["demand_date"] = pd.to_datetime(demand_df["demand_date"])
    if "demand_qty" in demand_df.columns:
        demand_df["demand_qty"] = pd.to_numeric(demand_df["demand_qty"], errors="coerce")
    if "is_promo_demand" in demand_df.columns:
        demand_df["is_promo_demand"] = demand_df["is_promo_demand"].map(
            lambda v: True if str(v) in ("1", "True", "true") else False
        )

    # Derive start/end dates from data if not provided (past runs)
    if sim_start_date is None or sim_end_date is None:
        if "date" in sales_daily_df.columns and not sales_daily_df.empty:
            sim_start_date = sim_start_date or sales_daily_df["date"].min().date()
            sim_end_date = sim_end_date or sales_daily_df["date"].max().date()
        else:
            sim_start_date = sim_start_date or date(2024, 1, 1)
            sim_end_date = sim_end_date or date(2024, 12, 31)

    return {
        "sim_id": sim_id,
        "sim_start_date": sim_start_date,
        "sim_end_date": sim_end_date,
        "sim_duration": sim_duration,
        "sim_config_block": config_block or {},
        "store_reorder_weeks": store_reorder_weeks,
        "store_target_weeks": store_target_weeks,
        "items_df": items_df,
        "stores_df": stores_df,
        "sales_daily_df": sales_daily_df,
        "inv_daily_df": inv_daily_df,
        "demand_df": demand_df,
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


def _execute_run(config):
    """POST /run, normalize dataframes, store in session_state.sim_results."""
    if config["_start_date_obj"] >= config["_end_date_obj"]:
        st.error("Start date must be before end date.")
        return

    payload = {k: v for k, v in config.items() if not k.startswith("_")}

    t0 = time.time()
    with st.spinner("Running simulation…"):
        try:
            resp = api.run_simulation(payload)
        except httpx.ConnectError as e:
            show_error(f"Cannot reach backend at {api.BACKEND_URL}", e)
            return
        except httpx.TimeoutException as e:
            show_error("Simulation request timed out — try a shorter date range", e)
            return
        except httpx.HTTPStatusError as e:
            show_error("Simulation engine returned an error", e, e.response)
            return
        except Exception as e:
            show_error("Unexpected error", e)
            return

    sim_duration = round(time.time() - t0, 1)

    if not resp.get("simulation_id"):
        st.error(
            "Simulation engine returned an empty response. "
            "Check that the engine container is running and reachable from the backend "
            f"(BACKEND_URL={api.BACKEND_URL}, SIM_ENGINE_URL on backend should point to the engine on port 8000)."
        )
        return

    st.session_state["sim_results"] = _normalize_response(
        resp,
        config_block=payload,
        sim_duration=sim_duration,
        sim_start_date=config["_start_date_obj"],
        sim_end_date=config["_end_date_obj"],
        store_reorder_weeks=config["_store_reorder_weeks"],
        store_target_weeks=config["_store_target_weeks"],
    )
    # Non-scenario run — clear any stale scenario meta from a previous run
    st.session_state.pop("_scenario_meta", None)
    st.success(f"Simulation complete. Run ID: `{st.session_state['sim_results']['sim_id']}`")


def _build_run_yaml_template(entities: dict) -> str:
    """Generate a run config YAML template pre-filled with real DC and supplier codes."""
    dcs       = entities.get("dcs", [])
    suppliers = entities.get("suppliers", [])
    stores    = entities.get("stores", [])

    dc_codes  = [d.get("dc_code", "") for d in dcs if d.get("dc_code")]
    sup_codes = [s.get("supplier_code", "") for s in suppliers if s.get("supplier_code")]

    def _dc_override_block(key, default):
        if not dc_codes:
            return f"  # {key}:\n  #   DC_CODE: {default}\n"
        lines = [f"  # {key}:"]
        for code in dc_codes:
            lines.append(f"  #   {code}: {default}")
        return "\n".join(lines) + "\n"

    supplier_ref = ""
    if sup_codes:
        sup_lines = ["  # Available suppliers (use these codes in scenario YAML):"]
        for code in sup_codes:
            sup_lines.append(f"  #   {code}")
        supplier_ref = "\n".join(sup_lines) + "\n"
    else:
        supplier_ref = "  # No suppliers found in network\n"

    store_count = len(stores)

    return (
        "# =============================================================================\n"
        "# SIMULATION RUN CONFIG\n"
        "# =============================================================================\n"
        "# Edit the values below, then click Validate → Run Simulation.\n"
        "# All fields are optional — defaults are shown and used if omitted.\n"
        "# =============================================================================\n"
        "\n"
        "run:\n"
        '  simulation_name: "My Simulation Run"\n'
        '  notes: ""\n'
        "\n"
        '  start_date: "2024-01-01"            # YYYY-MM-DD\n'
        '  end_date:   "2024-12-31"\n'
        "\n"
        "  seed: 42\n"
        "\n"
        "  # trailing_avg_28d | promo_aware_7d | baseline_only\n"
        "  replenishment_policy: trailing_avg_28d\n"
        "  smoothing_days: 28                  # 7-90\n"
        "\n"
        "  store_reorder_weeks: 2\n"
        "  store_target_weeks:  3\n"
        "  store_start_days:    14\n"
        "  store_order_dow:     MONDAY         # MONDAY-FRIDAY\n"
        f"  # {store_count} store(s) in network\n"
        "\n"
        "  dc_reorder_weeks: 2\n"
        "  dc_target_weeks:  5\n"
        "  dc_start_days:    30\n"
        "  dc_review_dow:    MONDAY\n"
        "\n"
        "  sup_lead_min:  3\n"
        "  sup_lead_max:  7\n"
        "  sup_on_time:   0.90\n"
        "  sup_partial:   0.10\n"
        "\n"
        "  dc_lead_days:  2\n"
        "  dc_on_time:    0.95\n"
        "  dc_partial:    0.05\n"
        "\n"
        "  # -- Per-DC overrides -- uncomment and edit the DCs you want to override:\n"
        + _dc_override_block("dc_on_time_by_dc", "0.95")
        + _dc_override_block("dc_partial_by_dc", "0.05")
        + _dc_override_block("dc_lead_days_by_dc", "2")
        + "\n"
        + supplier_ref
    )


def _render_yaml_run_editor(retailer_account_id, entities: dict):
    """YAML-based run config editor. Returns True if a run was successfully submitted."""
    import yaml as _yaml
    from datetime import date as _date

    tpl_key = f"_run_yaml_tpl_{retailer_account_id}"
    if tpl_key not in st.session_state:
        st.session_state[tpl_key] = _build_run_yaml_template(entities)
    default_template = st.session_state[tpl_key]

    st.markdown(
        "<style>textarea { font-family: 'Courier New', monospace !important;"
        " font-size: 13px !important; }</style>",
        unsafe_allow_html=True,
    )

    yaml_text = st.text_area(
        "yaml",
        value=st.session_state.get("_run_yaml_text", default_template),
        height=500,
        key="_run_yaml_ta",
        label_visibility="collapsed",
    )
    st.session_state["_run_yaml_text"] = yaml_text

    col_v, col_r = st.columns(2)

    with col_v:
        if st.button("Validate", key="_run_yaml_validate", use_container_width=True):
            st.session_state.pop("_run_yaml_valid", None)
            try:
                raw = _yaml.safe_load(yaml_text)
                if not isinstance(raw, dict) or not isinstance(raw.get("run"), dict):
                    raise ValueError("YAML must contain a 'run:' block")
                run = raw["run"]
                # Basic date check client-side for fast feedback
                s = _date.fromisoformat(str(run.get("start_date", "2024-01-01")))
                e = _date.fromisoformat(str(run.get("end_date", "2024-12-31")))
                if e <= s:
                    raise ValueError("end_date must be after start_date")
                st.session_state["_run_yaml_valid"] = True
                st.success("YAML looks good — click Run Simulation to proceed.")
            except Exception as exc:
                st.error(str(exc))

    validated = st.session_state.get("_run_yaml_valid", False)

    with col_r:
        if st.button(
            "▶ Run Simulation",
            key="_run_yaml_run",
            type="primary",
            use_container_width=True,
            disabled=not validated,
        ):
            t0 = time.time()
            with st.spinner("Running simulation…"):
                try:
                    resp = api.run_simulation_yaml(yaml_text)
                except httpx.ConnectError as exc:
                    show_error(f"Cannot reach backend at {api.BACKEND_URL}", exc)
                    return False
                except httpx.TimeoutException as exc:
                    show_error("Simulation request timed out — try a shorter date range", exc)
                    return False
                except httpx.HTTPStatusError as exc:
                    show_error("Simulation engine returned an error", exc, exc.response)
                    return False
                except Exception as exc:
                    show_error("Unexpected error", exc)
                    return False

            sim_duration = round(time.time() - t0, 1)
            if not resp.get("simulation_id"):
                st.error("Simulation engine returned an empty response.")
                return False

            # Extract dates from YAML for _normalize_response
            try:
                raw = _yaml.safe_load(yaml_text)
                run_block = raw.get("run", {})
                sim_start = _date.fromisoformat(str(run_block.get("start_date", "2024-01-01")))
                sim_end   = _date.fromisoformat(str(run_block.get("end_date",   "2024-12-31")))
                store_rw  = int(run_block.get("store_reorder_weeks", 2))
                store_tw  = int(run_block.get("store_target_weeks",  3))
            except Exception:
                sim_start, sim_end, store_rw, store_tw = (
                    _date(2024, 1, 1), _date(2024, 12, 31), 2, 3
                )

            st.session_state["sim_results"] = _normalize_response(
                resp,
                config_block={},
                sim_duration=sim_duration,
                sim_start_date=sim_start,
                sim_end_date=sim_end,
                store_reorder_weeks=store_rw,
                store_target_weeks=store_tw,
            )
            st.session_state.pop("_scenario_meta", None)
            st.session_state.pop("_run_yaml_valid", None)
            st.session_state.pop(f"runs_list_{retailer_account_id}", None)
            st.success(
                f"Simulation complete. Run ID: `{st.session_state['sim_results']['sim_id']}`"
            )
            return True

    return False


def _load_past_run(run_id):
    """Fetch a past simulation's CSV-backed results and populate session_state."""
    with st.spinner(f"Loading run {run_id[:8]}…"):
        try:
            resp = api.fetch_simulation(run_id)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                st.error(f"Run `{run_id}` not found on disk. It may need to be re-run.")
            else:
                show_error("Could not load past run", e, e.response)
            return False
        except Exception as e:
            show_error("Could not load past run", e)
            return False

        # Try to fetch saved config for context
        config_block = {}
        try:
            cfg_resp = api.fetch_run_config(run_id)
            config_block = cfg_resp.get("full_config") or {}
        except Exception:
            pass

    # Parse start/end from saved config when available
    start_date_str = config_block.get("start_date")
    end_date_str = config_block.get("end_date")
    sim_start = pd.to_datetime(start_date_str).date() if start_date_str else None
    sim_end = pd.to_datetime(end_date_str).date() if end_date_str else None

    st.session_state["sim_results"] = _normalize_response(
        resp,
        config_block=config_block,
        sim_duration=None,
        sim_start_date=sim_start,
        sim_end_date=sim_end,
        store_reorder_weeks=int(config_block.get("store_reorder_weeks", 2)),
        store_target_weeks=int(config_block.get("store_target_weeks", 3)),
    )
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
        store_reorder_weeks=int(config_block.get("store_reorder_weeks", 2)),
        store_target_weeks=int(config_block.get("store_target_weeks", 3)),
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
    sales_daily_df = r["sales_daily_df"]
    inv_daily_df = r["inv_daily_df"]
    demand_df = r["demand_df"]
    sales_hist_df = r["sales_hist_df"]
    store_inv_df = r["store_inv_df"]
    dc_inv_df = r["dc_inv_df"]
    sup_rec_df = r["sup_rec_df"]
    str_rec_df = r["str_rec_df"]
    sup_orders_df = r["sup_orders_df"]
    sup_od_df = r["sup_od_df"]
    str_orders_df = r["str_orders_df"]
    store_od_df = r["store_od_df"]
    store_dc_map = r["store_dc_map"]
    dcs_df = r.get("dcs_df", pd.DataFrame())
    sim_duration = r.get("sim_duration")
    sim_config_block = r.get("sim_config_block", {})
    store_reorder_weeks = r.get("store_reorder_weeks", 2)
    store_target_weeks = r.get("store_target_weeks", 3)

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

    if sales_daily_df.empty and sales_hist_df.empty:
        st.warning("Simulation returned no sales data.")
        return

    if sales_daily_df.empty:
        st.info(
            "Daily granularity is not available for this run "
            "(older runs persisted only weekly data). Daily chart and daily-only "
            "KPIs (lost sales, fill rate, stockout days) will be hidden. "
            "Re-run to populate the daily tables."
        )

    # Pick whichever frame has store/item ids — prefer daily, then weekly, then inventory.
    _selector_source = next(
        (df for df in (sales_daily_df, sales_hist_df, store_inv_df, inv_daily_df)
         if not df.empty and {"store_id", "item_id"}.issubset(df.columns)),
        pd.DataFrame(),
    )

    st.divider()
    stores_list = sorted(_selector_source["store_id"].unique().tolist()) if not _selector_source.empty else []
    items_list = sorted(_selector_source["item_id"].unique().tolist()) if not _selector_source.empty else []

    store_code_map = stores_df.set_index("store_id")["store_code"].to_dict() if not stores_df.empty else {}
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

    s_inv_d = inv_daily_df[
        (inv_daily_df["store_id"] == sel_store) & (inv_daily_df["item_id"] == sel_item)
    ].copy() if not inv_daily_df.empty else pd.DataFrame()
    s_inv_d = _sort(s_inv_d, "date")

    s_sales_d = sales_daily_df[
        (sales_daily_df["store_id"] == sel_store) & (sales_daily_df["item_id"] == sel_item)
    ].copy() if not sales_daily_df.empty else pd.DataFrame()
    s_sales_d = _sort(s_sales_d, "date")

    s_demand = demand_df[
        (demand_df["store_id"] == sel_store) & (demand_df["item_id"] == sel_item)
    ].copy() if not demand_df.empty else pd.DataFrame()
    s_demand = _sort(s_demand, "demand_date")

    s_sales_w = sales_hist_df[
        (sales_hist_df["store_id"] == sel_store) & (sales_hist_df["item_id"] == sel_item)
    ].copy() if not sales_hist_df.empty else pd.DataFrame()
    s_sales_w = _sort(s_sales_w, "sales_week")

    s_inv_w = store_inv_df[
        (store_inv_df["store_id"] == sel_store) & (store_inv_df["item_id"] == sel_item)
    ].copy() if not store_inv_df.empty else pd.DataFrame()
    s_inv_w = _sort(s_inv_w, "inventory_week" if "inventory_week" in s_inv_w.columns else "sales_week")

    avg_daily_d = s_sales_d["demand_qty"].mean() if not s_sales_d.empty else 0
    trigger_units = int(round(store_reorder_weeks * avg_daily_d * 7))
    target_units = int(round(store_target_weeks * avg_daily_d * 7))


    # KPIs (fall back to weekly when daily isn't available)
    has_daily = not s_sales_d.empty
    if has_daily:
        total_demand = s_sales_d["demand_qty"].sum()
        total_sales = s_sales_d["sales_qty"].sum()
        total_lost = s_sales_d["lost_sales_qty"].sum()
        fill_rate = total_sales / total_demand * 100 if total_demand > 0 else 0
        total_revenue = s_sales_d["sales_amount"].sum()
        total_demand_str = f"{total_demand:,.0f}"
        total_sales_str = f"{total_sales:,.0f}"
        total_lost_str = f"{total_lost:,.0f}"
        fill_rate_str = f"{fill_rate:.1f}%"
        total_revenue_str = f"${total_revenue:,.0f}"
    else:
        # Weekly-only fallback. Lost sales / fill rate aren't derivable from sales_history alone.
        total_sales = s_sales_w["sales_quantity"].sum() if not s_sales_w.empty else 0
        total_revenue = s_sales_w["sales_amount"].sum() if not s_sales_w.empty else 0
        total_demand_str = "—"
        total_sales_str = f"{total_sales:,.0f}"
        total_lost_str = "—"
        fill_rate_str = "—"
        total_revenue_str = f"${total_revenue:,.0f}"

    stockout_days = (s_inv_d["inventory_status"] == "ZERO").sum() if not s_inv_d.empty else 0
    stockout_days_str = f"{stockout_days:,}" if not s_inv_d.empty else "—"

    k1, k2, k3, k4, k5, k6 = st.columns(6)
    k1.metric("Total Demand",  total_demand_str)
    k2.metric("Total Sales",   total_sales_str)
    k3.metric("Lost Sales",    total_lost_str)
    k4.metric("Fill Rate",     fill_rate_str)
    k5.metric("Stockout Days", stockout_days_str)
    k6.metric("Revenue",       total_revenue_str)

    # Promo windows
    promo_date_ranges = []
    if not s_demand.empty and "is_promo_demand" in s_demand.columns:
        sd = s_demand.sort_values("demand_date").copy()
        in_promo = False
        span_start = None
        for _, row in sd.iterrows():
            if row["is_promo_demand"] and not in_promo:
                span_start = row["demand_date"]
                in_promo = True
            elif not row["is_promo_demand"] and in_promo:
                promo_date_ranges.append((span_start, row["demand_date"] - pd.Timedelta(days=1)))
                in_promo = False
        if in_promo and span_start is not None:
            promo_date_ranges.append((span_start, sd["demand_date"].iloc[-1]))

    promo_weeks = set()
    if not s_demand.empty and "is_promo_demand" in s_demand.columns and "demand_week" in s_demand.columns:
        promo_weeks = set(s_demand[s_demand["is_promo_demand"] == True]["demand_week"].unique())

    def _overlaps_any_anomaly(x0, x1):
        """True if date range overlaps with any scenario anomaly window."""
        for ws, we in _active_promo_windows:
            if x0 <= we + pd.Timedelta(days=1) and x1 >= ws:
                return True
        return False

    def _add_promo_daily(fig):
        added_promo = added_anom = False
        for x0, x1 in promo_date_ranges:
            if _overlaps_any_anomaly(x0, x1):
                fig.add_vrect(
                    x0=x0, x1=x1 + pd.Timedelta(days=1),
                    fillcolor="rgba(220,30,30,0.35)", layer="below",
                    line_color="rgba(255,60,60,0.9)", line_width=1,
                    name="Anomaly Window" if not added_anom else None,
                    showlegend=not added_anom, legendgroup="anom",
                )
                added_anom = True
            else:
                fig.add_vrect(
                    x0=x0, x1=x1 + pd.Timedelta(days=1),
                    fillcolor="rgba(255,180,0,0.18)", layer="below", line_width=0,
                    name="Promo Period" if not added_promo else None,
                    showlegend=not added_promo, legendgroup="promo",
                )
                added_promo = True
        # HLS scenario: shortage window is not a promo, add red highlights directly
        stype = (scenario_meta or {}).get("type", "")
        if stype == "hidden_lost_sales" and not added_anom:
            for ws, we in _active_promo_windows:
                fig.add_vrect(
                    x0=ws, x1=we + pd.Timedelta(days=1),
                    fillcolor="rgba(220,30,30,0.35)", layer="below",
                    line_color="rgba(255,60,60,0.9)", line_width=1,
                    name="Anomaly Window" if not added_anom else None,
                    showlegend=not added_anom, legendgroup="anom",
                )
                added_anom = True

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

    # Daily chart
    st.divider()
    st.subheader("Inventory & Sales Charts")
    st.markdown("#### Daily: Demand vs Sales vs Inventory")
    if not s_sales_d.empty and not s_inv_d.empty:
        fig_daily = go.Figure()
        s_daily = s_sales_d.merge(s_inv_d[["date", "on_hand_qty"]], on="date", how="left")
        day_lbl = s_daily["date"].dt.strftime("%a, %b %d %Y")
        inv_lbl = s_inv_d["date"].dt.strftime("%a, %b %d %Y")
        fig_daily.add_trace(go.Bar(
            x=s_daily["date"], y=s_daily["demand_qty"],
            name="Demand", marker_color="#BAD7F2", opacity=0.85,
            hovertemplate="<b>%{customdata}</b><br>Demand: %{y}<extra></extra>",
            customdata=day_lbl,
        ))
        fig_daily.add_trace(go.Bar(
            x=s_daily["date"], y=s_daily["sales_qty"],
            name="Sales (Fulfilled)", marker_color="#2E86AB", opacity=0.9,
            hovertemplate="<b>%{customdata}</b><br>Sales: %{y}<extra></extra>",
            customdata=day_lbl,
        ))
        lost_colors = ["#db5546" if oh == 0 else "#F1948A" for oh in s_daily["on_hand_qty"]]
        fig_daily.add_trace(go.Bar(
            x=s_daily["date"], y=s_daily["lost_sales_qty"],
            name="Lost Sales", marker_color=lost_colors, opacity=0.9,
            hovertemplate="<b>%{customdata}</b><br>Lost: %{y}<extra></extra>",
            customdata=day_lbl,
        ))
        fig_daily.add_trace(go.Scatter(
            x=s_inv_d["date"], y=s_inv_d["on_hand_qty"],
            name="On-Hand Inventory", mode="lines",
            line=dict(color="#E84855", width=2), yaxis="y2",
            hovertemplate="<b>%{customdata}</b><br>On-Hand: %{y}<extra></extra>",
            customdata=inv_lbl,
        ))
        fig_daily.add_trace(go.Scatter(
            x=s_inv_d["date"], y=s_inv_d["on_order_qty"],
            name="On-Order", mode="lines",
            line=dict(color="#F4A261", width=1.5, dash="dot"), yaxis="y2",
            hovertemplate="<b>%{customdata}</b><br>On-Order: %{y}<extra></extra>",
            customdata=inv_lbl,
        ))
        _add_promo_daily(fig_daily)
        if scenario_meta and "realized_demand_qty" in s_daily.columns:
            fig_daily.add_trace(go.Scatter(
                x=s_daily["date"], y=s_daily["realized_demand_qty"],
                name="Actual Demand (realized)", mode="lines",
                line=dict(color="rgba(220,30,30,0.9)", width=2, dash="dot"),
                hovertemplate="<b>%{customdata}</b><br>Actual Demand: %{y}<extra></extra>",
                customdata=day_lbl,
            ))
        fig_daily.update_layout(
            barmode="group",
            xaxis=dict(title="Date"),
            yaxis=dict(title="Units (Demand / Sales)", side="left"),
            yaxis2=dict(title="Units (Inventory)", overlaying="y", side="right", showgrid=False),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            height=420,
        )
        st.plotly_chart(fig_daily, use_container_width=True)
    else:
        st.info("Daily granularity not available for this run.")

    # Weekly chart
    st.markdown("#### Weekly: Demand vs Sales vs Inventory")
    fig_weekly = go.Figure()
    if not s_sales_w.empty:
        weeks_list = sorted(s_sales_w["sales_week"].unique().tolist())
        if not s_inv_w.empty:
            inv_w_key = "sales_week" if "sales_week" in s_inv_w.columns else "inventory_week"
            weekly_df = s_sales_w.merge(
                s_inv_w[[inv_w_key, "on_hand_quantity"]].rename(columns={"inventory_week": "sales_week"}),
                on="sales_week", how="left",
            )
        else:
            weekly_df = s_sales_w.copy()
            weekly_df["on_hand_quantity"] = 0

        if not s_sales_d.empty and "week" in s_sales_d.columns:
            weekly_demand = (
                s_sales_d.groupby("week", sort=True)["demand_qty"].sum().reset_index()
                .rename(columns={"week": "sales_week", "demand_qty": "demand_quantity"})
            )
            weekly_df = weekly_df.merge(weekly_demand, on="sales_week", how="left")
        else:
            weekly_df["demand_quantity"] = weekly_df["sales_quantity"]

        fig_weekly.add_trace(go.Bar(
            x=weekly_df["sales_week"],
            y=weekly_df.get("demand_quantity", weekly_df["sales_quantity"]),
            name="Demand", marker_color="#BAD7F2", opacity=0.85,
        ))
        fig_weekly.add_trace(go.Bar(
            x=weekly_df["sales_week"], y=weekly_df["sales_quantity"],
            name="Sales", marker_color="#2E86AB", opacity=0.9,
        ))
        if "on_hand_quantity" in weekly_df.columns:
            fig_weekly.add_trace(go.Scatter(
                x=weekly_df["sales_week"], y=weekly_df["on_hand_quantity"],
                name="On-Hand (EOW)", mode="lines+markers",
                line=dict(color="#F4A261", width=2), yaxis="y2",
            ))
        _add_promo_weekly(fig_weekly, weeks_list)
    fig_weekly.update_layout(
        barmode="group",
        xaxis=dict(title="Week", tickangle=-45),
        yaxis=dict(title="Units (Demand / Sales)", side="left"),
        yaxis2=dict(title="Units (Inventory EOW)", overlaying="y", side="right", showgrid=False),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        height=420,
    )
    st.plotly_chart(fig_weekly, use_container_width=True)

    # Raw output tables
    all_dfs = _prepare_export_dfs(
        filter_store=None, filter_item=None,
        items_df=items_df, stores_df=stores_df, dcs_df=dcs_df, dc_inv_df=dc_inv_df,
        sup_orders_df=sup_orders_df, sup_od_df=sup_od_df, sup_rec_df=sup_rec_df,
        str_orders_df=str_orders_df, store_od_df=store_od_df, str_rec_df=str_rec_df,
        sales_hist_df=sales_hist_df, store_inv_df=store_inv_df, demand_df=demand_df,
        store_dc_map=store_dc_map, start_date=start_date, end_date=end_date,
    )
    dq_report = _build_data_quality_report(
        store_inv_df, dc_inv_df, sales_hist_df, demand_df,
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
                "simulation_name", "start_date", "end_date", "replenishment_policy",
                "smoothing_days", "seed", "store_reorder_weeks", "store_target_weeks",
                "store_start_days", "store_order_dow", "dc_reorder_weeks", "dc_target_weeks",
                "dc_start_days", "dc_review_dow", "sup_lead_min", "sup_lead_max",
                "sup_on_time", "sup_partial", "dc_lead_days", "dc_on_time", "dc_partial",
                "dc_on_time_by_dc", "dc_partial_by_dc",
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

        with st.expander("Demand Matrix"):
            st.dataframe(s_demand.reset_index(drop=True) if not s_demand.empty else pd.DataFrame())
        with st.expander("Daily Sales"):
            st.dataframe(s_sales_d.reset_index(drop=True))
        with st.expander("Daily Store Inventory"):
            st.dataframe(s_inv_d.reset_index(drop=True))
        with st.expander("Weekly Sales History"):
            st.dataframe(s_sales_w.reset_index(drop=True))
        with st.expander("Weekly Store Inventory"):
            st.dataframe(s_inv_w.reset_index(drop=True))

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
            sales_hist_df=sales_hist_df, store_inv_df=store_inv_df, demand_df=demand_df,
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
                    sales_hist_df=sales_hist_df, store_inv_df=store_inv_df, demand_df=demand_df,
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

    if not run_id:
        entities = _ensure_entities(retailer_account_id) or {}
        n_items     = len(entities.get("items", []))
        n_stores    = len(entities.get("stores", []))
        n_dcs       = len(entities.get("dcs", []))
        n_suppliers = len(entities.get("suppliers", []))
        c1, c2, c3, c4 = st.columns(4)
        c1.metric("Items",     n_items)
        c2.metric("Stores",    n_stores)
        c3.metric("DCs",       n_dcs)
        c4.metric("Suppliers", n_suppliers)

    st.info("**Scenarios** — inject promo anomalies or supply disruptions and observe how your replenishment system responds.")
    if st.button("Run a Scenario instead", use_container_width=False):
        st.session_state.pop("_scen_tile", None)
        go_to("scenario_setup", retailer_account_id=retailer_account_id)

    st.divider()

    tab_form, tab_yaml = st.tabs(["Form", "YAML"])

    with tab_form:
        run_btn, config = _render_config_form(retailer_account_id, user_id)
        if run_btn:
            _execute_run(config)
            st.session_state.pop(f"runs_list_{retailer_account_id}", None)

    with tab_yaml:
        _render_yaml_run_editor(retailer_account_id, _ensure_entities(retailer_account_id) or {})

    _render_results()
