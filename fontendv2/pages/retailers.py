import streamlit as st
from router import go_to


def render():

    st.title("🏪 Retailers")

    retailers = [
        {"id": 101, "name": "Freshmart Retail", "industry": "Grocery", "region": "North America", "runs": 17, "completed": 8, "failed": 9},
        {"id": 102, "name": "Metro Apparel Co.", "industry": "Fashion", "region": "Europe", "runs": 0, "completed": 0, "failed": 0},
        {"id": 103, "name": "TechZone Electronics", "industry": "Electronics", "region": "Asia Pacific", "runs": 0, "completed": 0, "failed": 0},
        {"id": 104, "name": "HomeBase Furnishings", "industry": "Home & Garden", "region": "North America", "runs": 0, "completed": 0, "failed": 0},
    ]

    cols = st.columns(3)

    for index, retailer in enumerate(retailers):

        with cols[index % 3]:

            with st.container(border=True):

                st.subheader(retailer["name"])
                st.caption(f"{retailer['industry']} · {retailer['region']}")

                if retailer["runs"] > 0:
                    st.write(f"**{retailer['runs']} runs**")
                    c1, c2 = st.columns(2)
                    c1.success(f"✓ {retailer['completed']} completed")
                    c2.error(f"✗ {retailer['failed']} failed")
                else:
                    st.caption("No simulations yet")

                if st.button(
                    "Open →",
                    key=f"open_{retailer['id']}",
                    use_container_width=True
                ):
                    go_to("runs", id=retailer["id"])
