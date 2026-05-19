"""
Scenario setup — YAML editor with validate → run flow.
"""
import httpx
import pandas as pd
import streamlit as st
import yaml as _yaml

import api
from router import go_to


_TILES = [
    {
        "id": "promo_forecast",
        "title": "Promo Forecast Behavior",
        "description": (
            "Inject a demand realization gap into one or more promo events. "
            "The system forecasts normal promo demand; actual shelf demand is "
            "higher or lower. Observe the post-promo replenishment distortion "
            "as the trailing average learns from the anomalous week."
        ),
    },
    {
        "id": "hidden_lost_sales",
        "title": "Hidden Lost Sales",
        "description": (
            "Block or delay DC deliveries to stores for a defined window. "
            "With replenishment learning from observable sales, the suppressed "
            "sales corrupt the moving average — causing under-ordering in the "
            "weeks after deliveries resume."
        ),
    },
]

# ── Default YAML templates ────────────────────────────────────────────────────

_PF_TEMPLATE = """\
# =============================================================================
# SCENARIO: Promo Forecast Behavior
# =============================================================================
# What this tests:
#   The system forecasts demand using the DB promo multiplier (e.g. 4x uplift).
#   You inject a gap between that forecast and actual shelf demand.
#   The trailing average then learns from the anomaly, distorting replenishment
#   in the weeks after the promo ends.
#
# When to use:
#   - Promo over-performs (sold out fast, stockout risk post-promo)
#   - Promo under-performs (excess inventory left after promo)
#   - Testing multiple promos firing at the same time
# =============================================================================

# -- Run parameters ------------------------------------------------------------
# All fields are optional -- defaults are used if omitted.
run:
  simulation_name: "2024 - Promo Over-Performance"
  start_date: "2024-01-01"   # simulation start (YYYY-MM-DD)
  end_date:   "2024-12-31"   # simulation end

  seed: 42   # change to get a different random draw for lead times / partials

  # Replenishment policy options:
  #   trailing_avg_28d  -- rolling 28-day average (default)
  #   promo_aware_7d    -- looks 7 days ahead for upcoming promos
  #   baseline_only     -- fixed baseline, no learning
  replenishment_policy: trailing_avg_28d
  smoothing_days: 28   # trailing window length (7-90)

  # Store policy
  store_reorder_weeks: 2   # place an order when stock falls below N weeks of cover
  store_target_weeks:  3   # replenish up to N weeks of cover
  store_start_days:    14  # opening inventory (days of cover)
  store_order_dow:     MONDAY   # day stores place orders (MONDAY-FRIDAY)

  # DC policy
  dc_reorder_weeks: 2
  dc_target_weeks:  5
  dc_start_days:    30
  dc_review_dow:    MONDAY

  # Supplier lead time & reliability
  sup_lead_min:  3     # minimum days from PO to DC receipt
  sup_lead_max:  7     # maximum days (actual drawn uniformly from [min, max])
  sup_on_time:   0.90  # fraction of shipments arriving on the scheduled date
  sup_partial:   0.10  # fraction arriving as a partial shipment

  # DC -> Store lead time & reliability
  dc_lead_days: 2
  dc_on_time:   0.95
  dc_partial:   0.05

  # Per-DC overrides (optional) -- dc_code must match what's in the DB
  # dc_on_time_by_dc:
  #   DC_EAST: 0.80
  # dc_partial_by_dc:
  #   DC_EAST: 0.20

# -- Scenario definition -------------------------------------------------------
scenario:
  scenario_type: promo_forecast

  # List one entry per promo event you want to inject an anomaly into.
  # You can have as many entries as needed -- they all run in the same simulation.
  promo_injections:
    # -- Entry 1: PEPSI over-performs ------------------------------------------
    - promo_name: "PEPSI_12PK_B2G2_SUPER_BOWL_2024"
      # promo_name must exactly match the name in the promos table.

      direction: over
      # direction options:
      #   over  -- actual demand > forecast (stockout risk, trailing avg overshoots)
      #   under -- actual demand < forecast (excess stock, trailing avg undershoots)

      magnitude_pct: 50
      # How far actual demand deviates from the forecast, in percent.
      # Range: 1 - 200
      # Examples:
      #   50  -> actual = forecast x 1.50  (over) or x 0.50 (under)
      #   100 -> actual = 2x forecast (over) or 0x = zero sales (under)
      #   20  -> a subtle 20% gap

      stores: all
      # Which stores to apply this injection to.
      # Options:
      #   all        -- every store that participates in this promo
      #   [S01, S02] -- specific store codes (must be in the promo store list)

    # -- Entry 2: LAYS also over-performs (same promo week) --------------------
    - promo_name: "LAYS_BOGO_SUPER_BOWL_2024"
      direction: over
      magnitude_pct: 10
      stores: [STR_W01, STR_E02]
"""

