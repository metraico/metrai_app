import time

import httpx
import streamlit as st

import api
from router import go_to


_ACCOUNT_TYPES = ["GROCERY", "FASHION", "CPG", "PHARMACY", "CONVENIENCE", "OTHER"]
_CURRENCIES    = ["USD", "EUR", "GBP", "CAD", "AUD"]
_US_REGIONS    = [
    "", "Northeast", "Mid-Atlantic", "Southeast", "Midwest",
    "Southwest", "West", "Northwest", "National",
]


def _fetch_accounts():
    key = "accounts_list"
    if key not in st.session_state:
        try:
            st.session_state[key] = api.fetch_accounts()
        except Exception as e:
            st.error(f"Could not load accounts: {e}")
            st.session_state[key] = []
    return st.session_state[key]


def _switch(retailer_account_id: str):
    try:
        data = api.switch_account(retailer_account_id)
        st.session_state.access_token        = data["access_token"]
        st.session_state.refresh_token       = data["refresh_token"]
        st.session_state.token_expiry        = time.time() + 15 * 60 - 30
        st.session_state.retailer_account_id = data["retailer_account_id"]
        st.session_state.pop("accounts_list", None)
        st.session_state.pop(f"runs_list_{retailer_account_id}", None)
        go_to("runs", id=retailer_account_id)
    except Exception as e:
        st.error(f"Could not switch account: {e}")


@st.dialog("Create New Account")
def _create_account_dialog():
    with st.form("create_account_form", clear_on_submit=True):
        acct_name = st.text_input("Account Name *", placeholder="e.g. Shaws")
        col1, col2 = st.columns(2)
        with col1:
            acct_type = st.selectbox("Account Type *", _ACCOUNT_TYPES)
            country   = st.text_input("Country Code *", value="US", max_chars=2)
        with col2:
            region   = st.selectbox("Region", _US_REGIONS)
            currency = st.selectbox("Currency Code *", _CURRENCIES)

        submitted = st.form_submit_button("Create Account", type="primary", use_container_width=True)

    if submitted:
        if not acct_name:
            st.error("Account Name is required.")
            return
        try:
            api.create_account({
                "account_name":  acct_name,
                "account_type":  acct_type,
                "country_code":  country,
                "region":        region,
                "currency_code": currency,
            })
            st.session_state.pop("accounts_list", None)
            st.success(f"Account '{acct_name}' created.")
            st.rerun()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 409:
                st.error("Account ID already exists.")
            else:
                st.error(f"Failed: {e.response.text}")
        except Exception as e:
            st.error(f"Failed: {e}")


def render():
    active_id = st.session_state.get("retailer_account_id")

    title_col, btn_col = st.columns([4, 1])
    title_col.title("Retailer Accounts")
    if btn_col.button("+ New Account", type="primary", use_container_width=True):
        _create_account_dialog()

    accounts = _fetch_accounts()

    if not accounts:
        st.info("No accounts yet. Create one using the button above.")
        return

    cols = st.columns(3)
    for i, acct in enumerate(accounts):
        aid     = acct.get("retailer_account_id", "")
        code    = acct.get("retailer_account_code", "")
        name    = acct.get("retailer_account_name", "")
        atype   = acct.get("retailer_account_type", "") or "—"
        country = acct.get("country_code") or "—"
        region  = acct.get("region") or "—"
        curr    = acct.get("currency_code", "USD")
        active  = acct.get("is_active", True)
        is_active_acct = aid == active_id

        with cols[i % 3]:
            with st.container(border=True):
                st.markdown(f"### {name}")
                st.caption(f"`{code}`")

                c1, c2 = st.columns(2)
                c1.markdown(f"**Type:** {atype}")
                c2.markdown(f"**Currency:** {curr}")
                c1.markdown(f"**Country:** {country}")
                c2.markdown(f"**Region:** {region}")
                st.caption("Active" if active else "Inactive")

                st.divider()

                if is_active_acct:
                    if st.button("Open", key=f"open_{aid}", use_container_width=True, type="primary"):
                        go_to("runs", id=aid)
                else:
                    if st.button("Open", key=f"open_{aid}", use_container_width=True):
                        _switch(aid)
