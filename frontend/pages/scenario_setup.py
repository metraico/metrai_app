"""
Scenario setup wizard.

Two scenario tiles:
  1. Promo Forecast Behavior — inject a realization gap into one promo event.
  2. Hidden Lost Sales       — block DC deliveries for a selected week.

Each tile leads to a config form that includes full sim params in an expander,
then fires /run with scenario params embedded and navigates to the simulation page.
"""
from datetime import date, timedelta

import httpx
import streamlit as st

import api
from router import go_to


_TILES = [
    {
        "id": "promo_forecast",
        "title": "Promo Forecast Behavior",
        "description": (
            "Inject a demand realization gap into one promo event. "
            "The system forecasts normal promo demand; actual shelf demand is "
            "50%+ higher or lower. Observe the post-promo replenishment distortion "
            "as the trailing average learns from the anomalous week."
        ),
    },
    {
        "id": "hidden_lost_sales",
        "title": "Hidden Lost Sales",
        "description": (
            "Block DC deliveries to stores for a selected week. "
            "With replenishment learning from observable sales, the suppressed "
            "sales corrupt the moving average — causing under-ordering in the "
            "weeks after deliveries resume."
        ),
    },
]


# ─── Helpers ────────────────────────────────────────────────────────────────

def _fetch_promos(account_id):
    key = f"promos_{account_id}"
    if key not in st.session_state:
        try:
            st.session_state[key] = api.fetch_promos(account_id)
        except Exception as e:
            st.error(f"Could not load promos: {e}")
            st.session_state[key] = []
    return st.session_state[key]


def _run_sim(config: dict):
    try:
        with st.spinner("Running simulation…"):
            return api.run_simulation(config)
    except httpx.HTTPStatusError as e:
        st.error(f"Engine error {e.response.status_code}: {e.response.text}")
    except httpx.ConnectError:
        st.error("Cannot reach simulation engine.")
    except Exception as e:
        st.error(str(e))
    return None


# ─── Shared sim config expander ─────────────────────────────────────────────

