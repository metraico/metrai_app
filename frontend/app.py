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
from frontend.components.nav import render_sidebar_nav
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
    ("logged_in",               False),
    ("user_id",                 None),
    ("account_id",              None),
    ("full_name",               None),
    ("entities",                None),
    ("mappings",                None),
    ("screen",                  "login"),
    ("selected_account_id",     None),
    ("selected_account_name",   None),
    ("selected_account_is_real", False),
    ("selected_run_id",         None),
    ("selected_run_name",       "New Run"),
    ("runs_list",               None),
]
for _key, _val in _defaults:
    if _key not in st.session_state:
        st.session_state[_key] = _val

ss = st.session_state

# ---------------------------------------------------------------------------
# Routing
# ---------------------------------------------------------------------------
if not ss.logged_in:
    ss.screen = "login"

if ss.screen == "login":
    render_login_screen(BACKEND_URL)
elif ss.screen == "retailers":
    render_sidebar_nav()
    render_retailers_screen(BACKEND_URL)
elif ss.screen == "runs":
    render_sidebar_nav()
    render_runs_screen(BACKEND_URL)
elif ss.screen == "simulation":
    render_sidebar_nav()
    render_simulation_screen(BACKEND_URL)
else:
    ss.screen = "login"
    st.rerun()
