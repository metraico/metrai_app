"""
components/nav.py — Sidebar navigation.
"""
import streamlit as st


def render_sidebar_nav():
    ss = st.session_state
    screen = ss.get("screen", "login")

    with st.sidebar:
        retailers_active = screen in ("retailers", "runs", "simulation")

        # ── Logo ─────────────────────────────────────────────────
        st.markdown(
            '<div class="sb-logo">'
            '  <div class="sb-logo-icon">⬡</div>'
            '  <div class="sb-logo-text">'
            '    <h2 class="sb-name">MetrAI</h2>'
            '    <p class="sb-subtitle">Supply Chain Simulator</p>'
            '  </div>'
            '</div>'
            '<div class="sb-nav-label">Navigation</div>',
            unsafe_allow_html=True,
        )

        # Retailers — active state as HTML, inactive as clickable button
        if retailers_active:
            st.markdown(
                '<div class="sb-nav-item sb-nav-active">'
                '  <span class="sb-nav-icon">🏪</span><span>Retailers</span>'
                '</div>',
                unsafe_allow_html=True,
            )
        else:
            if st.button("🏪  Retailers", key="nav_retailers"):
                ss.screen = "retailers"
                ss.selected_account_id = None
                ss.runs_list = None
                st.rerun()

        # Analytics (disabled)
        st.markdown(
            '<div class="sb-nav-item sb-nav-disabled">'
            '  <span class="sb-nav-icon">📊</span><span>Analytics</span>'
            '</div>',
            unsafe_allow_html=True,
        )

        # ── Sign out — pinned to bottom via CSS ───────────────────
        if st.button("Sign out", key="nav_logout"):
            for k in list(ss.keys()):
                del ss[k]
            st.query_params.clear()
            st.rerun()
