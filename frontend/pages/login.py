import time

import httpx
import streamlit as st

import api
from router import go_to


def _apply_session(data: dict):
    st.session_state.logged_in     = True
    st.session_state.user_id       = data.get("user_id")
    st.session_state.account_id    = data.get("account_id")
    st.session_state.full_name     = data.get("full_name", "User")
    st.session_state.access_token  = data.get("access_token", "")
    st.session_state.refresh_token = data.get("refresh_token", "")
    st.session_state.token_expiry  = time.time() + 15 * 60 - 30


def render():
    st.title("Metrai")

    tab_login, tab_register = st.tabs(["Sign In", "Sign Up"])

    with tab_login:
        with st.form("login_form"):
            username  = st.text_input("Username")
            password  = st.text_input("Password", type="password")
            submitted = st.form_submit_button("Sign in", type="primary", use_container_width=True)

        if submitted:
            try:
                data = api.login(username, password)
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 401:
                    st.error("Invalid username or password.")
                elif e.response.status_code == 429:
                    st.error("Too many failed attempts. Please wait 15 minutes and try again.")
                else:
                    st.error(f"Login failed: {e.response.text}")
                return
            except httpx.ConnectError:
                st.error(f"Cannot reach backend at {api.BACKEND_URL}. Is it running?")
                return
            except Exception as e:
                st.error(f"Login failed: {e}")
                return

            _apply_session(data)
            go_to("home")

    with tab_register:
        with st.form("register_form"):
            r_username  = st.text_input("Username *")
            r_full_name = st.text_input("Full name (optional)")
            r_email     = st.text_input("Email (optional)")
            r_password  = st.text_input("Password * (min 8 chars)", type="password")
            r_confirm   = st.text_input("Confirm password *", type="password")
            submitted_r = st.form_submit_button("Create account", type="primary", use_container_width=True)

        if submitted_r:
            if not r_username or not r_password:
                st.error("Username and password are required.")
                return
            if len(r_password) < 8:
                st.error("Password must be at least 8 characters.")
                return
            if r_password != r_confirm:
                st.error("Passwords do not match.")
                return

            try:
                data = api.register({
                    "username":  r_username,
                    "password":  r_password,
                    "email":     r_email,
                    "full_name": r_full_name,
                })
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 409:
                    st.error("Username already taken.")
                elif e.response.status_code == 422:
                    st.error(f"Validation error: {e.response.text}")
                else:
                    st.error(f"Registration failed: {e.response.text}")
                return
            except httpx.ConnectError:
                st.error(f"Cannot reach backend at {api.BACKEND_URL}. Is it running?")
                return
            except Exception as e:
                st.error(f"Registration failed: {e}")
                return

            _apply_session(data)
            go_to("home")
