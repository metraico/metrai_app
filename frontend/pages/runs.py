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


def _format_run(r):
    sim_id = r.get("simulation_id") or ""
    name = r.get("simulation_name") or (sim_id[:8] if sim_id else "Untitled")
    created = (r.get("created_at") or "")[:10]
    start_w = r.get("start_week")
    end_w = r.get("end_week")
    period = f"W{start_w} → W{end_w}" if start_w is not None and end_w is not None else "—"
    status_raw = (r.get("simulation_status") or "QUEUED").upper()
    status = status_raw.replace("_", " ").title()
    return sim_id, name, created or "—", period, status


def render():

    account_id = st.query_params.get("id")

    st.title("Simulation Runs")

    col_back, col_new, col_scen = st.columns([1, 1, 1])
    if col_back.button("← Back"):
        go_to("retailers")
    if col_new.button("+ New Run", type="primary"):
        st.session_state.pop("sim_results", None)
        st.session_state.pop("_active_run_id", None)
        go_to("simulation", account_id=account_id)
    if col_scen.button("Add Scenario"):
        st.session_state.pop("_scen_tile", None)
        go_to("scenario_setup", account_id=account_id)

    if not account_id:
        st.error("Missing retailer id.")
        return

    runs = _get_runs(account_id)

    if not runs:
        st.info("No simulation runs yet.")
        return

    cols = st.columns(3)

    for index, run in enumerate(runs):
        sim_id, name, date, period, status = _format_run(run)

        with cols[index % 3]:

            with st.container(border=True):

                st.subheader(name)
                st.write(f"Date: {date}")
                st.write(f"Period: {period}")
                st.write(f"Status: {status}")

                col_open, col_del = st.columns(2)

                if col_open.button("Open", key=f"open_{sim_id or index}"):
                    st.session_state.pop("sim_results", None)
                    st.session_state.pop("_active_run_id", None)
                    go_to(
                        "simulation",
                        account_id=account_id,
                        run_id=sim_id,
                    )

                if col_del.button("Delete", key=f"delete_{sim_id or index}", type="secondary"):
                    try:
                        api.delete_simulation(sim_id)
                        st.session_state.pop(f"runs_list_{account_id}", None)
                        st.rerun()
                    except Exception as e:
                        st.error(f"Failed to delete run: {e}")
