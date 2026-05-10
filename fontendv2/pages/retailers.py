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

    st.title("🏪 Retailers")

    account_id = st.session_state.get("account_id")
    if not account_id:
        st.error("No account in session. Please sign in again.")
        return

    name = st.session_state.get("full_name") or "My Retailer"

    runs = _get_runs(account_id)
    completed = sum(1 for r in runs if (r.get("simulation_status") or "").upper() == "COMPLETED")
    failed = sum(1 for r in runs if (r.get("simulation_status") or "").upper() == "FAILED")
    total = len(runs)

    cols = st.columns(3)

    with cols[0]:

        with st.container(border=True):

            st.subheader(name)
            st.caption("Default account")

            if total > 0:
                st.write(f"**{total} runs**")
                c1, c2 = st.columns(2)
                c1.success(f"✓ {completed} completed")
                c2.error(f"✗ {failed} failed")
            else:
                st.caption("No simulations yet")

            if st.button(
                "Open →",
                key=f"open_{account_id}",
                use_container_width=True,
            ):
                go_to("runs", id=account_id)
