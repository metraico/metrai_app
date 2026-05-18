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


def _render_create_form():
    with st.expander("+ Create new account", expanded=False):
        with st.form("create_account_form", clear_on_submit=True):
            col1, col2 = st.columns(2)
            with col1:
                acct_name = st.text_input("Account Name *", placeholder="e.g. Shaws")
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
                st.success(f"Account **{acct_name}** created.")
                st.rerun()
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 409:
                    st.error("Account ID already exists.")
                else:
                    st.error(f"Failed: {e.response.text}")
            except Exception as e:
                st.error(f"Failed: {e}")


def render():
    st.title("Retailer Accounts")

    accounts = _fetch_accounts()
    active_id = st.session_state.get("retailer_account_id")

    _render_create_form()

    st.divider()

    if not accounts:
        st.info("No accounts yet. Create one above.")
        return

    # Table header
    cols_hdr = st.columns([2, 2, 1.5, 1, 1.5, 1, 1.5, 1.5])
    for hdr, col in zip(
        ["Account ID", "Account Name", "Type", "Country", "Region", "Currency", "Status", ""],
        cols_hdr,
    ):
        col.markdown(f"**{hdr}**")

    st.divider()

    for acct in accounts:
        aid     = acct.get("retailer_account_id", "")
        code    = acct.get("retailer_account_code", "")
        name    = acct.get("retailer_account_name", "")
        atype   = acct.get("retailer_account_type", "")
        country = acct.get("country_code") or "—"
        region  = acct.get("region") or "—"
        curr    = acct.get("currency_code", "USD")
        active  = acct.get("is_active", True)

        is_active_acct = aid == active_id

        row = st.columns([2, 2, 1.5, 1, 1.5, 1, 1.5, 1.5])
        row[0].write(f"`{code}`")
        row[1].write(f"{'**' + name + '**' if is_active_acct else name}")
        row[2].write(atype)
        row[3].write(country)
        row[4].write(region)
        row[5].write(curr)
        row[6].write("Active" if active else "Inactive")

        btn_label = "Open"
        if is_active_acct:
            if row[7].button(btn_label, key=f"open_{aid}", use_container_width=True, type="primary"):
                go_to("runs", id=aid)
        else:
            if row[7].button(btn_label, key=f"open_{aid}", use_container_width=True):
                _switch(aid)
