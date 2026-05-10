import streamlit as st
from router import go_to


def render_sidebar():

    with st.sidebar:

        st.title("Metrai")

        st.divider()

        if st.button("Home", use_container_width=True):
            go_to("home")

        if st.button("Retailers", use_container_width=True):
            go_to("retailers")

        st.divider()

        st.write("Logged in as Admin")