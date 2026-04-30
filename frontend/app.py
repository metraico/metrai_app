"""
frontend/app.py — Metrai Simulation Dashboard
Streamlit frontend that calls the Metrai backend API to run simulations.
Functionally identical to the POC debug_app.py, adapted to be API-driven.
"""

import os
import re as _re
from datetime import date

import httpx
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from dotenv import load_dotenv

load_dotenv()
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")

st.set_page_config(page_title="Metrai Simulation", layout="wide")
st.title("Metrai Simulation Dashboard")

# ── Sidebar: configuration ────────────────────────────────────────────────────

st.sidebar.header("Simulation Config")

dataset = st.sidebar.selectbox(
    "Dataset",
    ["saltysnack_beverages_small", "saltysnack_beverages"],
)

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
store_reorder_weeks  = st.sidebar.slider("Min Inventory Trigger (weeks of cover)", 1, 4, 2, 1)
store_target_weeks   = st.sidebar.slider("Store Target Stock (weeks)",           1, 8, 3, 1)
store_start_days     = st.sidebar.number_input("Store Starting Stock (days)", min_value=1, max_value=60, value=14)
store_order_dow      = st.sidebar.selectbox("Store Order Day", ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"], index=0)

st.sidebar.subheader("DC Config")
dc_reorder_weeks     = st.sidebar.slider("DC Reorder Point (weeks of cover)", 1, 6, 2, 1)
dc_target_weeks      = st.sidebar.slider("DC Target Stock (weeks)",           2, 12, 5, 1)
dc_start_days        = st.sidebar.number_input("DC Starting Stock (days)", min_value=1, max_value=90, value=30)
dc_review_dow        = st.sidebar.selectbox("DC Review Day", ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"], index=0)

st.sidebar.subheader("Supplier Config")
sup_lead_min   = st.sidebar.number_input("Lead Time Min (days)", min_value=1, max_value=14, value=3)
sup_lead_max   = st.sidebar.number_input("Lead Time Max (days)", min_value=1, max_value=30, value=7)
sup_on_time    = st.sidebar.slider("Supplier On-Time Rate", 0.5, 1.0, 0.90, 0.05)
sup_partial    = st.sidebar.slider("Supplier Partial Delivery Rate", 0.0, 0.5, 0.10, 0.05)

st.sidebar.subheader("DC → Store Config")
dc_on_time   = st.sidebar.slider("DC On-Time Rate", 0.5, 1.0, 0.95, 0.05)
dc_partial   = st.sidebar.slider("DC Partial Delivery Rate", 0.0, 0.3, 0.05, 0.05)

seed = st.sidebar.number_input("Random Seed", min_value=0, value=42)

run_btn = st.sidebar.button("▶ Run Simulation", type="primary")

# ── Summary placeholder metrics (shown before run) ────────────────────────────

col1, col2, col3, col4 = st.columns(4)

# ── Run button ────────────────────────────────────────────────────────────────

if run_btn:
    if start_date >= end_date:
        st.error("Start date must be before end date.")
        st.stop()

    config = {
        "dataset": dataset,
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
        "seed": int(seed),
    }

    with st.spinner("Running simulation…"):
        try:
            response = httpx.post(f"{BACKEND_URL}/run", json=config, timeout=300.0)
            response.raise_for_status()
        except httpx.ConnectError:
            st.error(f"Cannot reach backend at {BACKEND_URL}. Is the backend running?")
            st.stop()
        except httpx.TimeoutException:
            st.error("The simulation request timed out. Try a shorter date range.")
            st.stop()
        except httpx.HTTPStatusError as e:
            st.error(f"Backend returned an error ({e.response.status_code}): {e.response.text}")
            st.stop()

    resp = response.json()

    # ── Reconstruct DataFrames ────────────────────────────────────────────────
    demand_df     = pd.DataFrame(resp["demand"])
    sales_df      = pd.DataFrame(resp["sales"])
    inv_df        = pd.DataFrame(resp["inventory"])
    sup_rec_df    = pd.DataFrame(resp["supplier_receipts"])
    str_rec_df    = pd.DataFrame(resp["store_receipts"])
    sup_orders_df = pd.DataFrame(resp["supplier_orders"])
    str_orders_df = pd.DataFrame(resp["store_orders"])
    store_od_df   = pd.DataFrame(resp["store_order_details"])
    store_dc_map  = resp["store_dc_map"]
    items_df      = pd.DataFrame(resp["items_meta"])
    stores_df     = pd.DataFrame(resp["stores_meta"])

    # ── Convert numeric columns ───────────────────────────────────────────────
    for col in ["demand_qty", "sales_qty", "lost_sales_qty", "sales_amount"]:
        if col in sales_df.columns:
            sales_df[col] = pd.to_numeric(sales_df[col])

    for col in ["on_hand_qty", "on_order_qty", "woc"]:
        if col in inv_df.columns:
            inv_df[col] = pd.to_numeric(inv_df[col], errors="coerce")

    if "demand_qty" in demand_df.columns:
        demand_df["demand_qty"] = pd.to_numeric(demand_df["demand_qty"])

    # ── Convert date columns ──────────────────────────────────────────────────
    if "date" in sales_df.columns:
        sales_df["date"] = pd.to_datetime(sales_df["date"])
    if "date" in inv_df.columns:
        inv_df["date"] = pd.to_datetime(inv_df["date"])
    if "date" in demand_df.columns:
        demand_df["date"] = pd.to_datetime(demand_df["date"])

    # ── Fix is_promo column ───────────────────────────────────────────────────
    if "is_promo" in demand_df.columns:
        demand_df["is_promo"] = demand_df["is_promo"].map({"True": True, "False": False})

    # ── Summary metrics ───────────────────────────────────────────────────────
    col1.metric("Items",     len(items_df))
    col2.metric("Stores",    len(stores_df))
    col3.metric("DCs",       len(set(store_dc_map.values())))
    col4.metric("Suppliers", 0)

    # ── Store / Item selectors (drives everything below) ─────────────────────
    st.divider()
    stores_list = sorted(sales_df["store_id"].unique().tolist())
    items_list  = sorted(sales_df["item_id"].unique().tolist())
    item_desc   = items_df.set_index("item_id")["item_description"].to_dict()
    items_display = {f"{iid} — {item_desc.get(iid, iid)}": iid for iid in items_list}

    col_sel1, col_sel2 = st.columns(2)
    sel_store      = col_sel1.selectbox("Store", stores_list)
    sel_item_label = col_sel2.selectbox("Item", list(items_display.keys()))
    sel_item       = items_display[sel_item_label]

    # All filtered views
    s_inv   = inv_df[(inv_df["store_id"] == sel_store) & (inv_df["item_id"] == sel_item)].copy()
    s_sales = sales_df[(sales_df["store_id"] == sel_store) & (sales_df["item_id"] == sel_item)].copy()
    s_demand= demand_df[(demand_df["store_id"] == sel_store) & (demand_df["item_id"] == sel_item)].copy()

    s_inv["date"]   = pd.to_datetime(s_inv["date"])
    s_sales["date"] = pd.to_datetime(s_sales["date"])

    # ── Min Inventory Trigger info ────────────────────────────────────────────
    avg_daily = s_sales["demand_qty"].mean() if not s_sales.empty else 0
    trigger_units = int(round(store_reorder_weeks * avg_daily * 7))
    target_units  = int(round(store_target_weeks * avg_daily * 7))
    st.caption(f"Min Inventory Trigger = **{store_reorder_weeks} weeks × {avg_daily:.1f} units/day × 7 = {trigger_units} units** — order fires when stock drops below this.")
    st.caption(f"Store Target Stock = **{store_target_weeks} weeks × {avg_daily:.1f} units/day × 7 = {target_units} units** — stock is replenished up to this level.")

    # ── KPI summary (filtered to selected store + item) ───────────────────────
    st.subheader(f"KPI — {sel_store} / {sel_item_label}")
    total_demand  = s_sales["demand_qty"].sum()
    total_sales   = s_sales["sales_qty"].sum()
    total_lost    = s_sales["lost_sales_qty"].sum()
    fill_rate     = total_sales / total_demand * 100 if total_demand > 0 else 0
    stockout_days = (s_inv["inventory_status"] == "ZERO").sum()
    total_revenue = s_sales["sales_amount"].sum()

    k1, k2, k3, k4, k5, k6 = st.columns(6)
    k1.metric("Total Demand",   f"{total_demand:,.0f}")
    k2.metric("Total Sales",    f"{total_sales:,.0f}")
    k3.metric("Lost Sales",     f"{total_lost:,.0f}")
    k4.metric("Fill Rate",      f"{fill_rate:.1f}%")
    k5.metric("Stockout Days",  f"{stockout_days:,}")
    k6.metric("Revenue",        f"${total_revenue:,.0f}")

    # ── Compute promo spans from s_demand ────────────────────────────────────
    promo_date_ranges = []
    if "is_promo" in s_demand.columns and s_demand["is_promo"].any():
        sd = s_demand.sort_values("date").copy()
        sd["date"] = pd.to_datetime(sd["date"])
        in_promo = False
        span_start = None
        for _, row in sd.iterrows():
            if row["is_promo"] and not in_promo:
                span_start = row["date"]
                in_promo = True
            elif not row["is_promo"] and in_promo:
                promo_date_ranges.append((span_start, row["date"] - pd.Timedelta(days=1)))
                in_promo = False
        if in_promo:
            promo_date_ranges.append((span_start, sd["date"].iloc[-1]))

    # Promo weeks set
    promo_weeks = set()
    if "is_promo" in s_demand.columns:
        promo_weeks = set(s_demand[s_demand["is_promo"] == True]["week"].unique())

    def add_promo_shading_daily(fig):
        added_legend = False
        for x0, x1 in promo_date_ranges:
            fig.add_vrect(
                x0=x0, x1=x1 + pd.Timedelta(days=1),
                fillcolor="rgba(255, 180, 0, 0.18)",
                layer="below", line_width=0,
                name="Promo Period" if not added_legend else None,
                showlegend=not added_legend,
                legendgroup="promo",
            )
            added_legend = True

    def add_promo_shading_weekly(fig, weeks_list):
        added_legend = False
        for i, w in enumerate(weeks_list):
            if w in promo_weeks:
                fig.add_vrect(
                    x0=i - 0.5, x1=i + 0.5,
                    fillcolor="rgba(255, 180, 0, 0.22)",
                    layer="below", line_width=0,
                    name="Promo Week" if not added_legend else None,
                    showlegend=not added_legend,
                    legendgroup="promo_w",
                )
                added_legend = True

    # ── Chart 1: Daily — Demand bar + Sales bar + On-hand line ───────────────
    st.divider()
    st.subheader("Inventory & Sales Charts")
    st.markdown("#### Daily: Demand vs Sales vs Inventory")
    fig_daily = go.Figure()

    s_daily = s_sales.merge(s_inv[["date", "on_hand_qty"]], on="date", how="left")
    lost_colors = ["#db5546" if oh == 0 else "#F1948A" for oh in s_daily["on_hand_qty"]]
    day_labels = s_daily["date"].dt.strftime("%a, %b %d %Y")
    inv_day_labels = s_inv["date"].dt.strftime("%a, %b %d %Y")

    fig_daily.add_trace(go.Bar(
        x=s_daily["date"], y=s_daily["demand_qty"],
        name="Demand", marker_color="#BAD7F2", opacity=0.85,
        hovertemplate="<b>%{customdata}</b><br>Demand: %{y}<extra></extra>",
        customdata=day_labels,
    ))
    fig_daily.add_trace(go.Bar(
        x=s_daily["date"], y=s_daily["sales_qty"],
        name="Sales (Fulfilled)", marker_color="#2E86AB", opacity=0.9,
        hovertemplate="<b>%{customdata}</b><br>Sales: %{y}<extra></extra>",
        customdata=day_labels,
    ))
    fig_daily.add_trace(go.Bar(
        x=s_daily["date"], y=s_daily["lost_sales_qty"],
        name="Lost Sales (Unmet Demand)",
        marker_color=lost_colors, opacity=0.9,
        hovertemplate="<b>%{customdata}</b><br>Lost Sales: %{y}<extra></extra>",
        customdata=day_labels,
    ))
    fig_daily.add_trace(go.Scatter(
        x=s_inv["date"], y=s_inv["on_hand_qty"],
        name="On-Hand Inventory", mode="lines",
        line=dict(color="#E84855", width=2),
        yaxis="y2",
        hovertemplate="<b>%{customdata}</b><br>On-Hand: %{y}<extra></extra>",
        customdata=inv_day_labels,
    ))
    fig_daily.add_trace(go.Scatter(
        x=s_inv["date"], y=s_inv["on_order_qty"],
        name="On-Order", mode="lines",
        hovertemplate="<b>%{customdata}</b><br>On-Order: %{y}<extra></extra>",
        customdata=inv_day_labels,
        line=dict(color="#F4A261", width=1.5, dash="dot"),
        yaxis="y2",
    ))

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

    # ── Chart 2: Weekly — aggregate sales + demand + avg inventory ───────────
    st.markdown("#### Weekly: Demand vs Sales vs Avg Inventory")

    weekly_sales_df = (
        s_sales.groupby("week", sort=True)
        .agg(demand_qty=("demand_qty", "sum"), sales_qty=("sales_qty", "sum"), lost_sales_qty=("lost_sales_qty", "sum"))
        .reset_index()
    )
    weekly_inv_df = (
        s_inv.groupby("week", sort=True)
        .agg(avg_on_hand=("on_hand_qty", "mean"))
        .reset_index()
    )
    weekly_df = weekly_sales_df.merge(weekly_inv_df, on="week", how="left")

    fig_weekly = go.Figure()
    fig_weekly.add_trace(go.Bar(
        x=weekly_df["week"], y=weekly_df["demand_qty"],
        name="Demand", marker_color="#BAD7F2", opacity=0.85,
    ))
    fig_weekly.add_trace(go.Bar(
        x=weekly_df["week"], y=weekly_df["sales_qty"],
        name="Sales", marker_color="#2E86AB", opacity=0.9,
    ))
    fig_weekly.add_trace(go.Bar(
        x=weekly_df["week"], y=weekly_df["lost_sales_qty"],
        name="Lost Sales", marker_color="#E84855", opacity=0.7,
    ))
    fig_weekly.add_trace(go.Scatter(
        x=weekly_df["week"], y=weekly_df["avg_on_hand"],
        name="Avg On-Hand Inventory", mode="lines+markers",
        line=dict(color="#F4A261", width=2),
        yaxis="y2",
    ))

    add_promo_shading_weekly(fig_weekly, weekly_df["week"].tolist())
    fig_weekly.update_layout(
        barmode="group",
        xaxis=dict(title="Week", tickangle=-45),
        yaxis=dict(title="Units (Demand / Sales)", side="left"),
        yaxis2=dict(title="Avg Units (Inventory)", overlaying="y", side="right", showgrid=False),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
        height=420,
    )
    st.plotly_chart(fig_weekly, use_container_width=True)

    # ── Chart 3: Inventory status heatmap (all stores × time, item = sel_item) ─
    st.divider()
    st.subheader(f"Inventory Status — All Stores for {sel_item_label}")
    st.caption(f"Selected store **{sel_store}** is highlighted with a marker on the y-axis.")

    heat_df = inv_df[inv_df["item_id"] == sel_item].copy()
    heat_df["date"] = pd.to_datetime(heat_df["date"])
    status_num_map = {"AVAILABLE": 2, "LOW": 1, "ZERO": 0}
    heat_df["status_num"] = heat_df["inventory_status"].map(status_num_map)

    pivot = heat_df.pivot_table(index="store_id", columns="date", values="status_num", aggfunc="first")

    y_labels = [f"► {s}" if s == sel_store else s for s in pivot.index.tolist()]

    fig_heat = go.Figure(go.Heatmap(
        z=pivot.values,
        x=pivot.columns.astype(str),
        y=y_labels,
        colorscale=[[0, "#E84855"], [0.5, "#F4A261"], [1, "#2E86AB"]],
        zmin=0, zmax=2,
        colorbar=dict(
            tickvals=[0, 1, 2],
            ticktext=["ZERO", "LOW", "AVAILABLE"],
        ),
    ))
    fig_heat.update_layout(height=max(200, len(stores_list)*35+80), xaxis_title="Date", yaxis_title="Store")
    st.plotly_chart(fig_heat, use_container_width=True)

    # ── Raw data expanders (all filtered to sel_store + sel_item) ────────────
    st.divider()
    st.subheader(f"Raw Output Tables — {sel_store} / {sel_item_label}")

    with st.expander("Demand Matrix"):
        st.dataframe(s_demand.reset_index(drop=True))

    with st.expander("Daily Sales"):
        st.dataframe(s_sales.reset_index(drop=True))

    with st.expander("Daily Store Inventory"):
        st.dataframe(s_inv.reset_index(drop=True))

    if not str_rec_df.empty:
        with st.expander("Store Receipts"):
            filt = str_rec_df[
                (str_rec_df["store_id"] == sel_store) &
                (str_rec_df["item_id"]  == sel_item)
            ]
            st.dataframe(filt.reset_index(drop=True))

    if not store_od_df.empty:
        with st.expander("Store Order Details"):
            filt = store_od_df[
                (store_od_df["store_id"] == sel_store) &
                (store_od_df["item_id"]  == sel_item)
            ]
            st.dataframe(filt.reset_index(drop=True))

    if not str_orders_df.empty:
        with st.expander("Store Orders (header)"):
            filt = str_orders_df[str_orders_df["store_id"] == sel_store]
            st.dataframe(filt.reset_index(drop=True))

    if not sup_rec_df.empty:
        with st.expander("Supplier Receipts"):
            filt = sup_rec_df[sup_rec_df["item_id"] == sel_item]
            st.dataframe(filt.reset_index(drop=True))

    if not sup_orders_df.empty:
        with st.expander("Supplier Orders (for DC serving this store)"):
            sel_dc = store_dc_map.get(sel_store)
            filt   = sup_orders_df[sup_orders_df["dc_id"] == sel_dc] if sel_dc else sup_orders_df
            st.dataframe(filt.reset_index(drop=True))

else:
    col1.metric("Items",     "—")
    col2.metric("Stores",    "—")
    col3.metric("DCs",       "—")
    col4.metric("Suppliers", "—")
    st.info("Configure parameters in the sidebar and click **▶ Run Simulation** to start.")