def _render_sim_config_form(key_prefix: str) -> dict:
    """Expandable simulation config section. Always returns current values."""
    with st.expander("Simulation Config (click to customise — defaults pre-filled)", expanded=False):
        col_l, col_r = st.columns(2)
        with col_l:
            start_date = st.date_input("Start Date", value=date(2024, 1, 1), key=f"{key_prefix}_sd")
            end_date   = st.date_input("End Date",   value=date(2024, 12, 31), key=f"{key_prefix}_ed")
            policy = st.selectbox(
                "Replenishment Policy",
                ["trailing_avg_28d", "promo_aware_7d", "baseline_only"],
                key=f"{key_prefix}_pol",
            )
            smoothing_days = st.number_input("Demand Smoothing Window (days)", 7, 90, 28, key=f"{key_prefix}_sm")
            seed = st.number_input("Random Seed", 0, value=42, key=f"{key_prefix}_seed")

        with col_r:
            with st.container(border=True):
                st.caption("Store Config")
                store_reorder_weeks = st.slider("Min Inventory Trigger (weeks)", 1, 4, 2, key=f"{key_prefix}_srw")
                store_target_weeks  = st.slider("Target Stock (weeks)", 1, 8, 3, key=f"{key_prefix}_stw")
                store_start_days    = st.number_input("Starting Inventory (days)", 1, 60, 14, key=f"{key_prefix}_ssd")
                store_order_dow     = st.selectbox("Store Order Day",
                    ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"], key=f"{key_prefix}_sod")
            with st.container(border=True):
                st.caption("DC Config")
                dc_reorder_weeks = st.slider("DC Min Inventory Trigger (weeks)", 1, 6, 2, key=f"{key_prefix}_drw")
                dc_target_weeks  = st.slider("DC Target Stock (weeks)", 2, 12, 5, key=f"{key_prefix}_dtw")
                dc_start_days    = st.number_input("DC Starting Inventory (days)", 1, 90, 30, key=f"{key_prefix}_dsd")
                dc_review_dow    = st.selectbox("DC Review Day",
                    ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"], key=f"{key_prefix}_drd")
            with st.container(border=True):
                st.caption("Supplier & DC Lead")
                sup_lead_min = st.number_input("Supplier lead min (days)", 1, 14, 3, key=f"{key_prefix}_slmin")
                sup_lead_max = st.number_input("Supplier lead max (days)", 1, 30, 7, key=f"{key_prefix}_slmax")
                sup_on_time  = st.slider("Supplier on-time rate", 0.5, 1.0, 0.90, 0.05, key=f"{key_prefix}_sot")
                sup_partial  = st.slider("Supplier partial rate", 0.0, 0.5, 0.10, 0.05, key=f"{key_prefix}_sp")
                dc_lead_days = st.number_input("DC→Store lead time (days)", 1, 14, 2, key=f"{key_prefix}_dcld")
                dc_on_time   = st.slider("DC on-time rate", 0.5, 1.0, 0.95, 0.05, key=f"{key_prefix}_dcot")
                dc_partial   = st.slider("DC partial rate", 0.0, 0.3, 0.05, 0.05, key=f"{key_prefix}_dcp")

    def _get(k, default):
        v = st.session_state.get(k, default)
        return v if v is not None else default

    def _date_iso(k, default):
        v = _get(k, default)
        return v.isoformat() if hasattr(v, "isoformat") else default.isoformat()

    return {
        "start_date":           _date_iso(f"{key_prefix}_sd",  date(2024, 1, 1)),
        "end_date":             _date_iso(f"{key_prefix}_ed",  date(2024, 12, 31)),
        "replenishment_policy": _get(f"{key_prefix}_pol", "trailing_avg_28d"),
        "smoothing_days":       int(_get(f"{key_prefix}_sm",   28)),
        "seed":                 int(_get(f"{key_prefix}_seed", 42)),
        "store_reorder_weeks":  int(_get(f"{key_prefix}_srw",  2)),
        "store_target_weeks":   int(_get(f"{key_prefix}_stw",  3)),
        "store_start_days":     int(_get(f"{key_prefix}_ssd",  14)),
        "store_order_dow":      _get(f"{key_prefix}_sod",  "MONDAY"),
        "dc_reorder_weeks":     int(_get(f"{key_prefix}_drw",  2)),
        "dc_target_weeks":      int(_get(f"{key_prefix}_dtw",  5)),
        "dc_start_days":        int(_get(f"{key_prefix}_dsd",  30)),
        "dc_review_dow":        _get(f"{key_prefix}_drd",  "MONDAY"),
        "sup_lead_min":         int(_get(f"{key_prefix}_slmin", 3)),
        "sup_lead_max":         int(_get(f"{key_prefix}_slmax", 7)),
        "sup_on_time":          float(_get(f"{key_prefix}_sot", 0.90)),
        "sup_partial":          float(_get(f"{key_prefix}_sp",  0.10)),
        "dc_lead_days":         int(_get(f"{key_prefix}_dcld",  2)),
        "dc_on_time":           float(_get(f"{key_prefix}_dcot", 0.95)),
        "dc_partial":           float(_get(f"{key_prefix}_dcp",  0.05)),
        "dc_on_time_by_dc":     {},
        "dc_partial_by_dc":     {},
    }


# ─── Tile picker ─────────────────────────────────────────────────────────────

def _render_tile_picker():
    st.subheader("Choose a Scenario")
    cols = st.columns(len(_TILES))
    for i, tile in enumerate(_TILES):
        with cols[i]:
            with st.container(border=True):
                st.markdown(f"**{tile['title']}**")
                st.caption(tile["description"])
                if st.button("Select", key=f"sel_{tile['id']}", use_container_width=True):
                    st.session_state["_scen_tile"] = tile["id"]
                    st.rerun()


# ─── Scenario 1: Promo Forecast Behavior ────────────────────────────────────

def _render_promo_forecast_config(account_id, user_id):
    st.subheader("Promo Forecast Behavior")
    st.caption(
        "The system forecasts demand using the DB promo multiplier. "
        "Actual customer demand is **different** — you control by how much. "
        "The trailing average learns from the anomaly, distorting replenishment in the weeks after."
    )

    promos = _fetch_promos(account_id)
    if not promos:
        st.warning("No base promos found. Seed promos in the database first.")
        return

    def _promo_sort_key(p):
        n = p["promo_name"].upper()
        if n.startswith("PEPSI"):   return (0, n)
        if n.startswith("LAYS"):    return (1, n)
        if n.startswith("COLA_2"):  return (3, n)
        return (2, n)

    promos_sorted = sorted(promos, key=_promo_sort_key)
    promo_opts = {
        f"{p['promo_name']}  ({p['start_date']} → {p['end_date']},  x{p['demand_multiplier']} uplift)": p
        for p in promos_sorted
    }
    sel_label = st.selectbox("Promo event to inject anomaly into", list(promo_opts.keys()))
    sel_promo = promo_opts[sel_label]

    col1, col2 = st.columns(2)
    with col1:
        direction = st.radio(
            "Actual demand vs forecast",
            ["Actual > Forecast (overperform — stockout risk)",
             "Actual < Forecast (underperform — overstock)"],
            horizontal=False,
        )
    with col2:
        gap_pct = st.slider("Gap magnitude (%)", 10, 150, 50, 5)

    factor = (1.0 + gap_pct / 100) if "overperform" in direction else (1.0 - gap_pct / 100)
    sign   = f"+{gap_pct}%" if factor > 1 else f"-{gap_pct}%"

    st.info(
        f"System forecasts **{sel_promo['demand_multiplier']}x** uplift. "
        f"Actual shelf demand will be **{factor:.2f}x** the forecast ({sign}). "
        f"The anomaly week is highlighted in **red** on the results charts."
    )

    sim_cfg = _render_sim_config_form(key_prefix="pf")

    sim_name = st.text_input(
        "Simulation name",
        value=f"[SCENARIO] Promo Forecast – {sel_promo['promo_name']} {sign}",
    )
    sim_notes = st.text_area("Notes", value="", height=60)

    if st.button("Run Scenario", type="primary", use_container_width=True):
        config = {
            **sim_cfg,
            "account_id":              account_id,
            "created_by":              user_id,
            "simulation_name":         sim_name,
            "notes": (
                f"[SCENARIO:promo_forecast] "
                f"promo_id={sel_promo['promo_id']} factor={factor:.4f} | {sim_notes}"
            ),
            "promo_realization_factor": factor,
            "forecast_signal":          "demand",
            "scenario_promo_id":        sel_promo["promo_id"],
            "dc_shortage_start":        "",
            "dc_shortage_end":          "",
            "dc_shortage_factor":       0.0,
        }
        resp = _run_sim(config)
        if resp:
            sim_id = resp.get("simulation_id")
            st.session_state.pop(f"runs_list_{account_id}", None)
            st.session_state["sim_results"] = resp
            st.session_state["_scenario_meta"] = {
                "type":       "promo_forecast",
                "promo_name": sel_promo["promo_name"],
                "promo_id":   sel_promo["promo_id"],
                "factor":     factor,
                "start_date": sel_promo["start_date"],
                "end_date":   sel_promo["end_date"],
                "promo_items": sel_promo.get("item_ids") or [],
            }
            go_to("simulation", account_id=account_id, run_id=sim_id)


# ─── Scenario 2: Hidden Lost Sales ──────────────────────────────────────────

def _week_options(start: date, end: date):
    """Generate (label, monday_iso, sunday_iso) tuples for each full week in [start, end]."""
    weeks = []
    d = start
    if d.weekday() != 0:
        d += timedelta(days=(7 - d.weekday()))
    while d <= end:
        week_end = min(d + timedelta(days=6), end)
        iso = d.isocalendar()
        label = f"{iso[0]}-W{iso[1]:02d}  ({d.isoformat()} — {week_end.isoformat()})"
        weeks.append((label, d.isoformat(), week_end.isoformat()))
        d += timedelta(days=7)
    return weeks


def _render_hidden_lost_sales_config(account_id, user_id):
    st.subheader("Hidden Lost Sales")
    st.caption(
        "DC deliveries are blocked for a selected week. "
        "Because the replenishment system learns from observable sales (not true demand), "
        "the suppressed sales corrupt the trailing average — causing under-ordering after recovery."
    )

    sim_cfg = _render_sim_config_form(key_prefix="hls")

    try:
        cfg_start = date.fromisoformat(sim_cfg["start_date"])
        cfg_end   = date.fromisoformat(sim_cfg["end_date"])
    except Exception:
        cfg_start = date(2024, 1, 1)
        cfg_end   = date(2024, 12, 31)

    weeks = _week_options(cfg_start, cfg_end)
    if not weeks:
        st.warning("No full weeks in the selected date range.")
        return

    week_labels = [w[0] for w in weeks]
    default_idx = min(4, len(weeks) - 1)
    sel_idx = st.selectbox(
        "Shortage week (DC deliveries blocked)",
        range(len(week_labels)),
        format_func=lambda i: week_labels[i],
        index=default_idx,
        key="hls_week",
    )
    shortage_start = weeks[sel_idx][1]
    shortage_end   = weeks[sel_idx][2]

    shortage_pct = st.slider(
        "Delivery cut (%)",
        min_value=50, max_value=100, value=100, step=5,
        help="100% = complete blockage. 50% = half normal delivery gets through.",
        key="hls_pct",
    )
    shortage_factor = 1.0 - shortage_pct / 100.0

    st.info(
        f"During **{weeks[sel_idx][0]}**, DC deliveries to stores are cut by **{shortage_pct}%** "
        f"(delivery factor = {shortage_factor:.2f}). "
        f"Replenishment signal = observable sales. "
        f"The shortage week is highlighted in **red** on the results charts."
    )

    sim_name = st.text_input(
        "Simulation name",
        value=f"[SCENARIO] Hidden Lost Sales – {weeks[sel_idx][0].split('(')[0].strip()} {shortage_pct}% cut",
        key="hls_name",
    )
    sim_notes = st.text_area("Notes", value="", height=60, key="hls_notes")

    if st.button("Run Scenario", type="primary", use_container_width=True):
        config = {
            **sim_cfg,
            "account_id":              account_id,
            "created_by":              user_id,
            "simulation_name":         sim_name,
            "notes": (
                f"[SCENARIO:hidden_lost_sales] "
                f"shortage_start={shortage_start} shortage_end={shortage_end} "
                f"shortage_factor={shortage_factor:.4f} | {sim_notes}"
            ),
            "promo_realization_factor": 1.0,
            "forecast_signal":          "sales",
            "scenario_promo_id":        "",
            "dc_shortage_start":        shortage_start,
            "dc_shortage_end":          shortage_end,
            "dc_shortage_factor":       shortage_factor,
        }
        resp = _run_sim(config)
        if resp:
            sim_id = resp.get("simulation_id")
            st.session_state.pop(f"runs_list_{account_id}", None)
            st.session_state["sim_results"] = resp
            st.session_state["_scenario_meta"] = {
                "type":         "hidden_lost_sales",
                "start_date":   shortage_start,
                "end_date":     shortage_end,
                "shortage_pct": shortage_pct,
            }
            go_to("simulation", account_id=account_id, run_id=sim_id)


# ─── Main render ─────────────────────────────────────────────────────────────

def render():
    account_id = st.query_params.get("account_id")
    user_id    = st.session_state.get("user_id")

    st.title("Add Scenario")

    tile = st.session_state.get("_scen_tile")

    if tile:
        if st.button("← Back to scenario selection"):
            st.session_state.pop("_scen_tile", None)
            st.rerun()
        st.divider()

    if not tile:
        _render_tile_picker()
        return

    if tile == "promo_forecast":
        _render_promo_forecast_config(account_id, user_id)
    elif tile == "hidden_lost_sales":
        _render_hidden_lost_sales_config(account_id, user_id)
