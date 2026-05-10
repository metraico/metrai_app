import streamlit as st
from router import go_to


def render():

    run_id = st.query_params.get("id")
    retailer_id = st.query_params.get("retailer_id")

    run_data = {
        "run_001": {"name": "Spring Forecast",  "date": "2024-03-01", "period": "W01 → W13", "status": "Completed",  "weeks": 13, "skus": 240},
        "run_002": {"name": "Summer Planning",  "date": "2024-05-15", "period": "W14 → W26", "status": "In Progress","weeks": 13, "skus": 310},
        "run_003": {"name": "Q3 Simulation",    "date": "2024-07-10", "period": "W27 → W39", "status": "Failed",     "weeks": 13, "skus": 180},
        "run_004": {"name": "Holiday Run",      "date": "2024-09-01", "period": "W40 → W52", "status": "Queued",     "weeks": 13, "skus": 420},
        "run_005": {"name": "Fashion Week Sim", "date": "2024-02-10", "period": "W05 → W10", "status": "Completed",  "weeks": 6,  "skus": 95},
    }

    run = run_data.get(run_id)

    if not run:
        st.error("Run not found.")
        return

    st.title(run["name"])

    st.write(f"Date: {run['date']}")
    st.write(f"Period: {run['period']}")
    st.write(f"Status: {run['status']}")
    st.write(f"Weeks: {run['weeks']}")
    st.write(f"SKUs: {run['skus']}")

    if st.button("← Back"):
        go_to("runs", id=retailer_id)
