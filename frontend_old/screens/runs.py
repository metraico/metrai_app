"""
screens/runs.py — Screen 3: Simulation runs for a selected retailer.
"""
import httpx
import streamlit as st

from frontend.router import go_to


_STATUS_BADGE = {
    "COMPLETED":   '<span class="badge badge-completed">Completed</span>',
    "IN_PROGRESS": '<span class="badge badge-in_progress">In Progress</span>',
    "FAILED":      '<span class="badge badge-failed">Failed</span>',
    "QUEUED":      '<span class="badge badge-queued">Queued</span>',
}


def _badge(status: str) -> str:
    return _STATUS_BADGE.get((status or "").upper(), f'<span class="badge badge-queued">{status}</span>')


def _fetch_runs(backend_url: str, account_id: str) -> list:
    try:
        r = httpx.get(f"{backend_url}/runs", params={"account_id": account_id}, timeout=10.0)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        st.error(f"Could not load runs: {e}")
        return []


def render_runs_screen(backend_url: str):
    ss = st.session_state

    # Read context from URL query params
    account_name = st.query_params.get("account_name", "Retailer")
    account_id   = st.query_params.get("account_id")
    is_real      = st.query_params.get("account_is_real", "False") == "True"

    # Breadcrumb
    st.markdown(
        f'<div style="padding: 20px 28px 0;">'
        f'<div class="breadcrumb">'
        f'  <span>Retailers</span>'
        f'  <span class="sep">›</span>'
        f'  <span class="current">{account_name}</span>'
        f'  <span class="sep">›</span>'
        f'  <span>Simulations</span>'
        f'</div></div>',
        unsafe_allow_html=True,
    )

    col_back, col_title, col_btn = st.columns([0.6, 3.4, 1])

    if col_back.button("← Back", key="runs_back"):
        go_to("retailers")

    col_title.markdown(f"## {account_name}")

    if col_btn.button("+ New Run", type="primary", use_container_width=True):
        go_to("simulation", account_id=account_id, account_name=account_name, run_name="New Run")

    if not is_real:
        st.markdown(
            '<div class="empty-state">'
            '  <div class="empty-icon">🏗️</div>'
            '  <div class="empty-title">No simulations yet</div>'
            '  <div class="empty-sub">This retailer account has no simulation data. Click <b>+ New Run</b> to get started.</div>'
            '</div>',
            unsafe_allow_html=True,
        )
        return

    # Cache key scoped to account so switching accounts refetches
    cache_key = f"runs_list_{account_id}"
    if ss.get(cache_key) is None:
        with st.spinner("Loading runs…"):
            ss[cache_key] = _fetch_runs(backend_url, account_id)

    runs = ss[cache_key] or []

    if not runs:
        st.markdown(
            '<div class="empty-state">'
            '  <div class="empty-icon">📭</div>'
            '  <div class="empty-title">No simulations yet</div>'
            '  <div class="empty-sub">Click <b>+ New Run</b> to configure and run your first simulation.</div>'
            '</div>',
            unsafe_allow_html=True,
        )
        return

    st.markdown(f"**{len(runs)} simulation run{'s' if len(runs) != 1 else ''}**")
    st.divider()

    # Header row
    h1, h2, h3, h4, h5 = st.columns([3, 2, 2, 2, 1])
    h1.markdown("**Run Name**")
    h2.markdown("**Date**")
    h3.markdown("**Period**")
    h4.markdown("**Status**")
    h5.markdown("**Action**")

    for run in runs:
        c1, c2, c3, c4, c5 = st.columns([3, 2, 2, 2, 1])
        name    = run.get("simulation_name") or run.get("simulation_id", "—")[:8]
        created = (run.get("created_at") or "")[:16].replace("T", " ")
        start_w = run.get("start_week") or run.get("start_date", "")
        end_w   = run.get("end_week")   or run.get("end_date",   "")
        period  = f"{start_w} → {end_w}" if start_w else "—"
        status  = (run.get("simulation_status") or "QUEUED").upper()

        c1.markdown(f"**{name}**")
        c2.markdown(created or "—")
        c3.markdown(period)
        c4.markdown(_badge(status), unsafe_allow_html=True)

        if c5.button("View", key=f"view_{run.get('simulation_id', name)}"):
            go_to(
                "simulation",
                account_id=account_id,
                account_name=account_name,
                run_id=run.get("simulation_id"),
                run_name=name,
            )