_HLS_TEMPLATE = """\
# =============================================================================
# SCENARIO: Hidden Lost Sales
# =============================================================================
# What this tests:
#   DC deliveries to stores are disrupted for a defined window.
#   Because the replenishment system learns from observable sales (not true demand),
#   suppressed sales corrupt the trailing average -- causing under-ordering in
#   the weeks after deliveries resume. The "lost sales" are hidden from the signal.
#
# Three disruption modes:
#   stockout -- items run out at the DC, nothing ships (fulfillment_pct = 0)
#               Use for: supplier failure, DC ran dry
#
#   outage   -- DC is physically blocked (fire, flood, strike), only a partial
#               fraction gets through
#               Use for: facility disruption with partial workaround
#
#   delayed  -- shipments are deferred by N days (e.g. port congestion, customs)
#               Use for: logistics delay, not a full blockage
#
# When to use:
#   - Model a supplier stockout and see how long recovery takes
#   - Simulate a DC fire / flood (outage) affecting a product range
#   - Test port / customs delay impact on store-level availability
#   - Stack multiple DCs to simulate a regional disruption
# Overlapping rules:
      #   OK:  different DCs, any window combination
      #   OK:  same DC, non-overlapping windows
      #   OK:  same DC, overlapping windows if item lists are completely disjoint
      #   ERR: same DC, one entry uses items: all and another overlaps that window
      #   ERR: same DC, same item code in two overlapping windows
# =============================================================================

# -- Run parameters ------------------------------------------------------------
run:
  simulation_name: "DC Stockout - Super Bowl Week 2024"
  start_date: "2024-01-01"
  end_date:   "2024-12-31"
  seed: 42

  replenishment_policy: trailing_avg_28d
  smoothing_days: 28

  store_reorder_weeks: 2
  store_target_weeks:  3
  store_start_days:    14
  store_order_dow:     MONDAY

  dc_reorder_weeks: 2
  dc_target_weeks:  5
  dc_start_days:    30
  dc_review_dow:    MONDAY

  sup_lead_min:  3
  sup_lead_max:  7
  sup_on_time:   0.90
  sup_partial:   0.10

  dc_lead_days: 2
  dc_on_time:   0.95
  dc_partial:   0.05

# -- Scenario definition -------------------------------------------------------
scenario:
  scenario_type: hidden_lost_sales

  # List one entry per DC disruption.
  # Multiple DCs and overlapping windows are supported, as long as the same
  # DC + item combination does not have overlapping windows.
  disruptions:
    # -- Entry 1: Complete DC stockout -- all items, 1 week -------------------
    - dc: DC_EAST
      # dc must exactly match dc_code in the distribution_centers table.
      # Available in this dataset: DC_EAST, DC_WEST

      items: all
      # Which items are disrupted at this DC.
      # Options:
      #   all                      -- every item stocked at this DC
      #   [2840016014, 1200080994] -- specific item codes (must match items table)

      window_start: "2024-02-05"   # first affected day
      window_end:   "2024-02-11"   # last affected day (inclusive)

      mode: stockout
      # mode options:
      #   stockout -- items ran out at DC, nothing ships (do NOT set fulfillment_pct)
      #   outage   -- DC blocked, set fulfillment_pct to fraction that gets through (0-100)
      #   delayed  -- shipments arrive late, set delay_days > 0 (number of days late)
      

    # -- Entry 2: Partial outage at DC_WEST -- specific items, 2 weeks --------
    - dc: DC_WEST
      items: [2840016014, 1200080994]   # specific item codes from items table
      window_start: "2024-04-01"
      window_end:   "2024-04-17"
      mode: outage
      fulfillment_pct: 30   # 30% ships on time
    #   delay_days: 5         # optional: remaining 70% arrives 5 days late
    #                         # omit or set 0 to lose the remainder entirely

    # -- Entry 3: Logistics delay at DC_EAST ----------------------------------
    - dc: DC_EAST
      items: all
      window_start: "2024-03-11"
      window_end:   "2024-03-17"
      mode: delayed
      delay_days: 5   # each shipment arrives 5 days after its scheduled date
                      # (days of lateness -- not constrained to the window length)
"""

