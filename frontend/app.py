import time

import streamlit as st

import api
from router import get_page, go_to
from components.sidebar import render_sidebar


st.set_page_config(layout="wide")

st.markdown("""
<style>
[data-testid="stSidebarNav"] { display: none; }
</style>
""", unsafe_allow_html=True)

# Session defaults
for key, default in [
    ("logged_in",     False),
    ("user_id",       None),
    ("retailer_account_id", None),
    ("full_name",     None),
    ("access_token",  ""),
    ("refresh_token", ""),
    ("token_expiry",  0),
]:
    if key not in st.session_state:
        st.session_state[key] = default


def _maybe_refresh_tokens():
    """Silently rotate the access token if it is within 2 minutes of expiry."""
    if not st.session_state.logged_in:
        return
    if time.time() < st.session_state.token_expiry:
        return
    rt = st.session_state.get("refresh_token", "")
    if not rt:
        st.session_state.logged_in = False
        go_to("login")
        st.stop()
    try:
        data = api.refresh_access_token(rt)
        st.session_state.access_token  = data["access_token"]
        st.session_state.refresh_token = data["refresh_token"]
        st.session_state.token_expiry  = time.time() + 15 * 60 - 30
    except Exception:
        st.session_state.logged_in = False
        go_to("login")
        st.stop()


# AUTH GUARD
if not st.session_state.logged_in:
    from pages.login import render
    render()
    st.stop()

_maybe_refresh_tokens()

render_sidebar()

page = get_page()

if page == "home":
    from pages.home import render
    render()

elif page == "retailers":
    from pages.retailers import render
    render()

elif page == "runs":
    from pages.runs import render
    render()

elif page == "run_details":
    from pages.run_details import render
    render()

elif page == "simulation":
    from pages.simulation import render
    render()

elif page == "scenario_setup":
    from pages.scenario_setup import render
    render()

elif page == "login":
    from pages.login import render
    render()
