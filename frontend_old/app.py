"""
frontend/app.py — Metrai Simulation Platform
Thin router: injects CSS, initialises session state, delegates to screen modules.
"""
import os
import sys

# Allow absolute imports from the frontend package when running as a script
_frontend_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.dirname(_frontend_dir)
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import streamlit as st
from dotenv import load_dotenv

from frontend.components.styles import CSS_BLOCK
from frontend.components.sidebar import render_sidebar_nav
from frontend.router import get_page, go_to
from frontend.screens.login import render_login_screen
from frontend.screens.retailers import render_retailers_screen
from frontend.screens.runs import render_runs_screen
from frontend.screens.simulation import render_simulation_screen

load_dotenv()
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")

st.set_page_config(
    page_title="Metrai",
    layout="wide",
    page_icon="📦",
    initial_sidebar_state="expanded",
)

# Inject global CSS
st.markdown(CSS_BLOCK, unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Session state initialisation
# ---------------------------------------------------------------------------
_defaults = [
    ("logged_in",  False),
    ("user_id",    None),
    ("account_id", None),
    ("full_name",  None),
    ("entities",   None),
    ("mappings",   None),
]
for _key, _val in _defaults:
    if _key not in st.session_state:
        st.session_state[_key] = _val

ss = st.session_state

# ---------------------------------------------------------------------------
# Session restore from URL token (survives page refresh)
# ---------------------------------------------------------------------------
if not ss.logged_in:
    import json as _json, base64 as _b64
    _raw = st.query_params.get("s")
    if _raw:
        try:
            _data = _json.loads(_b64.urlsafe_b64decode(_raw.encode()))
            ss.logged_in   = True
            ss.user_id     = _data["user_id"]
            ss.account_id  = _data["account_id"]
            ss.full_name   = _data["full_name"]
        except Exception:
            st.query_params.clear()

# ---------------------------------------------------------------------------
# Routing — URL query params are the source of truth
# ---------------------------------------------------------------------------
page = get_page()

# Guard: unauthenticated users always go to login
if not ss.logged_in and page != "login":
    go_to("login")

if page == "login":
    render_login_screen(BACKEND_URL)
elif page == "retailers":
    render_sidebar_nav()
    render_retailers_screen(BACKEND_URL)
elif page == "runs":
    render_sidebar_nav()
    render_runs_screen(BACKEND_URL)
elif page == "simulation":
    render_sidebar_nav()
    render_simulation_screen(BACKEND_URL)
else:
    go_to("login")