_RUN_DEFAULTS = {
    "simulation_name":      "Scenario Run",
    "start_date":           "2024-01-01",
    "end_date":             "2024-03-31",
    "replenishment_policy": "trailing_avg_28d",
    "smoothing_days":       28,
    "seed":                 42,
    "store_reorder_weeks":  2,
    "store_target_weeks":   3,
    "store_start_days":     14,
    "store_order_dow":      "MONDAY",
    "dc_reorder_weeks":     2,
    "dc_target_weeks":      5,
    "dc_start_days":        30,
    "dc_review_dow":        "MONDAY",
    "sup_lead_min":         3,
    "sup_lead_max":         7,
    "sup_on_time":          0.90,
    "sup_partial":          0.10,
    "dc_on_time":           0.95,
    "dc_partial":           0.05,
    "dc_lead_days":         2,
    "dc_on_time_by_dc":     {},
    "dc_partial_by_dc":     {},
}


def _parse_yaml_run_block(yaml_text: str) -> dict:
    """Extract run: params from the YAML. Falls back to defaults for missing keys."""
    try:
        raw = _yaml.safe_load(yaml_text) or {}
    except Exception:
        return dict(_RUN_DEFAULTS)
    run_block = raw.get("run") or {}
    return {**_RUN_DEFAULTS, **{k: v for k, v in run_block.items() if v is not None}}


def _extract_scenario_yaml(yaml_text: str) -> str:
    """Return just the scenario: block as a YAML string, or the full text if no run: block."""
    try:
        raw = _yaml.safe_load(yaml_text) or {}
    except Exception:
        return yaml_text
    scenario = raw.get("scenario")
    if scenario:
        return _yaml.dump(scenario, default_flow_style=False)
    return yaml_text


# ── Tile picker ───────────────────────────────────────────────────────────────

def _render_tile_picker():
    card_cols = st.columns(3)
    for i, tile in enumerate(_TILES):
        with card_cols[i]:
            with st.container(border=True):
                st.markdown(f"**{tile['title']}**")
                st.caption(tile["description"])
                st.divider()
                if st.button("Open →", key=f"sel_{tile['id']}", use_container_width=True):
                    st.session_state["_scen_tile"] = tile["id"]
                    st.session_state.pop(f"_yaml_preview_{tile['id']}", None)
                    st.rerun()
    with card_cols[2]:
        with st.container(border=True):
            st.markdown("**More in development**")
            st.caption("Coming soon")
            st.divider()
            st.button("Coming soon", key="coming_soon", use_container_width=True, disabled=True)


# ── YAML editor ───────────────────────────────────────────────────────────────

