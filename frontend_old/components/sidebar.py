"""
components/sidebar.py — Sidebar navigation.
"""
import streamlit as st

from frontend.router import go_to, get_page


def render_sidebar_nav():
    ss = st.session_state
    page = get_page()

    with st.sidebar:
        retailers_active = page in ("retailers", "runs", "simulation")

        # ── Branding ──────────────────────────────────────────
        st.markdown(
            '<div class="sb-brand">'
            '  <div class="sb-brand-icon">⬡</div>'
            '  <div class="sb-brand-text">'
            '    <span class="sb-brand-name">MetrAI</span>'
            '    <span class="sb-brand-sub">Supply Chain Simulator</span>'
            '  </div>'
            '</div>',
            unsafe_allow_html=True,
        )

        # ── Section label ─────────────────────────────────────
        st.markdown(
            '<div class="sb-label">Navigation</div>',
            unsafe_allow_html=True,
        )

        # ── Retailers ─────────────────────────────────────────
        if retailers_active:
            st.markdown(
                '<div class="sb-item sb-active">'
                '  <span class="sb-icon">🏪</span>'
                '  <span>Retailers</span>'
                '</div>',
                unsafe_allow_html=True,
            )
        else:
            if st.button("🏪  Retailers", key="nav_retailers"):
                go_to("retailers")

        # ── Analytics (coming soon) ───────────────────────────
        st.markdown(
            '<div class="sb-item sb-disabled">'
            '  <span class="sb-icon">📊</span>'
            '  <span>Analytics</span>'
            '  <span class="sb-badge">Soon</span>'
            '</div>',
            unsafe_allow_html=True,
        )

        # ── Sign out ──────────────────────────────────────────
        if st.button("Sign out", key="nav_logout"):
            for k in list(ss.keys()):
                del ss[k]
            go_to("login")
