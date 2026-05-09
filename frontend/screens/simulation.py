"""
screens/simulation.py — Screen 4: Network config + Run simulation.
Wraps the original Tab 1 and Tab 2 logic from app.py with no changes to business logic.
"""
import json
import re as _re
import time
from datetime import date

import httpx
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from frontend.utils.export import (
    _build_data_quality_report,
    _build_run_manifest,
    _build_zip,
    _prepare_export_dfs,
    show_error,
)


def _fetch_entities(backend_url, account_id):
    try:
        r = httpx.get(f"{backend_url}/entities", params={"account_id": account_id}, timeout=15.0)
        r.raise_for_status()
        st.session_state.entities = r.json()
    except httpx.HTTPStatusError as e:
        show_error("Could not load entity catalogue", e, e.response)
    except Exception as e:
        show_error("Could not load entity catalogue", e)


def _fetch_mappings(backend_url, account_id):
    try:
        r = httpx.get(f"{backend_url}/mappings", params={"account_id": account_id}, timeout=15.0)
        r.raise_for_status()
        st.session_state.mappings = r.json()
    except httpx.HTTPStatusError as e:
        show_error("Could not load mappings", e, e.response)
    except Exception as e:
        show_error("Could not load mappings", e)


def render_simulation_screen(backend_url: str):
    ss = st.session_state
    account_id   = ss.account_id
    account_name = ss.get("selected_account_name", "Retailer")
    run_name     = ss.get("selected_run_name", "New Run")

    # Breadcrumb
    st.markdown(
        f'<div style="padding: 20px 28px 0;">'
        f'<div class="breadcrumb">'
        f'  <span>Retailers</span>'
        f'  <span class="sep">›</span>'
        f'  <span>{account_name}</span>'
        f'  <span class="sep">›</span>'
        f'  <span>Simulations</span>'
        f'  <span class="sep">›</span>'
        f'  <span class="current">{run_name}</span>'
        f'</div></div>',
        unsafe_allow_html=True,
    )

    if st.button("← Back to runs"):
        ss.screen = "runs"
        st.rerun()

    # Ensure entities + mappings are loaded
    if ss.entities is None:
        _fetch_entities(backend_url, account_id)
    if ss.mappings is None:
        _fetch_mappings(backend_url, account_id)

    entities = ss.entities or {}
    mappings = ss.mappings or {}

    tab_network, tab_simulate = st.tabs(["Network & Assortment", "Run Simulation"])

    # =========================================================================
    # TAB 1 — Network & Assortment
    # =========================================================================
    with tab_network:
        st.header("Network & Assortment Configuration")
        st.caption("Define which stores/DCs carry which items, and how nodes are connected.")

        col_refresh, _ = st.columns([1, 5])
        if col_refresh.button("Refresh from DB"):
            _fetch_entities(backend_url, account_id)
            _fetch_mappings(backend_url, account_id)
            st.rerun()

        items     = entities.get("items", [])
        stores    = entities.get("stores", [])
        dcs       = entities.get("dcs", [])
        suppliers = entities.get("suppliers", [])

        if not items:
            st.info("No entities loaded. Make sure the backend is running and PostgreSQL is seeded.")
        else:
            item_opts     = {f"{i['item_code']}": i["item_id"] for i in items}
            store_opts    = {f"{s['store_code']} — {s['store_name']}": s["store_id"] for s in stores}
            dc_opts       = {f"{d['dc_code']} — {d['dc_name']}": d["dc_id"] for d in dcs}
            supplier_opts = {f"{s['supplier_code']} — {s['supplier_name']}": s["supplier_id"] for s in suppliers}

            item_label_by_id     = {v: k for k, v in item_opts.items()}
            dc_label_by_id       = {v: k for k, v in dc_opts.items()}
            supplier_label_by_id = {v: k for k, v in supplier_opts.items()}

            cur_store_items = {(r["store_id"], r["item_id"]) for r in mappings.get("store_items", [])}
            cur_dc_items    = {(r["dc_id"],    r["item_id"]) for r in mappings.get("dc_items", [])}
            cur_sup_items   = {(r["supplier_id"], r["item_id"]) for r in mappings.get("supplier_items", [])}
            cur_store_dc    = {r["from_store_id"]: r["to_dc_id"] for r in mappings.get("store_mappings", [])}
            cur_dc_sup: dict = {}
            for r in mappings.get("dc_mappings", []):
                cur_dc_sup.setdefault(r["from_dc_id"], []).append(r["to_node_id"])

            new_store_items    = []
            new_dc_items       = []
            new_supplier_items = []
            new_store_mappings = []
            new_dc_mappings    = []

            st.subheader("1. Store → DC Assignments")
            dc_label_options = list(dc_opts.keys())
            dc_id_options    = list(dc_opts.values())

            for store_label, store_id in store_opts.items():
                cur_dc_id  = cur_store_dc.get(store_id)
                cur_dc_idx = dc_id_options.index(cur_dc_id) if cur_dc_id in dc_id_options else 0
                chosen_dc_label = st.selectbox(
                    f"Serving DC for **{store_label}**",
                    dc_label_options, index=cur_dc_idx, key=f"store_dc_{store_id}",
                )
                new_store_mappings.append({
                    "from_store_id": store_id,
                    "to_dc_id":      dc_opts[chosen_dc_label],
                    "mapping_type":  "STORE_DC",
                })

            st.subheader("2. DC → Supplier Links")
            supplier_label_list = list(supplier_opts.keys())

            for dc_label, dc_id in dc_opts.items():
                existing_sup_ids  = cur_dc_sup.get(dc_id, [])
                existing_sup_lbls = [supplier_label_by_id[s] for s in existing_sup_ids if s in supplier_label_by_id]
                chosen_sups = st.multiselect(
                    f"Suppliers for **{dc_label}**", supplier_label_list,
                    default=existing_sup_lbls, key=f"dc_sup_{dc_id}",
                )
                for sup_label in chosen_sups:
                    new_dc_mappings.append({
                        "from_dc_id":   dc_id,
                        "to_node_id":   supplier_opts[sup_label],
                        "mapping_type": "DC_SUPPLIER",
                    })

            st.subheader("3. Store Assortment")
            all_item_labels = list(item_opts.keys())

            for store_label, store_id in store_opts.items():
                existing_item_ids  = [iid for (sid, iid) in cur_store_items if sid == store_id]
                existing_item_lbls = [item_label_by_id[i] for i in existing_item_ids if i in item_label_by_id]
                chosen_items = st.multiselect(
                    f"Items for **{store_label}**", all_item_labels,
                    default=existing_item_lbls, key=f"store_items_{store_id}",
                )
                for ilabel in chosen_items:
                    new_store_items.append({"store_id": store_id, "item_id": item_opts[ilabel]})

            st.subheader("4. DC Assortment")
            for dc_label, dc_id in dc_opts.items():
                existing_item_ids  = [iid for (did, iid) in cur_dc_items if did == dc_id]
                existing_item_lbls = [item_label_by_id[i] for i in existing_item_ids if i in item_label_by_id]
                chosen_items = st.multiselect(
                    f"Items for **{dc_label}**", all_item_labels,
                    default=existing_item_lbls, key=f"dc_items_{dc_id}",
                )
                for ilabel in chosen_items:
                    new_dc_items.append({"dc_id": dc_id, "item_id": item_opts[ilabel]})

            st.subheader("5. Supplier Assortment")
            for sup_label, sup_id in supplier_opts.items():
                existing_item_ids  = [iid for (sid, iid) in cur_sup_items if sid == sup_id]
                existing_item_lbls = [item_label_by_id[i] for i in existing_item_ids if i in item_label_by_id]
                chosen_items = st.multiselect(
                    f"Items for **{sup_label}**", all_item_labels,
                    default=existing_item_lbls, key=f"sup_items_{sup_id}",
                )
                for ilabel in chosen_items:
                    new_supplier_items.append({"supplier_id": sup_id, "item_id": item_opts[ilabel]})

            if st.button("Save Network Config", type="primary", key="save_network"):
                payload = {
                    "account_id":     account_id,
                    "store_items":    new_store_items,
                    "dc_items":       new_dc_items,
                    "supplier_items": new_supplier_items,
                    "store_mappings": new_store_mappings,
                    "dc_mappings":    new_dc_mappings,
                }
                try:
                    r = httpx.post(f"{backend_url}/mappings", json=payload, timeout=30.0)
                    r.raise_for_status()
                    st.success("Network configuration saved.")
                    _fetch_mappings(backend_url, account_id)
                    st.rerun()
                except httpx.HTTPStatusError as e:
                    show_error("Failed to save network config", e, e.response)
                except Exception as e:
                    show_error("Failed to save network config", e)

    # =========================================================================
    # TAB 2 — Run Simulation
    # =========================================================================
    with tab_simulate:

        # ── Sidebar config ────────────────────────────────────────────────────
        st.sidebar.header("Simulation Config")

        sim_name  = st.sidebar.text_input("Simulation Name", value="Default Run")
        sim_notes = st.sidebar.text_area("Notes", value="", height=60)

        start_date = st.sidebar.date_input("Start Date", value=date(2024, 1, 1))
        end_date   = st.sidebar.date_input("End Date",   value=date(2024, 12, 31))

        replenishment_policy = st.sidebar.selectbox(
            "Replenishment Policy",
            ["trailing_avg_28d", "promo_aware_7d", "baseline_only"],
        )

        _policy_day_match = _re.search(r"(\d+)d", replenishment_policy)
        _default_smoothing = int(_policy_day_match.group(1)) if _policy_day_match else 28
        smoothing_days = st.sidebar.number_input("Demand Smoothing Window (days)", min_value=7, max_value=90, value=_default_smoothing)

        st.sidebar.subheader("Store Config")
        store_reorder_weeks = st.sidebar.slider("Min Inventory Trigger (weeks of cover)", 1, 4, 2, 1)
        store_target_weeks  = st.sidebar.slider("Store Target Stock (weeks)",             1, 8, 3, 1)
        store_start_days    = st.sidebar.number_input("Store Starting Stock (days)", min_value=1, max_value=60, value=14)
        store_order_dow     = st.sidebar.selectbox("Store Order Day", ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"], index=0)

        st.sidebar.subheader("DC Config")
        dc_reorder_weeks = st.sidebar.slider("DC Reorder Point (weeks of cover)", 1, 6, 2, 1)
        dc_target_weeks  = st.sidebar.slider("DC Target Stock (weeks)",           2, 12, 5, 1)
        dc_start_days    = st.sidebar.number_input("DC Starting Stock (days)", min_value=1, max_value=90, value=30)
        dc_review_dow    = st.sidebar.selectbox("DC Review Day", ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"], index=0)

        st.sidebar.subheader("Supplier Config")
        sup_lead_min = st.sidebar.number_input("Lead Time Min (days)", min_value=1, max_value=14, value=3)
        sup_lead_max = st.sidebar.number_input("Lead Time Max (days)", min_value=1, max_value=30, value=7)
        sup_on_time  = st.sidebar.slider("Supplier On-Time Rate", 0.5, 1.0, 0.90, 0.05)
        sup_partial  = st.sidebar.slider("Supplier Partial Delivery Rate", 0.0, 0.5, 0.10, 0.05)

        st.sidebar.subheader("DC → Store Config")
        dc_lead_days = st.sidebar.number_input("DC → Store Lead Time (days)", min_value=1, max_value=14, value=2)
        dc_on_time   = st.sidebar.slider("DC On-Time Rate (global)", 0.5, 1.0, 0.95, 0.05)
        dc_partial   = st.sidebar.slider("DC Partial Delivery Rate (global)", 0.0, 0.3, 0.05, 0.05)

        _dc_list = entities.get("dcs", [])
        if not _dc_list and "sim_results" in ss:
            _prev = ss["sim_results"].get("dc_inv_df", pd.DataFrame())
            if not _prev.empty and "dc_code" in _prev.columns:
                _dc_list = [{"dc_code": c} for c in sorted(_prev["dc_code"].unique())]

        dc_on_time_by_dc: dict  = {}
        dc_partial_by_dc: dict  = {}
        dc_lead_days_by_dc: dict = {}

        if _dc_list:
            with st.sidebar.expander(f"Per-DC Delivery Rates & Lead Time ({len(_dc_list)} DCs)"):
                st.caption("Leave at global default or adjust per DC.")
                for _dc in _dc_list:
                    _code = _dc.get("dc_code", "") or _dc.get("dc_id", "")
                    if not _code:
                        continue
                    st.markdown(f"**{_code}**")
                    _ot = st.slider(f"On-time — {_code}", 0.5, 1.0, dc_on_time, 0.05, key=f"dc_ot_{_code}")
                    _pt = st.slider(f"Partial — {_code}", 0.0, 0.3, dc_partial, 0.05, key=f"dc_pt_{_code}")
                    _ld = st.number_input(f"Lead time (days) — {_code}", min_value=1, max_value=14,
                                          value=int(dc_lead_days), key=f"dc_ld_{_code}")
                    if _ot != dc_on_time:
                        dc_on_time_by_dc[_code] = _ot
                    if _pt != dc_partial:
                        dc_partial_by_dc[_code] = _pt
                    if int(_ld) != int(dc_lead_days):
                        dc_lead_days_by_dc[_code] = int(_ld)

        seed = st.sidebar.number_input("Random Seed", min_value=0, value=42)
        run_btn = st.sidebar.button("▶ Run Simulation", type="primary")

        st.sidebar.divider()
        st.sidebar.subheader("Run History")
        if st.sidebar.button("Refresh History"):
            ss.runs_list = None

        try:
            history_resp = httpx.get(f"{backend_url}/runs", params={"account_id": account_id}, timeout=10.0)
            history_resp.raise_for_status()
            runs = history_resp.json()
        except Exception as e:
            runs = []
            st.sidebar.warning(f"Could not load history: {e}")

        if runs:
            for run in runs[:10]:
                status = run.get("simulation_status", "?")
                icon   = "✅" if status == "COMPLETED" else ("❌" if status == "FAILED" else "⏳")
                st.sidebar.caption(
                    f"{icon} **{run.get('simulation_name', '—')}**  \n"
                    f"  {run.get('created_at', '')[:16]}  \n"
                    f"  {run.get('start_date', '')} → {run.get('end_date', '')}"
                )
        else:
            st.sidebar.caption("No runs yet.")

        col1, col2, col3, col4 = st.columns(4)

        # ── Run handler ───────────────────────────────────────────────────────
        if run_btn:
            if start_date >= end_date:
                st.error("Start date must be before end date.")
                st.stop()

            config = {
                "account_id":          account_id,
                "created_by":          ss.user_id,
                "simulation_name":     sim_name,
                "notes":               sim_notes,
                "start_date":          start_date.isoformat(),
                "end_date":            end_date.isoformat(),
                "replenishment_policy": replenishment_policy,
                "smoothing_days":      int(smoothing_days),
                "store_reorder_weeks": store_reorder_weeks,
                "store_target_weeks":  store_target_weeks,
                "store_start_days":    int(store_start_days),
                "store_order_dow":     store_order_dow,
                "dc_reorder_weeks":    dc_reorder_weeks,
                "dc_target_weeks":     dc_target_weeks,
                "dc_start_days":       int(dc_start_days),
                "dc_review_dow":       dc_review_dow,
                "sup_lead_min":        int(sup_lead_min),
                "sup_lead_max":        int(sup_lead_max),
                "sup_on_time":         sup_on_time,
                "sup_partial":         sup_partial,
                "dc_on_time":          dc_on_time,
                "dc_partial":          dc_partial,
                "dc_lead_days":        int(dc_lead_days),
                "dc_on_time_by_dc":    dc_on_time_by_dc,
                "dc_partial_by_dc":    dc_partial_by_dc,
                "dc_lead_days_by_dc":  dc_lead_days_by_dc,
                "seed":                int(seed),
            }

            _t_start = time.time()
            with st.spinner("Running simulation…"):
                try:
                    response = httpx.post(f"{backend_url}/run", json=config, timeout=300.0)
                    response.raise_for_status()
                except httpx.ConnectError as e:
                    show_error(f"Cannot reach backend at {backend_url}", e)
                    st.stop()
                except httpx.TimeoutException as e:
                    show_error("Simulation request timed out — try a shorter date range", e)
                    st.stop()
                except httpx.HTTPStatusError as e:
                    show_error("Simulation engine returned an error", e, e.response)
                    st.stop()
                except Exception as e:
                    show_error("Unexpected error", e)
                    st.stop()

            sim_duration = round(time.time() - _t_start, 1)
            resp   = response.json()
            sim_id = resp.get("simulation_id", "")
            st.success(f"Simulation complete. Run ID: `{sim_id}`")

            sales_daily_df = pd.DataFrame(resp.get("store_sales_daily", []))
            inv_daily_df   = pd.DataFrame(resp.get("store_inventory_daily", []))
            sales_hist_df  = pd.DataFrame(resp.get("sales_history", []))
            store_inv_df   = pd.DataFrame(resp.get("store_inventory", []))
            dc_inv_df      = pd.DataFrame(resp.get("dc_inventory", []))
            demand_df      = pd.DataFrame(resp.get("demand", []))
            sup_rec_df     = pd.DataFrame(resp.get("supplier_receipts", []))
            str_rec_df     = pd.DataFrame(resp.get("store_receipts", []))
            sup_orders_df  = pd.DataFrame(resp.get("supplier_orders", []))
            sup_od_df      = pd.DataFrame(resp.get("supplier_order_details", []))
            str_orders_df  = pd.DataFrame(resp.get("store_orders", []))
            store_od_df    = pd.DataFrame(resp.get("store_order_details", []))
            store_dc_map   = resp.get("store_dc_map", {})
            items_df       = pd.DataFrame(resp.get("items_meta", []))
            stores_df      = pd.DataFrame(resp.get("stores_meta", []))
            dcs_df         = pd.DataFrame(resp.get("dcs_meta", []))

            for col in ["demand_qty", "sales_qty", "lost_sales_qty", "sales_amount"]:
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

            ss["sim_results"] = {
                "sim_id":           sim_id,
                "sim_start_date":   start_date,
                "sim_end_date":     end_date,
                "sim_duration":     sim_duration,
                "sim_config_block": config,
                "items_df":         items_df,
                "stores_df":        stores_df,
                "sales_daily_df":   sales_daily_df,
                "inv_daily_df":     inv_daily_df,
                "demand_df":        demand_df,
                "sales_hist_df":    sales_hist_df,
                "store_inv_df":     store_inv_df,
                "dc_inv_df":        dc_inv_df,
                "sup_rec_df":       sup_rec_df,
                "str_rec_df":       str_rec_df,
                "sup_orders_df":    sup_orders_df,
                "sup_od_df":        sup_od_df,
                "str_orders_df":    str_orders_df,
                "store_od_df":      store_od_df,
                "store_dc_map":     store_dc_map,
                "dcs_df":           dcs_df,
            }
            # Invalidate runs cache so the new run appears
            ss.runs_list = None

        if "sim_results" in ss:
            _r             = ss["sim_results"]
            sim_id         = _r["sim_id"]
            start_date     = _r["sim_start_date"]
            end_date       = _r["sim_end_date"]
            items_df       = _r["items_df"]
            stores_df      = _r["stores_df"]
            sales_daily_df = _r["sales_daily_df"]
            inv_daily_df   = _r["inv_daily_df"]
            demand_df      = _r["demand_df"]
            sales_hist_df  = _r["sales_hist_df"]
            store_inv_df   = _r["store_inv_df"]
            dc_inv_df      = _r["dc_inv_df"]
            sup_rec_df     = _r["sup_rec_df"]
            str_rec_df     = _r["str_rec_df"]
            sup_orders_df  = _r["sup_orders_df"]
            sup_od_df      = _r["sup_od_df"]
            str_orders_df  = _r["str_orders_df"]
            store_od_df    = _r["store_od_df"]
            store_dc_map   = _r["store_dc_map"]
            dcs_df         = _r.get("dcs_df", pd.DataFrame())
            sim_duration   = _r.get("sim_duration")
            sim_config_block = _r.get("sim_config_block", {})

            col1.metric("Items",     len(items_df))
            col2.metric("Stores",    len(stores_df))
            col3.metric("DCs",       len(set(store_dc_map.values())))
            col4.metric("Suppliers", 0)

            st.divider()
            stores_list   = sorted(sales_daily_df["store_id"].unique().tolist()) if not sales_daily_df.empty else []
            items_list    = sorted(sales_daily_df["item_id"].unique().tolist())  if not sales_daily_df.empty else []
            item_code_map = items_df.set_index("item_id")["item_code"].to_dict() if not items_df.empty else {}
            items_display = {f"{item_code_map.get(iid, iid)}": iid for iid in items_list}

            col_sel1, col_sel2 = st.columns(2)
            sel_store      = col_sel1.selectbox("Store", stores_list)
            sel_item_label = col_sel2.selectbox("Item", list(items_display.keys()))
            sel_item       = items_display[sel_item_label]

            s_inv_d = inv_daily_df[
                (inv_daily_df["store_id"] == sel_store) & (inv_daily_df["item_id"] == sel_item)
            ].copy() if not inv_daily_df.empty else pd.DataFrame()
            s_sales_d = sales_daily_df[
                (sales_daily_df["store_id"] == sel_store) & (sales_daily_df["item_id"] == sel_item)
            ].copy() if not sales_daily_df.empty else pd.DataFrame()
            s_demand = demand_df[
                (demand_df["store_id"] == sel_store) & (demand_df["item_id"] == sel_item)
            ].copy() if not demand_df.empty else pd.DataFrame()
            s_sales_w = sales_hist_df[
                (sales_hist_df["store_id"] == sel_store) & (sales_hist_df["item_id"] == sel_item)
            ].copy() if not sales_hist_df.empty else pd.DataFrame()
            s_inv_w = store_inv_df[
                (store_inv_df["store_id"] == sel_store) & (store_inv_df["item_id"] == sel_item)
            ].copy() if not store_inv_df.empty else pd.DataFrame()

            avg_daily_d   = s_sales_d["demand_qty"].mean() if not s_sales_d.empty else 0
            trigger_units = int(round(store_reorder_weeks * avg_daily_d * 7))
            target_units  = int(round(store_target_weeks  * avg_daily_d * 7))
            st.caption(f"Min Inventory Trigger = **{store_reorder_weeks} weeks × {avg_daily_d:.1f} units/day × 7 = {trigger_units} units**")
            st.caption(f"Store Target Stock = **{store_target_weeks} weeks × {avg_daily_d:.1f} units/day × 7 = {target_units} units**")

            st.subheader(f"KPI — {sel_store} / {sel_item_label}")
            total_demand  = s_sales_d["demand_qty"].sum()     if not s_sales_d.empty else 0
            total_sales   = s_sales_d["sales_qty"].sum()      if not s_sales_d.empty else 0
            total_lost    = s_sales_d["lost_sales_qty"].sum() if not s_sales_d.empty else 0
            fill_rate     = total_sales / total_demand * 100  if total_demand > 0 else 0
            stockout_days = (s_inv_d["inventory_status"] == "ZERO").sum() if not s_inv_d.empty else 0
            total_revenue = s_sales_d["sales_amount"].sum()   if not s_sales_d.empty else 0

            k1, k2, k3, k4, k5, k6 = st.columns(6)
            k1.metric("Total Demand",  f"{total_demand:,.0f}")
            k2.metric("Total Sales",   f"{total_sales:,.0f}")
            k3.metric("Lost Sales",    f"{total_lost:,.0f}")
            k4.metric("Fill Rate",     f"{fill_rate:.1f}%")
            k5.metric("Stockout Days", f"{stockout_days:,}")
            k6.metric("Revenue",       f"${total_revenue:,.0f}")

            # Promo shading helpers
            promo_date_ranges = []
            if not s_demand.empty and "is_promo_demand" in s_demand.columns:
                sd = s_demand.sort_values("demand_date").copy()
                in_promo = False
                span_start = None
                for _, row in sd.iterrows():
                    if row["is_promo_demand"] and not in_promo:
                        span_start = row["demand_date"]
                        in_promo   = True
                    elif not row["is_promo_demand"] and in_promo:
                        promo_date_ranges.append((span_start, row["demand_date"] - pd.Timedelta(days=1)))
                        in_promo = False
                if in_promo and span_start is not None:
                    promo_date_ranges.append((span_start, sd["demand_date"].iloc[-1]))

            promo_weeks: set = set()
            if not s_demand.empty and "is_promo_demand" in s_demand.columns and "demand_week" in s_demand.columns:
                promo_weeks = set(s_demand[s_demand["is_promo_demand"] == True]["demand_week"].unique())

            def add_promo_shading_daily(fig):
                added = False
                for x0, x1 in promo_date_ranges:
                    fig.add_vrect(
                        x0=x0, x1=x1 + pd.Timedelta(days=1),
                        fillcolor="rgba(255,180,0,0.18)", layer="below", line_width=0,
                        name="Promo Period" if not added else None,
                        showlegend=not added, legendgroup="promo",
                    )
                    added = True

            def add_promo_shading_weekly(fig, weeks_list):
                added = False
                for i, w in enumerate(weeks_list):
                    if w in promo_weeks:
                        fig.add_vrect(
                            x0=i - 0.5, x1=i + 0.5,
                            fillcolor="rgba(255,180,0,0.22)", layer="below", line_width=0,
                            name="Promo Week" if not added else None,
                            showlegend=not added, legendgroup="promo_w",
                        )
                        added = True

            st.divider()
            st.subheader("Inventory & Sales Charts")
            st.markdown("#### Daily: Demand vs Sales vs Inventory")
            fig_daily = go.Figure()

            if not s_sales_d.empty and not s_inv_d.empty:
                s_daily = s_sales_d.merge(s_inv_d[["date", "on_hand_qty"]], on="date", how="left")
                day_lbl = s_daily["date"].dt.strftime("%a, %b %d %Y")
                inv_lbl = s_inv_d["date"].dt.strftime("%a, %b %d %Y")
                fig_daily.add_trace(go.Bar(x=s_daily["date"], y=s_daily["demand_qty"],
                    name="Demand", marker_color="#BAD7F2", opacity=0.85,
                    hovertemplate="<b>%{customdata}</b><br>Demand: %{y}<extra></extra>",
                    customdata=day_lbl))
                fig_daily.add_trace(go.Bar(x=s_daily["date"], y=s_daily["sales_qty"],
                    name="Sales (Fulfilled)", marker_color="#2E86AB", opacity=0.9,
                    hovertemplate="<b>%{customdata}</b><br>Sales: %{y}<extra></extra>",
                    customdata=day_lbl))
                lost_colors = ["#db5546" if oh == 0 else "#F1948A" for oh in s_daily["on_hand_qty"]]
                fig_daily.add_trace(go.Bar(x=s_daily["date"], y=s_daily["lost_sales_qty"],
                    name="Lost Sales", marker_color=lost_colors, opacity=0.9,
                    hovertemplate="<b>%{customdata}</b><br>Lost: %{y}<extra></extra>",
                    customdata=day_lbl))
                fig_daily.add_trace(go.Scatter(x=s_inv_d["date"], y=s_inv_d["on_hand_qty"],
                    name="On-Hand Inventory", mode="lines",
                    line=dict(color="#E84855", width=2), yaxis="y2",
                    hovertemplate="<b>%{customdata}</b><br>On-Hand: %{y}<extra></extra>",
                    customdata=inv_lbl))
                fig_daily.add_trace(go.Scatter(x=s_inv_d["date"], y=s_inv_d["on_order_qty"],
                    name="On-Order", mode="lines",
                    line=dict(color="#F4A261", width=1.5, dash="dot"), yaxis="y2",
                    hovertemplate="<b>%{customdata}</b><br>On-Order: %{y}<extra></extra>",
                    customdata=inv_lbl))
                add_promo_shading_daily(fig_daily)

            fig_daily.update_layout(
                barmode="group",
                xaxis=dict(title="Date"),
                yaxis=dict(title="Units (Demand / Sales)", side="left"),
                yaxis2=dict(title="Units (Inventory)", overlaying="y", side="right", showgrid=False),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                height=420,
            )
            st.plotly_chart(fig_daily, use_container_width=True)

            st.markdown("#### Weekly: Demand vs Sales vs Inventory")
            fig_weekly = go.Figure()

            if not s_sales_w.empty:
                weeks_list = sorted(s_sales_w["sales_week"].unique().tolist())
                if not s_inv_w.empty:
                    weekly_df = s_sales_w.merge(
                        s_inv_w[["sales_week" if "sales_week" in s_inv_w.columns else "inventory_week",
                                  "on_hand_quantity"]].rename(columns={"inventory_week": "sales_week"}),
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
                    x=weekly_df["sales_week"], y=weekly_df.get("demand_quantity", weekly_df["sales_quantity"]),
                    name="Demand", marker_color="#BAD7F2", opacity=0.85))
                fig_weekly.add_trace(go.Bar(
                    x=weekly_df["sales_week"], y=weekly_df["sales_quantity"],
                    name="Sales", marker_color="#2E86AB", opacity=0.9))
                if "on_hand_quantity" in weekly_df.columns:
                    fig_weekly.add_trace(go.Scatter(
                        x=weekly_df["sales_week"], y=weekly_df["on_hand_quantity"],
                        name="On-Hand (EOW)", mode="lines+markers",
                        line=dict(color="#F4A261", width=2), yaxis="y2"))
                add_promo_shading_weekly(fig_weekly, weeks_list)

            fig_weekly.update_layout(
                barmode="group",
                xaxis=dict(title="Week", tickangle=-45),
                yaxis=dict(title="Units (Demand / Sales)", side="left"),
                yaxis2=dict(title="Units (Inventory EOW)", overlaying="y", side="right", showgrid=False),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                height=420,
            )
            st.plotly_chart(fig_weekly, use_container_width=True)

            st.divider()
            st.subheader(f"Inventory Status — All Stores for {sel_item_label}")
            if not inv_daily_df.empty:
                heat_df = inv_daily_df[inv_daily_df["item_id"] == sel_item].copy()
                heat_df["date"] = pd.to_datetime(heat_df["date"])
                status_num_map = {"AVAILABLE": 2, "LOW": 1, "ZERO": 0}
                heat_df["status_num"] = heat_df["inventory_status"].map(status_num_map)
                pivot = heat_df.pivot_table(index="store_id", columns="date", values="status_num", aggfunc="first")
                y_labels = [f"► {s}" if s == sel_store else s for s in pivot.index.tolist()]
                fig_heat = go.Figure(go.Heatmap(
                    z=pivot.values, x=pivot.columns.astype(str), y=y_labels,
                    colorscale=[[0, "#E84855"], [0.5, "#F4A261"], [1, "#2E86AB"]],
                    zmin=0, zmax=2,
                    colorbar=dict(tickvals=[0, 1, 2], ticktext=["ZERO", "LOW", "AVAILABLE"]),
                ))
                fig_heat.update_layout(
                    height=max(200, len(stores_list) * 35 + 80),
                    xaxis_title="Date", yaxis_title="Store",
                )
                st.plotly_chart(fig_heat, use_container_width=True)

            st.divider()
            st.subheader(f"Raw Output Tables — {sel_store} / {sel_item_label}")

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

            def _has_cols(df, *cols):
                return not df.empty and all(c in df.columns for c in cols)

            if _has_cols(str_rec_df, "store_id", "item_id"):
                with st.expander("Store Receipts"):
                    st.dataframe(str_rec_df[(str_rec_df["store_id"] == sel_store) & (str_rec_df["item_id"] == sel_item)].reset_index(drop=True))
            if _has_cols(store_od_df, "store_id", "item_id"):
                with st.expander("Store Order Details"):
                    st.dataframe(store_od_df[(store_od_df["store_id"] == sel_store) & (store_od_df["item_id"] == sel_item)].reset_index(drop=True))
            if _has_cols(str_orders_df, "store_id"):
                with st.expander("Store Orders (header)"):
                    st.dataframe(str_orders_df[str_orders_df["store_id"] == sel_store].reset_index(drop=True))
            if _has_cols(sup_rec_df, "item_id"):
                with st.expander("Supplier Receipts"):
                    st.dataframe(sup_rec_df[sup_rec_df["item_id"] == sel_item].reset_index(drop=True))
            if _has_cols(sup_orders_df, "dc_id"):
                with st.expander("Supplier Orders (for DC serving this store)"):
                    sel_dc = store_dc_map.get(sel_store)
                    st.dataframe((sup_orders_df[sup_orders_df["dc_id"] == sel_dc] if sel_dc else sup_orders_df).reset_index(drop=True))
            if _has_cols(sup_od_df, "item_id"):
                with st.expander("Supplier Order Details"):
                    st.dataframe(sup_od_df[sup_od_df["item_id"] == sel_item].reset_index(drop=True))
            if _has_cols(dc_inv_df, "dc_id", "item_id"):
                with st.expander("DC Inventory (Weekly)"):
                    sel_dc = store_dc_map.get(sel_store)
                    st.dataframe((dc_inv_df[(dc_inv_df["dc_id"] == sel_dc) & (dc_inv_df["item_id"] == sel_item)] if sel_dc else dc_inv_df).reset_index(drop=True))

            st.divider()
            st.subheader("Validation")

            _all_dfs = _prepare_export_dfs(
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
                export_dfs=_all_dfs, validation_passed=dq_report["validation_passed"],
            )
            _extra_files = {
                "run_manifest.json":        json.dumps(manifest,  indent=2),
                "data_quality_report.json": json.dumps(dq_report, indent=2),
            }

            if dq_report["validation_passed"]:
                st.success("**All checks passed** — data quality validated.")
            else:
                st.error("**Validation failed** — one or more checks did not pass.")

            _check_rows = [
                {"Check": c["name"], "Passed": "✅" if c["passed"] else "❌", "Violations": c["violations"]}
                for c in dq_report["checks"]
            ]
            st.dataframe(pd.DataFrame(_check_rows), use_container_width=True, hide_index=True)

            with st.expander("run_manifest.json"):
                st.code(_extra_files["run_manifest.json"], language="json")
            with st.expander("data_quality_report.json"):
                st.code(_extra_files["data_quality_report.json"], language="json")

            st.divider()
            st.subheader("Output Data Feeds")

            sel_store_code = stores_df.loc[stores_df["store_id"] == sel_store, "store_code"].iloc[0] \
                if not stores_df.loc[stores_df["store_id"] == sel_store, "store_code"].empty else sel_store
            feed_mode = st.radio(
                "View / download",
                [f"Filtered — {sel_store_code} / {sel_item_label}", "All Stores & Items"],
                horizontal=True, key="feed_mode",
            )
            filtered_mode = feed_mode.startswith("Filtered")
            fs = sel_store if filtered_mode else None
            fi = sel_item  if filtered_mode else None

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
                    extra_files=_extra_files,
                )
                st.download_button(
                    label=f"⬇ Download filtered ({sel_store_code} / {sel_item_label})",
                    data=zip_filtered,
                    file_name=f"metrai_export_{sel_store_code}_{sel_item_label}.zip",
                    mime="application/zip", use_container_width=True,
                )
            with dl_col2:
                zip_all = _build_zip(_all_dfs, extra_files=_extra_files)
                st.download_button(
                    label="⬇ Download all data",
                    data=zip_all, file_name="metrai_export_all.zip",
                    mime="application/zip", use_container_width=True,
                )

        else:
            col1.metric("Items",     "—")
            col2.metric("Stores",    "—")
            col3.metric("DCs",       "—")
            col4.metric("Suppliers", "—")
            st.info("Configure parameters in the sidebar and click **▶ Run Simulation** to start.")
