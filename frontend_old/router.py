"""
frontend/router.py — URL query-param based routing (fontendv2 pattern).
Session token is preserved in ?s= alongside ?page= on every navigation.
"""
import base64
import json

import streamlit as st


def go_to(page: str, **params):
    """Navigate to a page, encoding all context as query params.
    Always re-injects the session token so refresh stays logged in.
    """
    ss = st.session_state
    st.query_params.clear()
    st.query_params["page"] = page
    for key, value in params.items():
        st.query_params[key] = str(value)
    # Preserve session across navigation so refresh doesn't log out
    if ss.get("logged_in") and ss.get("user_id"):
        _payload = base64.urlsafe_b64encode(json.dumps({
            "user_id":    ss.user_id,
            "account_id": ss.account_id,
            "full_name":  ss.full_name,
        }).encode()).decode()
        st.query_params["s"] = _payload
    st.rerun()


def get_page() -> str:
    """Return the current page from query params, defaulting to 'login'."""
    return st.query_params.get("page", "login")
