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
    background: #111827 !important;
    border-right: 1px solid rgba(255,255,255,0.08) !important;
    min-width: 260px !important;
    max-width: 260px !important;
    transform: none !important;
    display: flex !important;
}
[data-testid="stSidebar"] > div:first-child {
    display: flex !important;
    flex-direction: column !important;
    height: 100vh !important;
    min-height: 100vh !important;
    padding: 20px 16px !important;
    width: 100% !important;
    position: relative !important;
    box-sizing: border-box !important;
}
[data-testid="stSidebar"] .block-container { padding: 0 !important; }

/* Hide collapse buttons */
[data-testid="collapsedControl"],
[data-testid="stSidebarCollapseButton"] { display: none !important; }

/* Kill default backgrounds/borders on inner wrappers; propagate flex height */
[data-testid="stSidebar"] .stMarkdown,
[data-testid="stSidebar"] [data-testid="stVerticalBlockBorderWrapper"] {
    background: transparent !important;
    box-shadow: none !important;
    border: none !important;
}
[data-testid="stSidebar"] [data-testid="stVerticalBlock"] {
    background: transparent !important;
    box-shadow: none !important;
    border: none !important;
    display: flex !important;
    flex-direction: column !important;
    gap: 0 !important;
    flex: 1 !important;
    min-height: 0 !important;
}

/* ── Logo ── */
.sb-logo { display: flex; align-items: center; gap: 14px; padding: 6px 4px; margin-bottom: 28px; }
.sb-logo-icon {
    width: 44px; height: 44px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 14px;
    background: linear-gradient(135deg, #2563eb, #4f46e5);
    font-size: 20px;
}
.sb-logo-text { display: flex; flex-direction: column; gap: 2px; }
.sb-name {
    font-size: 18px !important; font-weight: 700 !important;
    color: #ffffff !important; margin: 0 !important; padding: 0 !important;
    line-height: 1.2 !important;
}
.sb-subtitle {
    font-size: 12px !important; color: #9ca3af !important;
    margin: 3px 0 0 !important; padding: 0 !important; line-height: 1.2 !important;
}

/* ── Nav ── */
.sb-nav { display: flex; flex-direction: column; gap: 8px; }
.sb-nav-label {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
    color: #6b7280 !important; padding-left: 10px; margin-bottom: 8px; margin-top: 0; display: block;
}
.sb-nav-item {
    width: 100%; display: flex; align-items: center; gap: 12px;
    padding: 13px 14px; border: none; border-radius: 14px;
    background: transparent; color: #e5e7eb !important;
    font-size: 15px; font-weight: 500; cursor: pointer;
    transition: all 0.2s ease;
}
.sb-nav-item:hover { background: rgba(255,255,255,0.06); }
.sb-nav-active {
    background: #2563eb !important; color: #ffffff !important;
    box-shadow: 0 6px 20px rgba(37,99,235,0.25);
}
.sb-nav-disabled { opacity: 0.45; cursor: not-allowed; }
.sb-nav-icon { font-size: 16px; }

/* ── Retailers button (used when not active) ── */
[data-testid="stSidebar"] [data-testid="stButton-nav_retailers"] > button {
    all: unset !important;
    width: 100% !important; display: flex !important; align-items: center !important;
    gap: 12px !important; padding: 13px 14px !important; border-radius: 14px !important;
    background: transparent !important; color: #e5e7eb !important;
    font-size: 15px !important; font-weight: 500 !important; cursor: pointer !important;
    transition: all 0.2s ease !important; box-sizing: border-box !important;
}
[data-testid="stSidebar"] [data-testid="stButton-nav_retailers"] > button:hover {
    background: rgba(255,255,255,0.06) !important;
}

/* ── Sign out — pushed to bottom via margin-top: auto ── */
[data-testid="stSidebar"] [data-testid="stButton-nav_logout"] {
    margin-top: auto !important;
    border-top: 1px solid rgba(255,255,255,0.08) !important;
    padding-top: 20px !important;
    flex-shrink: 0 !important;
}
[data-testid="stSidebar"] [data-testid="stButton-nav_logout"] > button {
    all: unset !important;
    display: block !important; width: 100% !important; text-align: center !important;
    padding: 13px !important; border-radius: 14px !important;
    background: rgba(255,255,255,0.05) !important; color: #f3f4f6 !important;
    font-size: 14px !important; font-weight: 500 !important; cursor: pointer !important;
    transition: all 0.2s ease !important; box-sizing: border-box !important;
}
[data-testid="stSidebar"] [data-testid="stButton-nav_logout"] > button:hover {
    background: rgba(255,255,255,0.10) !important;
}

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
