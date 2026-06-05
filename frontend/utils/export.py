"""
utils/export.py — Spec-aligned export helpers, data quality checks, run manifest builder.
Moved from app.py lines 28–572.
"""

import io
import json
import traceback
import zipfile
from datetime import datetime, timezone

import httpx
import pandas as pd
import streamlit as st

_SPEC_VERSION = "1.0"

_SPEC_RENAMES = {
    "SiteInformation.csv": {
        "site_code": "SiteCode", "site_name": "SiteName", "country_code": "CountryCode",
        "site_type": "SiteType", "region": "Region", "division": "Division",
        "district": "District", "assigned_dc": "AssignedDC",
    },
    "ItemInformation.csv": {
        "item_code": "ItemCode", "item_description": "ItemDescription", "uom": "UOM",
        "item_status": "ItemStatus", "category": "Category", "subcategory": "Subcategory",
        "brand": "Brand", "unit_cost": "UnitCost", "unit_price": "UnitPrice",
        "supplier_code": "SupplierCode", "velocity_class": "VelocityClass",
        "lifecycle_profile": "LifecycleProfile", "case_pack_size": "CasePackSize",
        "size_group": "SizeGroup", "size_rank": "SizeRank",
        "is_ecomm_eligible": "IsEcommEligible",
    },
    "SupplierInformation.csv": {
        "supplier_code": "SupplierCode", "supplier_name": "SupplierName",
        "supplier_country": "SupplierCountry", "supplier_region": "SupplierRegion",
        "category": "Category",
    },
    "InventoryInformation.csv": {
        "site_code": "SiteCode", "item_code": "ItemCode",
        "inventory_week": "InventoryDate", "on_hand_quantity": "QuantityOnHand",
        "available_quantity": "AvailableQty", "on_order_quantity": "OnOrderQty",
        "inventory_status": "InventoryStatus",
    },
    "SupplierOrderHeader.csv": {
        "purchase_order_number": "PurchaseOrderNumber", "dc_code": "SiteCode",
        "supplier_code": "SupplierCode", "order_date": "OrderDate",
        "expected_receipt_date": "ExpectedReceiptDate", "order_status": "OrderStatus",
    },
    "SupplierOrderLine.csv": {
        "purchase_order_number": "PurchaseOrderNumber", "line_number": "LineNumber",
        "dc_code": "SiteCode", "item_code": "ItemCode", "supplier_code": "SupplierCode",
        "need_quantity": "NeedQuantity", "order_quantity": "OrderQuantity",
        "unit_cost": "UnitCost", "uom": "UOM",
    },
    "SupplierReceipts.csv": {
        "receipt_id": "ReceiptId", "purchase_order_number": "PurchaseOrderNumber",
        "line_number": "LineNumber", "dc_code": "SiteCode", "item_code": "ItemCode",
        "receipt_date": "ReceiptDate", "received_quantity": "ReceivedQuantity",
        "receipt_type": "ReceiptType", "is_late": "IsLate", "is_partial": "IsPartial",
    },
    "CustomerOrderHeader.csv": {
        "store_order_number": "CustomerOrderNumber", "store_code": "SiteCode",
        "order_week": "OrderWeek", "order_date": "OrderDate", "order_status": "OrderStatus",
    },
    "CustomerOrderLine.csv": {
        "store_order_number": "CustomerOrderNumber", "line_number": "LineNumber",
        "item_code": "ItemCode", "order_quantity": "OrderQuantity", "uom": "UOM",
    },
    "CustomerOrderDelivery.csv": {
        "store_order_number": "CustomerOrderNumber", "line_number": "LineNumber",
        "store_code": "SiteCode", "item_code": "ItemCode",
        "delivery_week": "DeliveryWeek", "order_quantity": "OrderQuantity",
        "delivered_quantity": "DeliveredQuantity", "unfilled_quantity": "UnfilledQuantity",
        "delivery_status": "DeliveryStatus", "is_late": "IsLate",
    },
    "SalesHistoryInformation.csv": {
        "store_code": "SiteCode", "item_code": "ItemCode", "sales_week": "SalesWeek",
        "sales_quantity": "SalesQuantity", "sales_amount": "SalesAmount",
        "unit_price": "UnitPrice", "uom": "UOM",
    },
    "CalendarPeriod.csv": {},
    "Currency.csv": {},
    "PromoEvents.csv": {
        "promo_event_id": "PromoEventId", "item_code": "ItemCode", "store_code": "SiteCode",
        "event_type": "EventType", "promo_start_date": "PromoStartDate",
        "promo_end_date": "PromoEndDate", "demand_multiplier": "DemandMultiplier",
    },
}


