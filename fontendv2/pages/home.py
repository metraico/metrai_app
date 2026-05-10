import streamlit as st
from router import go_to


def render():

    st.title("Welcome to Metrai")
    st.caption("Your simulation platform for retail forecasting.")

    st.divider()

    st.subheader("Get Started")
    st.write("Select a retailer to view and run simulations.")

    if st.button("Go to Retailers", type="primary"):
        go_to("retailers")
