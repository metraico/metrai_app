import streamlit as st

import api
from router import go_to


def _get_runs(account_id):
    cache_key = f"runs_list_{account_id}"
    if cache_key not in st.session_state:
        try:
            st.session_state[cache_key] = api.fetch_runs(account_id)
        except Exception as e:
            st.error(f"Could not load runs: {e}")
            st.session_state[cache_key] = []
    return st.session_state[cache_key]


def render():

    run_id = st.query_params.get("id")
    retailer_id = st.query_params.get("retailer_id")

    if not run_id or not retailer_id:
        st.error("Missing run or retailer id.")
        return

    runs = _get_runs(retailer_id)
    run = next((r for r in runs if r.get("simulation_id") == run_id), None)

    if not run:
        st.error("Run not found.")
        if st.button("← Back"):
            go_to("runs", id=retailer_id)
        return

    name = run.get("simulation_name") or run_id[:8]
    created = (run.get("created_at") or "—")
    start_w = run.get("start_week")
    end_w = run.get("end_week")
    period = f"W{start_w} → W{end_w}" if start_w is not None and end_w is not None else "—"
    status = (run.get("simulation_status") or "QUEUED").replace("_", " ").title()
    seed = run.get("random_seed", "—")
    notes = run.get("notes") or "—"

    st.title(name)

    st.write(f"Simulation ID: `{run_id}`")
    st.write(f"Created: {created}")
    st.write(f"Period: {period}")
    st.write(f"Status: {status}")
    st.write(f"Random seed: {seed}")
    st.write(f"Notes: {notes}")

    col_back, col_open = st.columns([1, 1])
    if col_back.button("← Back"):
        go_to("runs", id=retailer_id)
    if col_open.button("Open in Simulation", type="primary"):
        go_to("simulation", account_id=retailer_id)
