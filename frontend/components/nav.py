"""
components/nav.py — Sidebar navigation.
"""
import streamlit as st


def render_sidebar_nav():
    ss = st.session_state
    screen  = ss.get("screen", "login")
    name    = ss.get("full_name") or "User"
    initial = name[0].upper()

    with st.sidebar:
        # ── Logo ──────────────────────────────────────────────────
        st.markdown(
            '<div class="sb-logo-area">'
            '  <div class="sb-wordmark">'
            '    <div class="sb-icon">⬡</div>'
            '    <span class="sb-name">Metrai</span>'
            '  </div>'
            '  <div class="sb-subtitle">Supply Chain Simulation</div>'
            '</div>',
            unsafe_allow_html=True,
        )

        # ── Nav ───────────────────────────────────────────────────
        st.markdown('<div class="sb-nav"><div class="sb-nav-label">Main</div>', unsafe_allow_html=True)

        # Retailers — clickable nav item (active state or button)
        retailers_active = screen in ("retailers", "runs", "simulation")
        if retailers_active:
            st.markdown(
                '<div class="sb-nav-item active">'
                '  <span class="sb-nav-icon">🏪</span> Retailers'
                '</div>',
                unsafe_allow_html=True,
            )
        else:
            if st.button("🏪  Retailers", key="nav_retailers"):
                ss.screen = "retailers"
                ss.selected_account_id = None
                ss.runs_list = None
                st.rerun()

        # Future nav items (disabled)
        st.markdown(
            '<div class="sb-nav-item-disabled"><span class="sb-nav-icon-disabled">📊</span> Analytics</div>'
            '<div class="sb-nav-item-disabled"><span class="sb-nav-icon-disabled">⚙️</span> Settings</div>',
            unsafe_allow_html=True,
        )

        st.markdown('</div>', unsafe_allow_html=True)  # close sb-nav

        # ── Push user section to bottom ───────────────────────────
        st.markdown('<div style="flex:1;min-height:24px"></div>', unsafe_allow_html=True)

        # ── User section + text-link logout ───────────────────────
        st.markdown(
            f'<div class="sb-user-section">'
            f'  <div class="sb-user-row">'
            f'    <div class="sb-avatar">{initial}</div>'
            f'    <div class="sb-user-info">'
            f'      <div class="sb-user-name">{name}</div>'
            f'      <div class="sb-user-role">Simulation Admin</div>'
            f'    </div>'
            f'  </div>',
            unsafe_allow_html=True,
        )
        # Logout as a small text-style button (overridden to look like a link)
        if st.button("Sign out", key="nav_logout"):
            for k in list(ss.keys()):
                del ss[k]
            st.query_params.clear()
            st.rerun()
        st.markdown('</div>', unsafe_allow_html=True)  # close sb-user-section