def show_error(title: str, exc: Exception, response: httpx.Response | None = None):
    st.error(f"**{title}:** {exc}")
    if response is not None:
        try:
            body = response.json()
            detail = body.get("detail", body)
            if isinstance(detail, dict):
                st.error(f"**{detail.get('error', 'Error')}:** {detail.get('message', '')}")
                with st.expander("Simulation engine traceback", expanded=True):
                    st.code(detail.get("traceback", ""), language="python")
            else:
                with st.expander(f"Response body (HTTP {response.status_code})", expanded=True):
                    st.code(str(detail))
        except Exception:
            with st.expander(f"Raw response (HTTP {response.status_code})", expanded=True):
                st.code(response.text)
    with st.expander("Frontend traceback"):
        st.code(traceback.format_exc(), language="python")


def _prepare_export_dfs(
    filter_store, filter_item,
    items_df, stores_df, dcs_df, dc_inv_df,
    sup_orders_df, sup_od_df, sup_rec_df,
    str_orders_df, store_od_df, str_rec_df,
    sales_hist_df, store_inv_df,
    weekly_pos_df=None, weekly_shipments_df=None, supplier_dc_inv_df=None,
    store_dc_map=None, start_date=None, end_date=None,
) -> dict[str, pd.DataFrame]:
    if weekly_pos_df is None:
        weekly_pos_df = pd.DataFrame()
    if weekly_shipments_df is None:
        weekly_shipments_df = pd.DataFrame()
    if supplier_dc_inv_df is None:
        supplier_dc_inv_df = pd.DataFrame()
    if store_dc_map is None:
        store_dc_map = {}

    def _filt(df, store_col=None, item_col=None):
        if filter_store and store_col and store_col in df.columns:
            df = df[df[store_col] == filter_store]
        if filter_item and item_col and item_col in df.columns:
            df = df[df[item_col] == filter_item]
        return df.reset_index(drop=True)

    def _dc_filt(df, dc_col="dc_id", item_col=None):
        sel_dc = store_dc_map.get(filter_store) if filter_store else None
        if sel_dc and dc_col in df.columns:
            df = df[df[dc_col] == sel_dc]
        if filter_item and item_col and item_col in df.columns:
            df = df[df[item_col] == filter_item]
        return df.reset_index(drop=True)

    def _rename(fname, df):
        return df.rename(columns=_SPEC_RENAMES.get(fname, {}))

    _dc_id_to_code = (
        dict(zip(dcs_df["dc_id"], dcs_df["dc_code"]))
        if not dcs_df.empty and "dc_id" in dcs_df.columns and "dc_code" in dcs_df.columns
        else {}
    )

    store_rows = stores_df[["store_id", "store_code", "store_name", "region"]].copy()
    store_rows = store_rows.rename(columns={"store_code": "site_code", "store_name": "site_name"})
    store_rows["site_type"]    = "STORE"
    store_rows["country_code"] = stores_df.get("country_code", pd.Series("", index=stores_df.index))
    store_rows["division"]     = stores_df.get("division",     pd.Series("", index=stores_df.index))
    store_rows["district"]     = stores_df.get("district",     pd.Series("", index=stores_df.index))
    store_rows["assigned_dc"]  = store_rows["store_id"].map(
        lambda sid: _dc_id_to_code.get(store_dc_map.get(sid, ""), "")
    )
    store_rows = store_rows.drop(columns=["store_id"])

    if not dcs_df.empty and "dc_code" in dcs_df.columns:
        dc_cols = {"dc_code": "site_code", "dc_name": "site_name"}
        dc_rows = dcs_df[[c for c in dc_cols if c in dcs_df.columns]].copy()
        dc_rows = dc_rows.rename(columns=dc_cols)
        if "site_name" not in dc_rows.columns:
            dc_rows["site_name"] = dc_rows["site_code"]
        dc_rows["site_type"]    = "DC"
        dc_rows["region"]       = dcs_df["region"]       if "region"       in dcs_df.columns else ""
        dc_rows["country_code"] = dcs_df["country_code"] if "country_code" in dcs_df.columns else ""
        dc_rows["division"]     = dcs_df["division"]     if "division"     in dcs_df.columns else ""
        dc_rows["district"]     = dcs_df["district"]     if "district"     in dcs_df.columns else ""
        dc_rows["assigned_dc"]  = ""
        site_df = pd.concat([store_rows, dc_rows], ignore_index=True)
    else:
        site_df = store_rows

    if filter_store:
        sel_store_code = stores_df.loc[stores_df["store_id"] == filter_store, "store_code"]
        if not sel_store_code.empty:
            sc = sel_store_code.iloc[0]
            sel_dc_code = _dc_id_to_code.get(store_dc_map.get(filter_store, ""), "")
            keep = site_df["site_code"].isin([sc] + ([sel_dc_code] if sel_dc_code else []))
            site_df = site_df[keep].reset_index(drop=True)

    item_cols = [c for c in [
        "item_code", "item_description", "uom", "item_status", "category", "subcategory",
        "brand", "unit_cost", "unit_price", "velocity_class", "lifecycle_profile",
        "case_pack_size", "size_group", "size_rank", "is_ecomm_eligible",
    ] if c in items_df.columns]
    item_info_df = items_df[item_cols].copy()
    if filter_item:
        sel_item_code = items_df.loc[items_df["item_id"] == filter_item, "item_code"]
        if not sel_item_code.empty:
            item_info_df = item_info_df[item_info_df["item_code"] == sel_item_code.iloc[0]]
    item_info_df = item_info_df.reset_index(drop=True)

    sup_cols = [c for c in ["supplier_code", "supplier_name", "supplier_country", "supplier_region", "category"]
                if c in sup_orders_df.columns]
    if sup_cols:
        sup_info_df = sup_orders_df[sup_cols].drop_duplicates().reset_index(drop=True)
    else:
        sup_info_df = pd.DataFrame(columns=["supplier_code", "supplier_name",
                                             "supplier_country", "supplier_region", "category"])

    store_inv_cols = [c for c in ["store_code", "item_code", "inventory_week",
                                  "on_hand_quantity", "available_quantity",
                                  "on_order_quantity", "inventory_status"] if c in store_inv_df.columns]
    si = store_inv_df[store_inv_cols].copy().rename(columns={"store_code": "site_code"})

    dc_inv_cols = [c for c in ["dc_code", "item_code", "inventory_week",
                                "on_hand_quantity", "available_quantity",
                                "on_order_quantity", "inventory_status"] if c in dc_inv_df.columns]
    di = dc_inv_df[dc_inv_cols].copy().rename(columns={"dc_code": "site_code"})

    inv_df = pd.concat([si, di], ignore_index=True)
    if filter_store and "site_code" in inv_df.columns:
        sel_store_code = stores_df.loc[stores_df["store_id"] == filter_store, "store_code"]
        if not sel_store_code.empty:
            inv_df = inv_df[inv_df["site_code"] == sel_store_code.iloc[0]]
    if filter_item and "item_code" in inv_df.columns:
        sel_item_code = items_df.loc[items_df["item_id"] == filter_item, "item_code"]
        if not sel_item_code.empty:
            inv_df = inv_df[inv_df["item_code"] == sel_item_code.iloc[0]]
    inv_df = inv_df.reset_index(drop=True)

    sup_hdr_df  = _dc_filt(sup_orders_df)
    sup_line_df = _dc_filt(sup_od_df, item_col="item_id")
    sup_rec_filt = _dc_filt(sup_rec_df, item_col="item_id")

    cust_hdr_df  = _filt(str_orders_df, store_col="store_id")
    cust_line_df = store_od_df.copy()
    if filter_store and "store_order_number" in cust_line_df.columns and "store_order_number" in cust_hdr_df.columns:
        valid_orders = cust_hdr_df["store_order_number"].unique()
        cust_line_df = cust_line_df[cust_line_df["store_order_number"].isin(valid_orders)]
    if filter_item and "item_id" in cust_line_df.columns:
        cust_line_df = cust_line_df[cust_line_df["item_id"] == filter_item]
    cust_line_df = cust_line_df.reset_index(drop=True)

    del_df = _filt(str_rec_df, store_col="store_id", item_col="item_id").copy()
    if not del_df.empty and "delivery_date" in del_df.columns:
        _dd = pd.to_datetime(del_df["delivery_date"], errors="coerce")
        del_df["delivery_week"] = _dd.dt.strftime("%Y-W%V")
    elif "delivery_week" not in del_df.columns:
        del_df["delivery_week"] = ""
    if not del_df.empty:
        # df.get(col, default) returns the default *scalar* (not a Series) when col is missing.
        # Wrap with a zero-Series so to_numeric().fillna() always operates on a Series.
        _zero = pd.Series(0, index=del_df.index)
        _oq = pd.to_numeric(
            del_df["order_quantity"] if "order_quantity" in del_df.columns else _zero,
            errors="coerce",
        ).fillna(0)
        _dq = pd.to_numeric(
            del_df["delivered_quantity"] if "delivered_quantity" in del_df.columns else _zero,
            errors="coerce",
        ).fillna(0)
        del_df["unfilled_quantity"] = (_oq - _dq).clip(lower=0)

    sales_filt = _filt(sales_hist_df, store_col="store_id", item_col="item_id")

    from datetime import date as _date
    days = pd.date_range(
        start=start_date or _date(2024, 1, 1),
        end=end_date or _date(2026, 6, 30),
        freq="D",
    )
    cal_df = pd.DataFrame({
        "CalendarDate":  [d.strftime("%Y-%m-%d") for d in days],
        "WeekId":        [d.strftime("%Y-W%V") for d in days],
        "WeekStartDate": [(d - pd.Timedelta(days=d.weekday())).strftime("%Y-%m-%d") for d in days],
        "MonthId":       [d.strftime("%Y-%m") for d in days],
        "QuarterId":     [f"{d.year}-Q{(d.month - 1) // 3 + 1}" for d in days],
        "YearId":        [d.year for d in days],
        "DayOfWeek":     [d.strftime("%A") for d in days],
        "IsWeekend":     [1 if d.weekday() >= 5 else 0 for d in days],
    })

    cur_df = pd.DataFrame([{
        "CurrencyCode":      "USD",
        "CurrencyName":      "US Dollar",
        "ExchangeRateToUSD": 1.0,
        "EffectiveDate":     str(start_date),
    }])

    promo_rows = []
    if not weekly_pos_df.empty and "is_promo_demand" in weekly_pos_df.columns:
        promo_demand = weekly_pos_df[weekly_pos_df["is_promo_demand"].astype(str).isin(["True", "1", "true"])].copy()
        if filter_store and "store_id" in promo_demand.columns:
            promo_demand = promo_demand[promo_demand["store_id"] == filter_store]
        if filter_item and "item_id" in promo_demand.columns:
            promo_demand = promo_demand[promo_demand["item_id"] == filter_item]
        if not promo_demand.empty:
            grp_cols = [c for c in ["store_code", "item_code"] if c in promo_demand.columns]
            for grp_key, grp in promo_demand.groupby(grp_cols) if grp_cols else []:
                row: dict = {}
                if isinstance(grp_key, tuple):
                    for k, v in zip(grp_cols, grp_key):
                        row[k] = v
                else:
                    row[grp_cols[0]] = grp_key
                row["promo_event_id"] = ""
                row["event_type"] = "PROMO"
                if "pos_week" in grp.columns:
                    weeks_sorted = sorted(grp["pos_week"].dropna().unique())
                    row["promo_start_date"] = weeks_sorted[0]  if weeks_sorted else ""
                    row["promo_end_date"]   = weeks_sorted[-1] if weeks_sorted else ""
                row["demand_multiplier"] = ""
                promo_rows.append(row)
    promo_df = pd.DataFrame(promo_rows) if promo_rows else pd.DataFrame(
        columns=["promo_event_id", "item_code", "store_code", "event_type",
                 "promo_start_date", "promo_end_date", "demand_multiplier"]
    )

    def _drop_ids(df):
        id_cols = [c for c in df.columns if c.endswith("_id")]
        return df.drop(columns=id_cols, errors="ignore")

    # Filter weekly_pos and weekly_shipments
    wpos_filt = weekly_pos_df.copy()
    if filter_store and "store_id" in wpos_filt.columns:
        wpos_filt = wpos_filt[wpos_filt["store_id"] == filter_store]
    if filter_item and "item_id" in wpos_filt.columns:
        wpos_filt = wpos_filt[wpos_filt["item_id"] == filter_item]
    wpos_filt = _drop_ids(wpos_filt.reset_index(drop=True))

    wship_filt = weekly_shipments_df.copy()
    if filter_item and "item_id" in wship_filt.columns:
        wship_filt = wship_filt[wship_filt["item_id"] == filter_item]
    wship_filt = _drop_ids(wship_filt.reset_index(drop=True))

    sdcinv_filt = supplier_dc_inv_df.copy()
    if filter_item and "item_id" in sdcinv_filt.columns:
        sdcinv_filt = sdcinv_filt[sdcinv_filt["item_id"] == filter_item]
    sdcinv_filt = _drop_ids(sdcinv_filt.reset_index(drop=True))

    return {
        "SiteInformation.csv":         _rename("SiteInformation.csv",         _drop_ids(site_df)),
        "ItemInformation.csv":         _rename("ItemInformation.csv",         _drop_ids(item_info_df)),
        "SupplierInformation.csv":     _rename("SupplierInformation.csv",     _drop_ids(sup_info_df)),
        "InventoryInformation.csv":    _rename("InventoryInformation.csv",    _drop_ids(inv_df)),
        "WeeklyPOS.csv":               wpos_filt,
        "WeeklyShipments.csv":         wship_filt,
        "SupplierDCInventory.csv":     sdcinv_filt,
        "SupplierOrderHeader.csv":     _rename("SupplierOrderHeader.csv",     _drop_ids(sup_hdr_df)),
        "SupplierOrderLine.csv":       _rename("SupplierOrderLine.csv",       _drop_ids(sup_line_df)),
        "SupplierReceipts.csv":        _rename("SupplierReceipts.csv",        _drop_ids(sup_rec_filt)),
        "CustomerOrderHeader.csv":     _rename("CustomerOrderHeader.csv",     _drop_ids(cust_hdr_df)),
        "CustomerOrderLine.csv":       _rename("CustomerOrderLine.csv",       _drop_ids(cust_line_df)),
        "CustomerOrderDelivery.csv":   _rename("CustomerOrderDelivery.csv",   _drop_ids(del_df)),
        "SalesHistoryInformation.csv": _rename("SalesHistoryInformation.csv", _drop_ids(sales_filt)),
        "CalendarPeriod.csv":          cal_df,
        "Currency.csv":                cur_df,
        "PromoEvents.csv":             _rename("PromoEvents.csv",             _drop_ids(promo_df)),
    }


