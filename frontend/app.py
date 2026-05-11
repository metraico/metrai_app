import streamlit as st
from router import get_page
from components.sidebar import render_sidebar


st.set_page_config(layout="wide")

# Hide default Streamlit sidebar nav
st.markdown("""
<style>

/* Hide Streamlit default pages navigation */
[data-testid="stSidebarNav"] {
    display: none;
}

</style>
""", unsafe_allow_html=True)

# Session defaults
for key, default in [
    ("logged_in", False),
    ("user_id", None),
    ("account_id", None),
    ("full_name", None),
]:
    if key not in st.session_state:
        st.session_state[key] = default


# AUTH GUARD
if not st.session_state.logged_in:
    from pages.login import render
    render()
    st.stop()


# ALWAYS render sidebar when logged in
render_sidebar()

# PAGE ROUTER
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

elif page == "login":
    from pages.login import render
    render()