def _render_yaml_editor(tile_id: str, default_template: str, retailer_account_id: str, user_id: str):
    template_key = f"_yaml_{tile_id}"
    preview_key  = f"_yaml_preview_{tile_id}"

    # ── Name & notes ──────────────────────────────────────────────────────────
    col_name, col_notes = st.columns([2, 3])
    sim_name  = col_name.text_input(
        "Simulation name",
        value=st.session_state.get(f"_sname_{tile_id}", ""),
        placeholder="Leave blank to use name from YAML run block",
        key=f"_sname_{tile_id}",
    )
    sim_notes = col_notes.text_input(
        "Notes",
        value=st.session_state.get(f"_snotes_{tile_id}", ""),
        placeholder="Optional",
        key=f"_snotes_{tile_id}",
    )

    st.markdown(
        """<style>
        textarea { font-family: 'Courier New', monospace !important; font-size: 13px !important; }
        </style>""",
        unsafe_allow_html=True,
    )
    yaml_text = st.text_area(
        "yaml",
        value=st.session_state.get(template_key, default_template),
        height=480,
        key=f"_yaml_ta_{tile_id}",
        label_visibility="collapsed",
    )
    st.session_state[template_key] = yaml_text

    preview = st.session_state.get(preview_key)

    col_v, col_r = st.columns(2)

    # ── Validate ──────────────────────────────────────────────────────────────
    with col_v:
        if st.button("Validate", key=f"_validate_{tile_id}", use_container_width=True):
            run_params    = _parse_yaml_run_block(yaml_text)
            scenario_yaml = _extract_scenario_yaml(yaml_text)
            try:
                result = api.validate_scenario(
                    run_params["start_date"], run_params["end_date"], scenario_yaml
                )
                st.session_state[preview_key] = result
                preview = result
            except httpx.HTTPStatusError as e:
                st.session_state.pop(preview_key, None)
                preview = None
                try:
                    detail = e.response.json().get("detail", e.response.text)
                except Exception:
                    detail = e.response.text
                st.error(detail)
            except Exception as e:
                st.session_state.pop(preview_key, None)
                preview = None
                st.error(str(e))

    # ── Run ───────────────────────────────────────────────────────────────────
    with col_r:
        if st.button(
            "Run Simulation",
            key=f"_run_{tile_id}",
            type="primary",
            use_container_width=True,
            disabled=(preview is None),
        ):
            run_params    = _parse_yaml_run_block(yaml_text)
            scenario_yaml = _extract_scenario_yaml(yaml_text)
            config = {
                **run_params,
                "retailer_account_id": retailer_account_id,
                "created_by":          user_id,
                "scenario_yaml":       scenario_yaml,
            }
            if sim_name.strip():
                config["simulation_name"] = sim_name.strip()
            if sim_notes.strip():
                config["notes"] = f"[SCENARIO:{tile_id}] {sim_notes.strip()}"
            else:
                config["notes"] = f"[SCENARIO:{tile_id}]"
            try:
                with st.spinner("Running simulation…"):
                    resp = api.run_simulation(config)
            except httpx.HTTPStatusError as e:
                st.error(f"Engine error {e.response.status_code}: {e.response.text}")
                resp = None
            except httpx.ConnectError:
                st.error("Cannot reach simulation engine.")
                resp = None
            except Exception as e:
                st.error(str(e))
                resp = None

            if resp:
                sim_id = resp.get("simulation_id")
                st.session_state.pop(f"runs_list_{retailer_account_id}", None)
                st.session_state["sim_results"] = resp
                st.session_state.pop("_scenario_meta", None)
                st.session_state.pop(preview_key, None)
                # Save full edited YAML (with run: block + comments) for the audit expander
                st.session_state[f"_full_yaml_{sim_id}"] = yaml_text
                go_to("simulation", retailer_account_id=retailer_account_id, run_id=sim_id)

    # ── Preview (shown after validate) ────────────────────────────────────────
    if preview:
        if preview.get("warnings"):
            for w in preview["warnings"]:
                st.warning(w)
        if preview.get("preview"):
            st.dataframe(
                pd.DataFrame(preview["preview"]),
                use_container_width=True,
                hide_index=True,
            )


# ── Main render ───────────────────────────────────────────────────────────────

def render():
    retailer_account_id = st.query_params.get("retailer_account_id")
    user_id    = st.session_state.get("user_id")
    tile       = st.session_state.get("_scen_tile")

    col_back, col_title = st.columns([1, 5])
    if tile:
        if col_back.button("← Back"):
            st.session_state.pop("_scen_tile", None)
            st.rerun()
        tile_title = next((t["title"] for t in _TILES if t["id"] == tile), "Scenario")
        col_title.subheader(tile_title)
    else:
        if col_back.button("← Back"):
            go_to("simulation", retailer_account_id=retailer_account_id)
        col_title.subheader("Choose a Scenario")

    st.divider()

    if not tile:
        _render_tile_picker()
        return

    template = _PF_TEMPLATE if tile == "promo_forecast" else _HLS_TEMPLATE
    _render_yaml_editor(tile, template, retailer_account_id, user_id)
