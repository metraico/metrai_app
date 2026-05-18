import streamlit as st

import api
from router import go_to


def render_sidebar():

    with st.sidebar:

        st.title("Metrai")

        st.divider()

        if st.button("Home", use_container_width=True):
            go_to("home")

        if st.button("Retailers", use_container_width=True):
            go_to("retailers")

        st.divider()

        full_name = st.session_state.get("full_name") or "User"
        st.write(f"Logged in as {full_name}")

        if st.button("Sign out", use_container_width=True):
            api.logout_session(st.session_state.get("refresh_token", ""))
            for key in list(st.session_state.keys()):
                if key.startswith(("runs_list_", "entities_", "mappings_", "promos_")):
                    del st.session_state[key]
            for key in ["logged_in", "user_id", "retailer_account_id", "full_name",
                        "access_token", "refresh_token", "token_expiry",
                        "sim_results", "_active_run_id", "_scenario_meta", "_scen_tile",
                        "accounts_list"]:
                st.session_state.pop(key, None)
            go_to("login")
