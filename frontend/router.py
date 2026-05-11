import streamlit as st


def go_to(page, **params):
    st.query_params.clear()

    st.query_params["page"] = page

    for key, value in params.items():
        st.query_params[key] = value

    st.rerun()


def get_page():
    return st.query_params.get("page", "home")