def _build_zip(export_dfs, extra_files=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, df in export_dfs.items():
            zf.writestr(fname, df.to_csv(index=False))
        for fname, text in (extra_files or {}).items():
            zf.writestr(fname, text)
    return buf.getvalue()


def _run_quality_checks(store_inv_df, dc_inv_df, sales_hist_df, weekly_pos_df,
                        sup_orders_df, sup_od_df, str_orders_df, store_od_df):
    results = []

    def _chk(name, passed, violations=0, details=""):
        results.append({"name": name, "passed": bool(passed),
                        "violations": int(violations), "details": details})

    def _num(df, col):
        return pd.to_numeric(df[col], errors="coerce").fillna(0)

    if not store_inv_df.empty and "on_hand_quantity" in store_inv_df.columns:
        neg = int((_num(store_inv_df, "on_hand_quantity") < 0).sum())
        _chk("no_negative_store_inventory", neg == 0, neg,
             f"{neg} rows with on_hand_quantity < 0" if neg else "")
    else:
        _chk("no_negative_store_inventory", True)

    if not dc_inv_df.empty and "on_hand_quantity" in dc_inv_df.columns:
        neg = int((_num(dc_inv_df, "on_hand_quantity") < 0).sum())
        _chk("no_negative_dc_inventory", neg == 0, neg,
             f"{neg} rows with on_hand_quantity < 0" if neg else "")
    else:
        _chk("no_negative_dc_inventory", True)

    if not sales_hist_df.empty and "sales_quantity" in sales_hist_df.columns:
        neg = int((_num(sales_hist_df, "sales_quantity") < 0).sum())
        _chk("sales_quantity_non_negative", neg == 0, neg,
             f"{neg} rows with sales_quantity < 0" if neg else "")
    else:
        _chk("sales_quantity_non_negative", True)

    if (not sup_od_df.empty and not sup_orders_df.empty
            and "purchase_order_number" in sup_od_df.columns
            and "purchase_order_number" in sup_orders_df.columns):
        orphans = int((~sup_od_df["purchase_order_number"]
                       .isin(sup_orders_df["purchase_order_number"])).sum())
        _chk("supplier_lines_have_header", orphans == 0, orphans,
             f"{orphans} orphan supplier order lines" if orphans else "")
    else:
        _chk("supplier_lines_have_header", True)

    if (not store_od_df.empty and not str_orders_df.empty
            and "store_order_number" in store_od_df.columns
            and "store_order_number" in str_orders_df.columns):
        orphans = int((~store_od_df["store_order_number"]
                       .isin(str_orders_df["store_order_number"])).sum())
        _chk("store_lines_have_header", orphans == 0, orphans,
             f"{orphans} orphan store order lines" if orphans else "")
    else:
        _chk("store_lines_have_header", True)

    if (not weekly_pos_df.empty
            and "sales_qty" in weekly_pos_df.columns
            and "demand_qty" in weekly_pos_df.columns):
        ts   = float(_num(weekly_pos_df, "sales_qty").sum())
        td   = float(_num(weekly_pos_df, "demand_qty").sum())
        rate = ts / td if td > 0 else 1.0
        _chk("store_fill_rate_above_floor", rate >= 0.50,
             0 if rate >= 0.50 else 1, f"fill_rate={rate:.1%} (floor=50%)")
    else:
        _chk("store_fill_rate_above_floor", True)

    if not dc_inv_df.empty and "inventory_status" in dc_inv_df.columns:
        total  = len(dc_inv_df)
        zeroes = int((dc_inv_df["inventory_status"] == "ZERO").sum())
        rate   = zeroes / total if total > 0 else 0.0
        _chk("dc_stockout_rate_below_ceiling", rate < 0.40,
             0 if rate < 0.40 else 1, f"stockout_rate={rate:.1%} (ceiling=40%)")
    else:
        _chk("dc_stockout_rate_below_ceiling", True)

    return results


def _build_data_quality_report(store_inv_df, dc_inv_df, sales_hist_df, weekly_pos_df,
                               sup_orders_df, sup_od_df, str_orders_df, store_od_df,
                               sim_duration_seconds=None):
    checks = _run_quality_checks(
        store_inv_df, dc_inv_df, sales_hist_df, weekly_pos_df,
        sup_orders_df, sup_od_df, str_orders_df, store_od_df,
    )
    validation_passed = all(c["passed"] for c in checks)

    def _n(df, col):
        return float(pd.to_numeric(df[col], errors="coerce").fillna(0).sum()) \
            if not df.empty and col in df.columns else 0.0

    total_demand = _n(weekly_pos_df, "demand_qty")
    total_sales  = _n(weekly_pos_df, "sales_qty")
    fill_rate    = total_sales / total_demand if total_demand > 0 else 1.0

    dc_total    = len(dc_inv_df) if not dc_inv_df.empty else 0
    dc_stockout = (
        int((dc_inv_df["inventory_status"] == "ZERO").sum()) / dc_total
        if dc_total > 0 and "inventory_status" in dc_inv_df.columns else 0.0
    )

    store_count = int(store_inv_df["store_id"].nunique()) \
        if not store_inv_df.empty and "store_id" in store_inv_df.columns else 0
    item_count  = int(store_inv_df["item_id"].nunique()) \
        if not store_inv_df.empty and "item_id" in store_inv_df.columns else 0
    dc_count    = int(dc_inv_df["dc_id"].nunique()) \
        if not dc_inv_df.empty and "dc_id" in dc_inv_df.columns else 0

    return {
        "validation_passed": validation_passed,
        "checks": checks,
        "summary_stats": {
            "store_fill_rate":             round(fill_rate, 4),
            "dc_stockout_rate":            round(dc_stockout, 4),
            "total_demand_units":          round(total_demand, 2),
            "total_sales_units":           round(total_sales, 2),
            "total_lost_sales_units":      round(max(total_demand - total_sales, 0), 2),
            "store_count":                 store_count,
            "item_count":                  item_count,
            "dc_count":                    dc_count,
            "simulation_duration_seconds": sim_duration_seconds,
        },
    }


def _build_run_manifest(sim_id, config_block, export_dfs, validation_passed):
    _site_df     = export_dfs.get("SiteInformation.csv", pd.DataFrame())
    _store_count = int((_site_df["SiteType"] == "STORE").sum()) \
        if not _site_df.empty and "SiteType" in _site_df.columns else 0
    _dc_count    = int((_site_df["SiteType"] == "DC").sum()) \
        if not _site_df.empty and "SiteType" in _site_df.columns else 0
    _item_count  = len(export_dfs.get("ItemInformation.csv", pd.DataFrame()))
    _sup_count   = len(export_dfs.get("SupplierInformation.csv", pd.DataFrame()))

    spec_config = {
        "seed":                 config_block.get("seed"),
        "start_date":           config_block.get("start_date"),
        "end_date":             config_block.get("end_date"),
        "replenishment_policy": config_block.get("replenishment_policy"),
        "store_count":          _store_count,
        "item_count":           _item_count,
        "dc_count":             _dc_count,
        "supplier_count":       _sup_count,
    }

    feeds = [{"filename": k, "rows": len(v), "path": k} for k, v in export_dfs.items()]

    return {
        "run_id":            sim_id,
        "generated_at":      datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "spec_version":      _SPEC_VERSION,
        "config":            spec_config,
        "feeds":             feeds,
        "validation_passed": validation_passed,
    }
