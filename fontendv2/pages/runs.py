import streamlit as st
from router import go_to


def render():

    retailer_id = st.query_params.get("id")

    runs_data = {
        "101": [
            {"id": "run_001", "name": "Spring Forecast", "date": "2024-03-01", "period": "W01 → W13", "status": "Completed"},
            {"id": "run_002", "name": "Summer Planning", "date": "2024-05-15", "period": "W14 → W26", "status": "In Progress"},
            {"id": "run_003", "name": "Q3 Simulation",   "date": "2024-07-10", "period": "W27 → W39", "status": "Failed"},
            {"id": "run_004", "name": "Holiday Run",     "date": "2024-09-01", "period": "W40 → W52", "status": "Queued"},
        ],
        "102": [
            {"id": "run_005", "name": "Fashion Week Sim", "date": "2024-02-10", "period": "W05 → W10", "status": "Completed"},
        ],
        "103": [],
        "104": [],
    }

    runs = runs_data.get(str(retailer_id), [])

    st.title("Simulation Runs")

    if st.button("← Back"):
        go_to("retailers")

    if not runs:
        st.info("No simulation runs yet.")
        return

    cols = st.columns(3)

    for index, run in enumerate(runs):

        with cols[index % 3]:

            with st.container(border=True):

                st.subheader(run["name"])
                st.write(f"Date: {run['date']}")
                st.write(f"Period: {run['period']}")
                st.write(f"Status: {run['status']}")

                if st.button(
                    "Open",
                    key=run["id"]
                ):
                    go_to(
                        "run_details",
                        id=run["id"],
                        retailer_id=retailer_id,
                    )
