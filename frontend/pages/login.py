import httpx
import streamlit as st

import api
from router import go_to


def render():

    st.title("Sign in to Metrai")
    st.caption("Use your account credentials to continue.")

    with st.form("login_form"):
        username = st.text_input("Username", value="demo")
        password = st.text_input("Password", type="password", value="demo123")
        submitted = st.form_submit_button("Sign in", type="primary", use_container_width=True)

    if submitted:
        try:
            data = api.login(username, password)
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                st.error("Invalid username or password.")
            else:
                st.error(f"Login failed: {e.response.text}")
            return
        except httpx.ConnectError:
            st.error(f"Cannot reach backend at {api.BACKEND_URL}. Is it running?")
            return
        except Exception as e:
            st.error(f"Login failed: {e}")
            return

        st.session_state.logged_in = True
        st.session_state.user_id = data.get("user_id")
        st.session_state.account_id = data.get("account_id")
        st.session_state.full_name = data.get("full_name", "User")
        go_to("home")
