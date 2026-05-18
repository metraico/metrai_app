"""
screens/retailers.py — Screen 2: Retailer accounts dashboard.
# TODO: replace RETAILER_ACCOUNTS with GET /accounts endpoint when available.
"""
import httpx
import streamlit as st

from frontend.router import go_to

RETAILER_ACCOUNTS = [
    {"account_id": None,        "name": "FreshMart Retail",       "initial": "F", "industry": "Grocery",       "region": "North America", "color": "#6366f1", "is_real": True},
    {"account_id": "_mock_002", "name": "Metro Apparel Co.",       "initial": "M", "industry": "Fashion",       "region": "Europe",        "color": "#8b5cf6", "is_real": False},
    {"account_id": "_mock_003", "name": "TechZone Electronics",    "initial": "T", "industry": "Electronics",   "region": "Asia Pacific",  "color": "#06b6d4", "is_real": False},
    {"account_id": "_mock_004", "name": "HomeBase Furnishings",    "initial": "H", "industry": "Home & Garden", "region": "North America", "color": "#10b981", "is_real": False},
]


def _fetch_run_count(backend_url: str, account_id: str) -> tuple[int, dict]:
    try:
        r = httpx.get(f"{backend_url}/runs", params={"account_id": account_id}, timeout=10.0)
        r.raise_for_status()
        runs = r.json()
        counts: dict = {}
        for run in runs:
            s = (run.get("simulation_status") or "UNKNOWN").upper()
            counts[s] = counts.get(s, 0) + 1
        return len(runs), counts
    except Exception:
        return 0, {}


def render_retailers_screen(backend_url: str):
    ss = st.session_state

    accounts = [dict(a) for a in RETAILER_ACCOUNTS]
    accounts[0]["account_id"] = ss.account_id

    # Fetch run counts once per session
    if "retailer_run_counts" not in ss:
        count, status_counts = _fetch_run_count(backend_url, ss.account_id)
        ss.retailer_run_counts = {ss.account_id: (count, status_counts)}

    # ── Top bar ───────────────────────────────────────────────────────────────
    name    = ss.get("full_name") or "User"
    initial = name[0].upper()
    st.markdown(
        f'<div class="topbar">'
        f'  <div class="topbar-breadcrumb"><span class="current">Retailers</span></div>'
        f'  <div class="topbar-user">'
        f'    <div class="topbar-avatar">{initial}</div>'
        f'    <span class="topbar-username">{name}</span>'
        f'  </div>'
        f'</div>',
        unsafe_allow_html=True,
    )

    # ── Page content wrapper ──────────────────────────────────────────────────
    st.markdown('<div class="page-content">', unsafe_allow_html=True)

    # ── Page header row ───────────────────────────────────────────────────────
    h1, h2 = st.columns([5, 1])
    with h1:
        st.markdown(
            '<div class="page-title">Retailer Accounts</div>'
            '<div class="page-subtitle">Select a retailer to view its simulation runs.</div>',
            unsafe_allow_html=True,
        )
    with h2:
        # Wrap button so it aligns right and is not full-width
        st.markdown('<div class="add-btn-wrap">', unsafe_allow_html=True)
        if st.button("＋  Add Retailer", key="add_retailer_btn", type="primary"):
            pass  # TODO
        st.markdown('</div>', unsafe_allow_html=True)

    # ── Search bar ───────────────────────────────────────────────────────────
    st.markdown('<div class="search-wrap">', unsafe_allow_html=True)
    st.markdown('<div class="search-icon">🔍</div>', unsafe_allow_html=True)
    search = st.text_input(
        "search",
        placeholder="Search by name or industry…",
        label_visibility="collapsed",
        key="retailer_search",
    )
    st.markdown('</div>', unsafe_allow_html=True)

    # Filter accounts
    if search:
        accounts = [a for a in accounts
                    if search.lower() in a["name"].lower()
                    or search.lower() in a["industry"].lower()]

    if not accounts:
        st.markdown(
            '<div class="empty-state">'
            '  <div class="empty-icon">🔍</div>'
            '  <div class="empty-title">No retailers match your search</div>'
            '  <div class="empty-sub">Try a different keyword.</div>'
            '</div>',
            unsafe_allow_html=True,
        )
        st.markdown('</div>', unsafe_allow_html=True)
        return

    # ── Cards grid — always 3 columns, pad last row with empty slots ──────────
    for row_start in range(0, len(accounts), 3):
        row = accounts[row_start:row_start + 3]
        # Pad so the last row always has exactly 3 entries (None = empty column)
        while len(row) < 3:
            row.append(None)

        cols = st.columns(3, gap="medium")

        for col, acct in zip(cols, row):
            with col:
                # Empty placeholder column — invisible, holds space
                if acct is None:
                    st.markdown('<div class="card-placeholder"></div>', unsafe_allow_html=True)
                    continue

                if acct["is_real"]:
                    run_count, status_counts = ss.retailer_run_counts.get(ss.account_id, (0, {}))
                    completed = status_counts.get("COMPLETED", 0)
                    failed    = status_counts.get("FAILED", 0)
                    in_prog   = status_counts.get("IN_PROGRESS", 0) + status_counts.get("QUEUED", 0)
                    badges = []
                    if completed: badges.append(f'<span class="badge badge-completed">✓ {completed} completed</span>')
                    if failed:    badges.append(f'<span class="badge badge-failed">✕ {failed} failed</span>')
                    if in_prog:   badges.append(f'<span class="badge badge-in_progress">● {in_prog} running</span>')

                    if run_count > 0:
                        stats_html = (
                            f'<div class="card-run-total">{run_count} run{"s" if run_count != 1 else ""}</div>'
                            f'<div class="card-badges">{"".join(badges)}</div>'
                        )
                    else:
                        stats_html = '<div class="card-empty">No simulations yet</div>'
                else:
                    stats_html = '<div class="card-empty">No simulations yet</div>'

                # Card top section (HTML only — no button here)
                st.markdown(
                    f'<div class="retailer-card">'
                    f'  <div class="card-top">'
                    f'    <div class="card-avatar" style="background:{acct["color"]}">{acct["initial"]}</div>'
                    f'    <div class="card-name">{acct["name"]}</div>'
                    f'    <div class="card-meta">{acct["industry"]} &nbsp;·&nbsp; {acct["region"]}</div>'
                    f'    <div class="card-stats-area">{stats_html}</div>'
                    f'  </div>'
                    f'  <div class="card-footer">',
                    unsafe_allow_html=True,
                )

                if st.button("Open →", key=f"open_{acct['account_id']}", use_container_width=True):
                    go_to(
                        "runs",
                        account_id=acct["account_id"],
                        account_name=acct["name"],
                        account_is_real=acct["is_real"],
                    )

                st.markdown('</div></div>', unsafe_allow_html=True)  # close card-footer + retailer-card

    st.markdown('</div>', unsafe_allow_html=True)  # close page-content
