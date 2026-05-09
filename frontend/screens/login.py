"""
screens/login.py — Screen 1: Login page.
"""
import httpx
import streamlit as st


def render_login_screen(backend_url: str):
    ss = st.session_state

    # Hide sidebar AND the collapse toggle on login page; style form as the card
    st.markdown(
        "<style>"
        "[data-testid='stSidebar']{display:none!important;}"
        "[data-testid='collapsedControl']{display:none!important;}"
        "[data-testid='stMainBlockContainer']{"
            "display:flex!important;"
            "align-items:center!important;"
            "justify-content:center!important;"
            "min-height:100vh!important;"
            "padding:0!important;"
        "}"
        "[data-testid='stMainBlockContainer'] [data-testid='stHorizontalBlock']{"
            "width:100%!important;"
        "}"
        "[data-testid='stForm']{"
            "background:#161b27!important;"
            "border:1px solid rgba(255,255,255,0.08)!important;"
            "border-radius:16px!important;"
            "padding:40px 36px!important;"
            "max-width:400px!important;"
            "margin:0 auto!important;"
            "box-shadow:0 8px 32px rgba(0,0,0,0.4)!important;"
        "}"
        "[data-testid='stForm'] .stTextInput{"
            "margin-bottom:4px!important;"
        "}"
        "[data-testid='stForm'] [data-testid='stFormSubmitButton']{"
            "margin-top:4px!important;"
        "}"
        "</style>",
        unsafe_allow_html=True,
    )

    # Centre the card using columns
    _, col, _ = st.columns([1, 1.4, 1])
    with col:
        with st.form("login_form"):
            st.markdown(
                '<div class="login-logo">Metrai</div>'
                '<div class="login-tagline">Supply chain simulation platform</div>',
                unsafe_allow_html=True,
            )
            username = st.text_input("Email / Username", placeholder="demo")
            password = st.text_input("Password", type="password", placeholder="••••••••")
            submitted = st.form_submit_button("Sign in", use_container_width=True, type="primary")
            st.markdown(
                '<a class="forgot-link" href="#">Forgot password?</a>',
                unsafe_allow_html=True,
            )

    if submitted:
        try:
            resp = httpx.post(
                f"{backend_url}/login",
                json={"username": username, "password": password},
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                ss.logged_in   = True
                ss.user_id     = data["user_id"]
                ss.account_id  = data["account_id"]
                ss.full_name   = data["full_name"]
                ss.screen      = "retailers"
                # Persist session in URL query params — survives refresh, no JS timing issues
                import json as _json, base64 as _b64
                _payload = _b64.urlsafe_b64encode(_json.dumps({
                    "user_id":    data["user_id"],
                    "account_id": data["account_id"],
                    "full_name":  data["full_name"],
                }).encode()).decode()
                st.query_params["s"] = _payload
                st.rerun()
            else:
                st.error("Invalid username or password.")
        except httpx.ConnectError:
            st.error(f"Cannot reach backend at {backend_url}.")
