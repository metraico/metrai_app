import streamlit as st
from router import go_to


def render_sidebar():

    with st.sidebar:

        st.title("Metrai")

        st.divider()

        if st.button("Home", use_container_width=True):
            go_to("home")

        if st.button("Retailers", use_container_width=True):
            go_to("retailers")

        account_id = st.session_state.get("account_id")
        if account_id:
            if st.button("New Simulation", use_container_width=True):
                st.session_state.pop("sim_results", None)
                st.session_state.pop("_active_run_id", None)
                go_to("simulation", account_id=account_id)

        st.divider()

        full_name = st.session_state.get("full_name") or "User"
        st.write(f"Logged in as {full_name}")

        if st.button("Sign out", use_container_width=True):
            st.session_state.logged_in = False
            st.session_state.user_id = None
            st.session_state.account_id = None
            st.session_state.full_name = None
            # Clear all cached per-account data
            for key in list(st.session_state.keys()):
                if (
                    key.startswith("runs_list_")
                    or key.startswith("entities_")
                    or key.startswith("mappings_")
                ):
                    del st.session_state[key]
            st.session_state.pop("sim_results", None)
            st.session_state.pop("_active_run_id", None)
            go_to("login")
