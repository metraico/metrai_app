"""
components/styles.py — Global CSS for the Metrai app (dark theme, responsive).
"""

CSS_BLOCK = """
<style>
/* ═══════════════════════════════════════════════════════════
   RESET & BASE
═══════════════════════════════════════════════════════════ */
* { box-sizing: border-box; }
#MainMenu, footer, header { visibility: hidden; }

html, body,
[data-testid="stAppViewContainer"],
.stApp,
section[data-testid="stMain"] {
    background: #0f1117 !important;
    color: #f1f5f9 !important;
}

/* Kill ALL default Streamlit padding except right gutter */
.block-container,
section[data-testid="stMain"] > div,
[data-testid="stMainBlockContainer"] {
    padding: 0 28px 0 0 !important;
    max-width: 100% !important;
}

/* Kill the large Streamlit gap between elements */
[data-testid="stVerticalBlock"] > [data-testid="stVerticalBlockBorderWrapper"],
[data-testid="stVerticalBlock"] > div,
[data-testid="stVerticalBlock"] {
    gap: 0 !important;
}

/* ═══════════════════════════════════════════════════════════
   SIDEBAR
═══════════════════════════════════════════════════════════ */
[data-testid="stSidebar"] {
    background: #131929 !important;
    border-right: 1px solid rgba(255,255,255,0.06) !important;
    min-width: 240px !important;
    max-width: 240px !important;
}
[data-testid="stSidebar"] > div:first-child {
    display: flex !important;
    flex-direction: column !important;
    height: 100% !important;
    padding: 0 !important;
    min-height: 100vh !important;
}
[data-testid="stSidebar"] .block-container { padding: 0 !important; }
[data-testid="stSidebar"],
[data-testid="stSidebar"] p,
[data-testid="stSidebar"] span,
[data-testid="stSidebar"] div,
[data-testid="stSidebar"] label { color: #cbd5e1 !important; }

/* Sidebar nav buttons (Retailers when not active) */
[data-testid="stSidebar"] .stButton > button {
    all: unset !important;
    display: flex !important;
    align-items: center !important;
    gap: 10px !important;
    width: 100% !important;
    padding: 9px 12px !important;
    border-radius: 8px !important;
    font-size: 14px !important;
    font-weight: 500 !important;
    color: #94a3b8 !important;
    cursor: pointer !important;
    transition: background 0.15s, color 0.15s !important;
    margin-bottom: 2px !important;
}
[data-testid="stSidebar"] .stButton > button:hover {
    background: rgba(255,255,255,0.06) !important;
    color: #f1f5f9 !important;
}

/* Sign out — text-link style */
[data-testid="stSidebar"] [data-testid="stButton-nav_logout"] > button {
    all: unset !important;
    font-size: 12px !important;
    color: #475569 !important;
    cursor: pointer !important;
    padding: 2px 0 !important;
    display: block !important;
    width: 100% !important;
    transition: color 0.15s !important;
}
[data-testid="stSidebar"] [data-testid="stButton-nav_logout"] > button:hover {
    color: #94a3b8 !important;
    background: transparent !important;
    text-decoration: underline !important;
}

/* Hamburger toggle — styled for dark bg */
[data-testid="collapsedControl"] {
    background: #131929 !important;
    color: #64748b !important;
    border-right: 1px solid rgba(255,255,255,0.06) !important;
}
[data-testid="collapsedControl"] svg { fill: #64748b !important; }
[data-testid="collapsedControl"]:hover { background: #1a2235 !important; }

/* ── Sidebar HTML elements ── */
.sb-logo-area {
    padding: 20px 20px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    margin-bottom: 8px;
    flex-shrink: 0;
}
.sb-wordmark { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.sb-icon {
    width: 28px; height: 28px; background: #6366f1; border-radius: 7px;
    display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0;
}
.sb-name { font-size: 17px; font-weight: 700; color: #f1f5f9 !important; letter-spacing: -0.3px; }
.sb-subtitle { font-size: 11px; color: #475569 !important; padding-left: 36px; letter-spacing: 0.02em; }
.sb-nav { padding: 4px 12px; flex: 1; overflow-y: auto; }
.sb-nav-label {
    font-size: 10px; font-weight: 600; color: #334155 !important;
    letter-spacing: 0.08em; text-transform: uppercase; padding: 8px 4px 4px; margin-bottom: 2px;
}
.sb-nav-item {
    display: flex; align-items: center; gap: 10px; padding: 9px 12px;
    border-radius: 8px; font-size: 14px; font-weight: 500; color: #94a3b8 !important;
    cursor: pointer; transition: background 0.15s, color 0.15s; margin-bottom: 2px;
}
.sb-nav-item:hover { background: rgba(255,255,255,0.06); color: #f1f5f9 !important; }
.sb-nav-item.active {
    background: rgba(99,102,241,0.15); color: #a5b4fc !important;
    border-left: 3px solid #6366f1; padding-left: 9px;
}
.sb-nav-icon { font-size: 16px; width: 20px; text-align: center; flex-shrink: 0; }
.sb-nav-item-disabled {
    display: flex; align-items: center; gap: 10px; padding: 9px 12px;
    border-radius: 8px; font-size: 14px; color: #2d3748 !important; cursor: default; margin-bottom: 2px;
}
.sb-nav-icon-disabled { font-size: 16px; width: 20px; text-align: center; color: #2d3748 !important; }
.sb-user-section {
    border-top: 1px solid rgba(255,255,255,0.06); padding: 14px 16px 14px; flex-shrink: 0;
}
.sb-user-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.sb-user-info { display: flex; flex-direction: column; min-width: 0; }
.sb-avatar {
    width: 34px; height: 34px; border-radius: 50%; background: #6366f1;
    color: #fff !important; font-size: 14px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.sb-user-name { font-size: 13px; font-weight: 600; color: #e2e8f0 !important; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-user-role { font-size: 11px; color: #475569 !important; line-height: 1.3; }

/* ═══════════════════════════════════════════════════════════
   TOP BAR
═══════════════════════════════════════════════════════════ */
.topbar {
    background: #0f1117;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    padding: 0 28px;
    height: 52px;
    display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 100;
}
.topbar-breadcrumb { font-size: 13px; color: #64748b; display: flex; align-items: center; gap: 6px; }
.topbar-breadcrumb .sep { color: #334155; }
.topbar-breadcrumb .current { color: #e2e8f0; font-weight: 500; }
.topbar-user { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #94a3b8; }
.topbar-avatar {
    width: 28px; height: 28px; border-radius: 50%; background: #6366f1;
    color: #fff !important; font-size: 12px; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center;
}

/* ═══════════════════════════════════════════════════════════
   PAGE CONTENT
═══════════════════════════════════════════════════════════ */
.page-content { padding: 24px 28px 32px; }
.page-title    { font-size: 26px; font-weight: 700; color: #f1f5f9; line-height: 1.2; margin-bottom: 4px; }
.page-subtitle { font-size: 14px; color: #64748b; margin: 0 0 20px; }

/* Add Retailer button wrapper — push button to the right, auto-size (not full-width) */
.add-btn-wrap {
    display: flex;
    justify-content: flex-end;
    align-items: flex-start;
    padding-top: 6px;
}
.add-btn-wrap .stButton > button {
    background: #6366f1 !important;
    border: none !important;
    color: #fff !important;
    border-radius: 8px !important;
    font-size: 13px !important;
    font-weight: 600 !important;
    padding: 8px 16px !important;
    cursor: pointer !important;
    transition: background 0.15s !important;
    white-space: nowrap !important;
    width: auto !important;
}
.add-btn-wrap .stButton > button:hover { background: #4f46e5 !important; }

/* ── Search bar ── */
.search-wrap {
    position: relative;
    margin-bottom: 24px;
}
.search-wrap .stTextInput { margin: 0 !important; }
.search-wrap .stTextInput > div { margin: 0 !important; }
.search-wrap .stTextInput label { display: none !important; }
.search-wrap .stTextInput input {
    background: #1a2235 !important;
    border: 1px solid rgba(255,255,255,0.10) !important;
    border-radius: 10px !important;
    color: #f1f5f9 !important;
    padding: 10px 14px 10px 40px !important;
    font-size: 14px !important;
    height: 42px !important;
    transition: border-color 0.15s, box-shadow 0.15s !important;
    width: 100% !important;
}
.search-wrap .stTextInput input:focus {
    border-color: #6366f1 !important;
    box-shadow: 0 0 0 3px rgba(99,102,241,0.15) !important;
    outline: none !important;
}
.search-wrap .stTextInput input::placeholder { color: #3d4f6e !important; }
.search-icon {
    position: absolute;
    left: 13px; top: 50%;
    transform: translateY(-50%);
    color: #3d4f6e;
    font-size: 16px;
    pointer-events: none;
    z-index: 2; line-height: 1;
}

/* ═══════════════════════════════════════════════════════════
   RETAILER CARDS
═══════════════════════════════════════════════════════════ */
/* Equal-height columns */
[data-testid="stHorizontalBlock"] {
    gap: 20px !important;
    align-items: stretch !important;
}
[data-testid="stHorizontalBlock"] > [data-testid="column"] {
    flex: 1 1 0 !important;
    min-width: 0 !important;
    display: flex !important;
    flex-direction: column !important;
}

/* Invisible placeholder for empty grid slots */
.card-placeholder { height: 1px; visibility: hidden; }

.retailer-card {
    background: #1a2235;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    padding: 20px 20px 0;
    display: flex;
    flex-direction: column;
    flex: 1;                     /* fill column height */
    min-height: 220px;
    transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    overflow: hidden;
}
.retailer-card:hover {
    background: #1e2845;
    border-color: rgba(99,102,241,0.50);
    box-shadow: 0 4px 24px rgba(0,0,0,0.35), 0 0 0 1px rgba(99,102,241,0.15);
}

.card-top { flex: 1; padding-bottom: 14px; }

.card-avatar {
    width: 40px; height: 40px; border-radius: 10px;
    color: #fff !important; font-size: 17px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 12px;
}
.card-name { font-size: 15px; font-weight: 600; color: #f1f5f9; margin-bottom: 3px; line-height: 1.3; }
.card-meta { font-size: 12px; color: #475569; margin-bottom: 12px; }

/* Stats area — fixed height so cards with/without data stay same height */
.card-stats-area { min-height: 44px; }
.card-run-total  { font-size: 12px; color: #64748b; margin-bottom: 6px; }
.card-badges     { display: flex; flex-wrap: wrap; gap: 5px; }
.card-empty      { font-size: 12px; color: #2d3748; font-style: italic; line-height: 44px; }

/* Status badges */
.badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600;
}
.badge-completed   { background: rgba(16,185,129,0.15); color: #34d399; }
.badge-failed      { background: rgba(220,38,38,0.15);  color: #f87171; }
.badge-in_progress { background: rgba(37,99,235,0.15);  color: #60a5fa; }
.badge-queued      { background: rgba(100,116,139,0.12);color: #64748b; }

/* Card footer — Open button pinned to bottom */
.card-footer {
    border-top: 1px solid rgba(255,255,255,0.06);
    margin: 0;
    padding: 0;
    margin-top: auto;
}
.card-footer .stButton > button {
    all: unset !important;
    display: block !important;
    width: 100% !important;
    padding: 11px 0 !important;
    background: transparent !important;
    color: #94a3b8 !important;
    font-size: 13px !important;
    font-weight: 500 !important;
    text-align: center !important;
    cursor: pointer !important;
    border-radius: 0 0 12px 12px !important;
    transition: background 0.15s, color 0.15s !important;
    box-sizing: border-box !important;
    border: none !important;
}
.card-footer .stButton > button:hover {
    background: #6366f1 !important;
    color: #fff !important;
}

/* ═══════════════════════════════════════════════════════════
   RESPONSIVE BREAKPOINTS
═══════════════════════════════════════════════════════════ */
@media (max-width: 1024px) {
    [data-testid="stHorizontalBlock"] > [data-testid="column"] {
        min-width: calc(50% - 10px) !important;
        flex: 0 1 calc(50% - 10px) !important;
    }
    [data-testid="stHorizontalBlock"] { flex-wrap: wrap !important; }
    .page-content { padding: 18px 18px 28px; }
    .topbar { padding: 0 18px; }
    .page-title { font-size: 22px; }
}

@media (max-width: 640px) {
    [data-testid="stHorizontalBlock"] > [data-testid="column"] {
        min-width: 100% !important;
        flex: 0 0 100% !important;
        width: 100% !important;
    }
    [data-testid="stHorizontalBlock"] { flex-direction: column !important; gap: 12px !important; }
    .page-content { padding: 14px 14px 24px; }
    .topbar { padding: 0 14px; height: 46px; }
    .topbar-username { display: none; }
    .page-title { font-size: 19px; }
    .retailer-card { min-height: unset; }
    .add-btn-wrap .stButton > button { font-size: 12px !important; padding: 7px 12px !important; }
}

/* ═══════════════════════════════════════════════════════════
   RUNS TABLE BADGES
═══════════════════════════════════════════════════════════ */
.badge-pill { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
.badge-pill.completed   { background: rgba(16,185,129,0.15);  color: #34d399; }
.badge-pill.in_progress { background: rgba(37,99,235,0.15);   color: #60a5fa; }
.badge-pill.failed      { background: rgba(220,38,38,0.15);   color: #f87171; }
.badge-pill.queued      { background: rgba(100,116,139,0.12); color: #64748b; }

/* ═══════════════════════════════════════════════════════════
   BREADCRUMB / EMPTY STATE / SKELETON
═══════════════════════════════════════════════════════════ */
.breadcrumb { font-size: 13px; color: #475569; margin-bottom: 6px; }
.breadcrumb .sep { margin: 0 6px; color: #334155; }
.breadcrumb .current { color: #e2e8f0; font-weight: 500; }

.empty-state { text-align: center; padding: 60px 20px; }
.empty-icon  { font-size: 40px; margin-bottom: 12px; }
.empty-title { font-size: 17px; font-weight: 600; color: #64748b; margin-bottom: 6px; }
.empty-sub   { font-size: 13px; color: #334155; }

.skeleton {
    background: linear-gradient(90deg, #1e293b 25%, #263352 50%, #1e293b 75%);
    background-size: 200% 100%; animation: shimmer 1.4s infinite;
    border-radius: 6px; height: 16px; margin-bottom: 10px;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ═══════════════════════════════════════════════════════════
   LOGIN PAGE
═══════════════════════════════════════════════════════════ */
@media (max-width: 480px) {
    [data-testid="stForm"] { margin: 24px 12px 0 !important; padding: 24px 18px !important; }
}
.login-logo    { font-size: 26px; font-weight: 800; color: #6366f1; margin-bottom: 4px; }
.login-tagline { font-size: 13px; color: #475569; margin-bottom: 28px; }
.forgot-link   { font-size: 12px; color: #6366f1; text-decoration: none; float: right; }
[data-testid="stForm"] .stTextInput input {
    background: #0f1117 !important; border: 1px solid rgba(255,255,255,0.1) !important;
    border-radius: 8px !important; color: #f1f5f9 !important;
}
[data-testid="stForm"] .stTextInput input:focus {
    border-color: #6366f1 !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.2) !important;
}
[data-testid="stForm"] .stTextInput label { color: #94a3b8 !important; font-size: 13px !important; }
[data-testid="stForm"] .stFormSubmitButton > button {
    background: #6366f1 !important; border: none !important; color: #fff !important;
    font-weight: 600 !important; border-radius: 8px !important; width: 100% !important;
}
[data-testid="stForm"] .stFormSubmitButton > button:hover { background: #4f46e5 !important; }

/* ═══════════════════════════════════════════════════════════
   GLOBAL STREAMLIT OVERRIDES
═══════════════════════════════════════════════════════════ */
.stTextInput input {
    background: #1a2235 !important; border: 1px solid rgba(255,255,255,0.08) !important;
    color: #f1f5f9 !important; border-radius: 8px !important;
}
.stTextInput label { color: #94a3b8 !important; }
.stSelectbox > div > div {
    background: #1a2235 !important; border: 1px solid rgba(255,255,255,0.08) !important;
    color: #f1f5f9 !important; border-radius: 8px !important;
}
.stTabs [data-baseweb="tab-list"] {
    background: transparent !important; border-bottom: 1px solid rgba(255,255,255,0.07) !important; flex-wrap: wrap;
}
.stTabs [data-baseweb="tab"] {
    background: transparent !important; color: #64748b !important;
    border: none !important; padding: 10px 16px !important; font-size: 14px !important;
}
.stTabs [aria-selected="true"] { color: #a5b4fc !important; border-bottom: 2px solid #6366f1 !important; }
[data-testid="stMetric"] {
    background: #1a2235; border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px; padding: 14px 16px !important;
}
[data-testid="stMetricLabel"] { color: #64748b !important; font-size: 12px !important; }
[data-testid="stMetricValue"] { color: #f1f5f9 !important; }
hr { border-color: rgba(255,255,255,0.07) !important; }
.streamlit-expanderHeader { color: #94a3b8 !important; background: #1a2235 !important; border-radius: 8px !important; }
.stDataFrame { border: 1px solid rgba(255,255,255,0.07) !important; border-radius: 8px !important; }

/* Primary buttons — indigo (overrides Streamlit's default red) */
.stButton > button {
    border-radius: 8px !important;
    font-weight: 500 !important;
    transition: all 0.15s ease !important;
}
[data-testid="baseButton-primary"],
button[kind="primary"],
.stButton > button[data-testid="baseButton-primary"] {
    background: #6366f1 !important;
    border: none !important;
    color: #fff !important;
}
[data-testid="baseButton-primary"]:hover,
button[kind="primary"]:hover {
    background: #4f46e5 !important;
}
[data-testid="baseButton-secondary"] {
    background: transparent !important;
    border: 1px solid rgba(255,255,255,0.15) !important;
    color: #94a3b8 !important;
}
[data-testid="baseButton-secondary"]:hover {
    border-color: #6366f1 !important;
    color: #a5b4fc !important;
}
.stCaption, [data-testid="stCaptionContainer"] { color: #475569 !important; }
</style>
"""
