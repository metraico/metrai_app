"""
frontend/app.py — Metrai Simulation Dashboard

Login-gated Streamlit frontend. After login, two tabs are shown:
  1. Network & Assortment — configure store/DC/supplier mappings before running
  2. Run Simulation       — configure and run a simulation, view results + history
"""

import io
import json
import os
import re as _re
import time
import traceback
import zipfile
from datetime import date, datetime, timezone

import httpx
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from dotenv import load_dotenv

load_dotenv()
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")


def show_error(title: str, exc: Exception, response: httpx.Response | None = None):
    """Show a detailed error with full traceback and response body in expanders."""
    st.error(f"**{title}:** {exc}")

    # If the response contains a structured error from the sim engine, surface it prominently
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


# ---------------------------------------------------------------------------
# Spec-aligned export helpers
# ---------------------------------------------------------------------------

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


def _prepare_export_dfs(
    filter_store: str | None,
    filter_item: str | None,
    items_df: pd.DataFrame,
    stores_df: pd.DataFrame,
    dcs_df: pd.DataFrame,
    dc_inv_df: pd.DataFrame,
    sup_orders_df: pd.DataFrame,
    sup_od_df: pd.DataFrame,
    sup_rec_df: pd.DataFrame,
    str_orders_df: pd.DataFrame,
    store_od_df: pd.DataFrame,
    str_rec_df: pd.DataFrame,
    sales_hist_df: pd.DataFrame,
    store_inv_df: pd.DataFrame,
    demand_df: pd.DataFrame,
    store_dc_map: dict,
    start_date,
    end_date,
) -> dict[str, pd.DataFrame]:
    """Return dict {filename → renamed DataFrame} for all 14 spec CSV files."""

    def _filt(df: pd.DataFrame, store_col: str | None = None, item_col: str | None = None) -> pd.DataFrame:
        if filter_store and store_col and store_col in df.columns:
            df = df[df[store_col] == filter_store]
        if filter_item and item_col and item_col in df.columns:
            df = df[df[item_col] == filter_item]
        return df.reset_index(drop=True)

    def _dc_filt(df: pd.DataFrame, dc_col: str = "dc_id", item_col: str | None = None) -> pd.DataFrame:
        sel_dc = store_dc_map.get(filter_store) if filter_store else None
        if sel_dc and dc_col in df.columns:
            df = df[df[dc_col] == sel_dc]
        if filter_item and item_col and item_col in df.columns:
            df = df[df[item_col] == filter_item]
        return df.reset_index(drop=True)

    def _rename(fname: str, df: pd.DataFrame) -> pd.DataFrame:
        return df.rename(columns=_SPEC_RENAMES.get(fname, {}))

    # ── SiteInformation: unified stores + DCs ───────────────────────────────
    # Build dc_id → dc_code map for AssignedDC column
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
        dc_cols = {
            "dc_code": "site_code",
            "dc_name": "site_name",
        }
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
            # Include the store row and the DC that serves it
            sel_dc_code = _dc_id_to_code.get(store_dc_map.get(filter_store, ""), "")
            keep = site_df["site_code"].isin([sc] + ([sel_dc_code] if sel_dc_code else []))
            site_df = site_df[keep].reset_index(drop=True)

    # ── ItemInformation ─────────────────────────────────────────────────────
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

    # ── SupplierInformation ──────────────────────────────────────────────────
    sup_cols = [c for c in ["supplier_code", "supplier_name", "supplier_country", "supplier_region", "category"]
                if c in sup_orders_df.columns]
    if sup_cols:
        sup_info_df = sup_orders_df[sup_cols].drop_duplicates().reset_index(drop=True)
    else:
        sup_info_df = pd.DataFrame(columns=["supplier_code", "supplier_name",
                                             "supplier_country", "supplier_region", "category"])

    # ── InventoryInformation: store + DC inventory merged ───────────────────
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

    # ── Supplier order header / line ─────────────────────────────────────────
    sup_hdr_df = _dc_filt(sup_orders_df)
    sup_line_df = _dc_filt(sup_od_df, item_col="item_id")
    sup_rec_filt = _dc_filt(sup_rec_df, item_col="item_id")

    # ── Customer order header / line / delivery ───────────────────────────────
    cust_hdr_df = _filt(str_orders_df, store_col="store_id")
    cust_line_df = store_od_df.copy()
    if filter_store and "store_order_number" in cust_line_df.columns and "store_order_number" in cust_hdr_df.columns:
        valid_orders = cust_hdr_df["store_order_number"].unique()
        cust_line_df = cust_line_df[cust_line_df["store_order_number"].isin(valid_orders)]
    if filter_item and "item_id" in cust_line_df.columns:
        cust_line_df = cust_line_df[cust_line_df["item_id"] == filter_item]
    cust_line_df = cust_line_df.reset_index(drop=True)

    # CustomerOrderDelivery: engine now writes delivery vocab directly; no join needed
    del_df = _filt(str_rec_df, store_col="store_id", item_col="item_id").copy()
    if not del_df.empty and "delivery_date" in del_df.columns:
        _dd = pd.to_datetime(del_df["delivery_date"], errors="coerce")
        del_df["delivery_week"] = _dd.dt.strftime("%Y-W%V")
    elif "delivery_week" not in del_df.columns:
        del_df["delivery_week"] = ""
    if not del_df.empty:
        _oq = pd.to_numeric(del_df.get("order_quantity",    0), errors="coerce").fillna(0)
        _dq = pd.to_numeric(del_df.get("delivered_quantity", 0), errors="coerce").fillna(0)
        del_df["unfilled_quantity"] = (_oq - _dq).clip(lower=0)

    # ── SalesHistoryInformation ───────────────────────────────────────────────
    sales_filt = _filt(sales_hist_df, store_col="store_id", item_col="item_id")

    # ── CalendarPeriod ────────────────────────────────────────────────────────
    days = pd.date_range(start=start_date, end=end_date, freq="D")
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

    # ── Currency ──────────────────────────────────────────────────────────────
    cur_df = pd.DataFrame([{
        "CurrencyCode":        "USD",
        "CurrencyName":        "US Dollar",
        "ExchangeRateToUSD":   1.0,
        "EffectiveDate":       str(start_date),
    }])

    # ── PromoEvents ───────────────────────────────────────────────────────────
    promo_rows = []
    if "is_promo_demand" in demand_df.columns and "promo_id" in demand_df.columns:
        promo_demand = demand_df[demand_df["is_promo_demand"].astype(str).isin(["True", "1", "true"])].copy()
        if filter_store:
            promo_demand = promo_demand[promo_demand.get("store_id", pd.Series()) == filter_store] \
                if "store_id" in promo_demand.columns else promo_demand
        if filter_item:
            promo_demand = promo_demand[promo_demand.get("item_id", pd.Series()) == filter_item] \
                if "item_id" in promo_demand.columns else promo_demand
        if not promo_demand.empty:
            grp_cols = [c for c in ["promo_id", "store_code", "item_code"] if c in promo_demand.columns]
            for grp_key, grp in promo_demand.groupby(grp_cols):
                row: dict = {}
                if isinstance(grp_key, tuple):
                    for k, v in zip(grp_cols, grp_key):
                        row[k] = v
                else:
                    row[grp_cols[0]] = grp_key
                row["promo_event_id"] = row.get("promo_id", "")
                row["event_type"] = "PROMO"
                if "demand_date" in grp.columns:
                    dates = pd.to_datetime(grp["demand_date"], errors="coerce").dropna()
                    row["promo_start_date"] = dates.min().strftime("%Y-%m-%d") if not dates.empty else ""
                    row["promo_end_date"] = dates.max().strftime("%Y-%m-%d") if not dates.empty else ""
                row["demand_multiplier"] = ""
                promo_rows.append(row)
    promo_df = pd.DataFrame(promo_rows) if promo_rows else pd.DataFrame(
        columns=["promo_event_id", "item_code", "store_code", "event_type",
                 "promo_start_date", "promo_end_date", "demand_multiplier"]
    )

    # Drop UUID id columns before export (keep only code columns)
    def _drop_ids(df: pd.DataFrame) -> pd.DataFrame:
        id_cols = [c for c in df.columns if c.endswith("_id")]
        return df.drop(columns=id_cols, errors="ignore")

    return {
        "SiteInformation.csv":        _rename("SiteInformation.csv", _drop_ids(site_df)),
        "ItemInformation.csv":        _rename("ItemInformation.csv", _drop_ids(item_info_df)),
        "SupplierInformation.csv":    _rename("SupplierInformation.csv", _drop_ids(sup_info_df)),
        "InventoryInformation.csv":   _rename("InventoryInformation.csv", _drop_ids(inv_df)),
        "SupplierOrderHeader.csv":    _rename("SupplierOrderHeader.csv", _drop_ids(sup_hdr_df)),
        "SupplierOrderLine.csv":      _rename("SupplierOrderLine.csv", _drop_ids(sup_line_df)),
        "SupplierReceipts.csv":       _rename("SupplierReceipts.csv", _drop_ids(sup_rec_filt)),
        "CustomerOrderHeader.csv":    _rename("CustomerOrderHeader.csv", _drop_ids(cust_hdr_df)),
        "CustomerOrderLine.csv":      _rename("CustomerOrderLine.csv", _drop_ids(cust_line_df)),
        "CustomerOrderDelivery.csv":  _rename("CustomerOrderDelivery.csv", _drop_ids(del_df)),
        "SalesHistoryInformation.csv": _rename("SalesHistoryInformation.csv", _drop_ids(sales_filt)),
        "CalendarPeriod.csv":         cal_df,
        "Currency.csv":               cur_df,
        "PromoEvents.csv":            _rename("PromoEvents.csv", _drop_ids(promo_df)),
    }


def _build_zip(
    export_dfs: dict[str, pd.DataFrame],
    extra_files: dict[str, str] | None = None,
) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, df in export_dfs.items():
            zf.writestr(fname, df.to_csv(index=False))
        for fname, text in (extra_files or {}).items():
            zf.writestr(fname, text)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# D.1 run_manifest.json  (Spec §7.2)
# D.2 data_quality_report.json  (Spec §8 / §14.7)
# ---------------------------------------------------------------------------

_SPEC_VERSION = "1.0"


def _run_quality_checks(
    store_inv_df: pd.DataFrame,
    dc_inv_df: pd.DataFrame,
    sales_hist_df: pd.DataFrame,
    demand_df: pd.DataFrame,
    sup_orders_df: pd.DataFrame,
    sup_od_df: pd.DataFrame,
    str_orders_df: pd.DataFrame,
    store_od_df: pd.DataFrame,
) -> list[dict]:
    results: list[dict] = []

    def _chk(name: str, passed: bool, violations: int = 0, details: str = ""):
        results.append({"name": name, "passed": bool(passed),
                        "violations": int(violations), "details": details})

    def _num(df: pd.DataFrame, col: str) -> pd.Series:
        return pd.to_numeric(df[col], errors="coerce").fillna(0)

    # 1. No negative store on-hand inventory
    if not store_inv_df.empty and "on_hand_quantity" in store_inv_df.columns:
        neg = int((_num(store_inv_df, "on_hand_quantity") < 0).sum())
        _chk("no_negative_store_inventory", neg == 0, neg,
             f"{neg} rows with on_hand_quantity < 0" if neg else "")
    else:
        _chk("no_negative_store_inventory", True)

    # 2. No negative DC on-hand inventory
    if not dc_inv_df.empty and "on_hand_quantity" in dc_inv_df.columns:
        neg = int((_num(dc_inv_df, "on_hand_quantity") < 0).sum())
        _chk("no_negative_dc_inventory", neg == 0, neg,
             f"{neg} rows with on_hand_quantity < 0" if neg else "")
    else:
        _chk("no_negative_dc_inventory", True)

    # 3. Sales quantity ≥ 0 everywhere
    if not sales_hist_df.empty and "sales_quantity" in sales_hist_df.columns:
        neg = int((_num(sales_hist_df, "sales_quantity") < 0).sum())
        _chk("sales_quantity_non_negative", neg == 0, neg,
             f"{neg} rows with sales_quantity < 0" if neg else "")
    else:
        _chk("sales_quantity_non_negative", True)

    # 4. Every supplier order line references a known header
    if (not sup_od_df.empty and not sup_orders_df.empty
            and "purchase_order_number" in sup_od_df.columns
            and "purchase_order_number" in sup_orders_df.columns):
        orphans = int((~sup_od_df["purchase_order_number"]
                       .isin(sup_orders_df["purchase_order_number"])).sum())
        _chk("supplier_lines_have_header", orphans == 0, orphans,
             f"{orphans} orphan supplier order lines" if orphans else "")
    else:
        _chk("supplier_lines_have_header", True)

    # 5. Every store order line references a known header
    if (not store_od_df.empty and not str_orders_df.empty
            and "store_order_number" in store_od_df.columns
            and "store_order_number" in str_orders_df.columns):
        orphans = int((~store_od_df["store_order_number"]
                       .isin(str_orders_df["store_order_number"])).sum())
        _chk("store_lines_have_header", orphans == 0, orphans,
             f"{orphans} orphan store order lines" if orphans else "")
    else:
        _chk("store_lines_have_header", True)

    # 6. Store fill rate ≥ 50 %
    if (not sales_hist_df.empty and not demand_df.empty
            and "sales_quantity" in sales_hist_df.columns
            and "demand_qty" in demand_df.columns):
        ts   = float(_num(sales_hist_df, "sales_quantity").sum())
        td   = float(_num(demand_df,     "demand_qty").sum())
        rate = ts / td if td > 0 else 1.0
        _chk("store_fill_rate_above_floor", rate >= 0.50,
             0 if rate >= 0.50 else 1,
             f"fill_rate={rate:.1%} (floor=50%)")
    else:
        _chk("store_fill_rate_above_floor", True)

    # 7. DC stockout rate < 40 %
    if not dc_inv_df.empty and "inventory_status" in dc_inv_df.columns:
        total  = len(dc_inv_df)
        zeroes = int((dc_inv_df["inventory_status"] == "ZERO").sum())
        rate   = zeroes / total if total > 0 else 0.0
        _chk("dc_stockout_rate_below_ceiling", rate < 0.40,
             0 if rate < 0.40 else 1,
             f"stockout_rate={rate:.1%} (ceiling=40%)")
    else:
        _chk("dc_stockout_rate_below_ceiling", True)

    return results


def _build_data_quality_report(
    store_inv_df: pd.DataFrame,
    dc_inv_df: pd.DataFrame,
    sales_hist_df: pd.DataFrame,
    demand_df: pd.DataFrame,
    sup_orders_df: pd.DataFrame,
    sup_od_df: pd.DataFrame,
    str_orders_df: pd.DataFrame,
    store_od_df: pd.DataFrame,
    sim_duration_seconds: float | None = None,
) -> dict:
    checks = _run_quality_checks(
        store_inv_df, dc_inv_df, sales_hist_df, demand_df,
        sup_orders_df, sup_od_df, str_orders_df, store_od_df,
    )
    validation_passed = all(c["passed"] for c in checks)

    def _n(df, col):
        return float(pd.to_numeric(df[col], errors="coerce").fillna(0).sum()) \
            if not df.empty and col in df.columns else 0.0

    total_demand = _n(demand_df, "demand_qty")
    total_sales  = _n(sales_hist_df, "sales_quantity")
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


def _build_run_manifest(
    sim_id: str,
    config_block: dict,
    export_dfs: dict[str, pd.DataFrame],
    validation_passed: bool,
) -> dict:
    # Derive entity counts from the full (unfiltered) export DataFrames
    _site_df = export_dfs.get("SiteInformation.csv", pd.DataFrame())
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

    feeds = [
        {"filename": k, "rows": len(v), "path": k}
        for k, v in export_dfs.items()
    ]

    return {
        "run_id":            sim_id,
        "generated_at":      datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "spec_version":      _SPEC_VERSION,
        "config":            spec_config,
        "feeds":             feeds,
        "validation_passed": validation_passed,
    }


st.set_page_config(page_title="Metrai Simulation", layout="wide")

# ---------------------------------------------------------------------------
# Session state initialisation
# ---------------------------------------------------------------------------
for _key, _val in [
    ("logged_in",   False),
    ("user_id",     None),
    ("account_id",  None),
    ("full_name",   None),
    ("entities",    None),
    ("mappings",    None),
]:
    if _key not in st.session_state:
        st.session_state[_key] = _val


# ---------------------------------------------------------------------------
# Login screen (blocks the rest of the app until logged in)
# ---------------------------------------------------------------------------
if not st.session_state.logged_in:
    st.title("Metrai — Login")
    with st.form("login_form"):
        username = st.text_input("Username")
        password = st.text_input("Password", type="password")
        submitted = st.form_submit_button("Login")

    st.caption("Hint: username = `demo`, password = `demo123`")

    if submitted:
        try:
            resp = httpx.post(
                f"{BACKEND_URL}/login",
                json={"username": username, "password": password},
                timeout=10.0,
            )
            if resp.status_code == 200:
                data = resp.json()
                st.session_state.logged_in  = True
                st.session_state.user_id    = data["user_id"]
                st.session_state.account_id = data["account_id"]
                st.session_state.full_name  = data["full_name"]
                st.rerun()
            else:
                st.error("Invalid username or password.")
        except httpx.ConnectError:
            st.error(f"Cannot reach backend at {BACKEND_URL}.")
    st.stop()


# ---------------------------------------------------------------------------
# Top bar (logged-in state)
# ---------------------------------------------------------------------------
st.title("Metrai Simulation Dashboard")
st.caption(f"Logged in as **{st.session_state.full_name}**")

if st.button("Logout", key="logout_btn"):
    for k in ["logged_in", "user_id", "account_id", "full_name", "entities", "mappings"]:
        st.session_state[k] = None if k not in ("logged_in",) else False
    st.rerun()

account_id = st.session_state.account_id

# ---------------------------------------------------------------------------
# Helper: fetch entities + mappings from backend (cached in session state)
# ---------------------------------------------------------------------------

def _fetch_entities():
    try:
        r = httpx.get(f"{BACKEND_URL}/entities", params={"account_id": account_id}, timeout=15.0)
        r.raise_for_status()
        st.session_state.entities = r.json()
    except httpx.HTTPStatusError as e:
        show_error("Could not load entity catalogue", e, e.response)
    except Exception as e:
        show_error("Could not load entity catalogue", e)


def _fetch_mappings():
    try:
        r = httpx.get(f"{BACKEND_URL}/mappings", params={"account_id": account_id}, timeout=15.0)
        r.raise_for_status()
        st.session_state.mappings = r.json()
    except httpx.HTTPStatusError as e:
        show_error("Could not load mappings", e, e.response)
    except Exception as e:
        show_error("Could not load mappings", e)


if st.session_state.entities is None:
    _fetch_entities()
if st.session_state.mappings is None:
    _fetch_mappings()

entities = st.session_state.entities or {}
mappings = st.session_state.mappings or {}

# ---------------------------------------------------------------------------
# Tabs
# ---------------------------------------------------------------------------
tab_network, tab_simulate = st.tabs(["Network & Assortment", "Run Simulation"])


# ===========================================================================
# TAB 1 — Network & Assortment
# ===========================================================================
with tab_network:
    st.header("Network & Assortment Configuration")
    st.caption("Define which stores/DCs carry which items, and how nodes are connected. Click **Save Network Config** when done.")

    col_refresh, _ = st.columns([1, 5])
    if col_refresh.button("Refresh from DB"):
        _fetch_entities()
        _fetch_mappings()
        st.rerun()

    items     = entities.get("items", [])
    stores    = entities.get("stores", [])
    dcs       = entities.get("dcs", [])
    suppliers = entities.get("suppliers", [])

    if not items:
        st.info("No entities loaded. Make sure the backend is running and PostgreSQL is seeded.")
    else:
        item_opts     = {f"{i['item_code']}": i["item_id"] for i in items}
        store_opts    = {f"{s['store_code']} — {s['store_name']}": s["store_id"] for s in stores}
        dc_opts       = {f"{d['dc_code']} — {d['dc_name']}": d["dc_id"] for d in dcs}
        supplier_opts = {f"{s['supplier_code']} — {s['supplier_name']}": s["supplier_id"] for s in suppliers}

        item_ids_by_label     = item_opts
        item_label_by_id      = {v: k for k, v in item_opts.items()}
        store_label_by_id     = {v: k for k, v in store_opts.items()}
        dc_label_by_id        = {v: k for k, v in dc_opts.items()}
        supplier_label_by_id  = {v: k for k, v in supplier_opts.items()}

        # Current mapping sets (for defaults)
        cur_store_items    = {(r["store_id"], r["item_id"]) for r in mappings.get("store_items", [])}
        cur_dc_items       = {(r["dc_id"],    r["item_id"]) for r in mappings.get("dc_items", [])}
        cur_sup_items      = {(r["supplier_id"], r["item_id"]) for r in mappings.get("supplier_items", [])}
        cur_store_dc       = {r["from_store_id"]: r["to_dc_id"] for r in mappings.get("store_mappings", [])}
        cur_dc_sup         = {}
        for r in mappings.get("dc_mappings", []):
            cur_dc_sup.setdefault(r["from_dc_id"], []).append(r["to_node_id"])

        new_store_items    = []
        new_dc_items       = []
        new_supplier_items = []
        new_store_mappings = []
        new_dc_mappings    = []

        # ── 1. Store → DC ────────────────────────────────────────────────────
        st.subheader("1. Store → DC Assignments")
        dc_label_options = list(dc_opts.keys())
        dc_id_options    = list(dc_opts.values())

        for store_label, store_id in store_opts.items():
            cur_dc_id  = cur_store_dc.get(store_id)
            cur_dc_idx = dc_id_options.index(cur_dc_id) if cur_dc_id in dc_id_options else 0
            chosen_dc_label = st.selectbox(
                f"Serving DC for **{store_label}**",
                dc_label_options,
                index=cur_dc_idx,
                key=f"store_dc_{store_id}",
            )
            chosen_dc_id = dc_opts[chosen_dc_label]
            new_store_mappings.append({
                "from_store_id": store_id,
                "to_dc_id":      chosen_dc_id,
                "mapping_type":  "STORE_DC",
            })

        # ── 2. DC → Supplier Links ────────────────────────────────────────────
        st.subheader("2. DC → Supplier Links")
        supplier_label_list = list(supplier_opts.keys())
        supplier_id_list    = list(supplier_opts.values())

        for dc_label, dc_id in dc_opts.items():
            existing_sup_ids  = cur_dc_sup.get(dc_id, [])
            existing_sup_lbls = [supplier_label_by_id[s] for s in existing_sup_ids if s in supplier_label_by_id]
            chosen_sups = st.multiselect(
                f"Suppliers for **{dc_label}**",
                supplier_label_list,
                default=existing_sup_lbls,
                key=f"dc_sup_{dc_id}",
            )
            for sup_label in chosen_sups:
                new_dc_mappings.append({
                    "from_dc_id":   dc_id,
                    "to_node_id":   supplier_opts[sup_label],
                    "mapping_type": "DC_SUPPLIER",
                })

        # ── 3. Store Assortment ───────────────────────────────────────────────
        st.subheader("3. Store Assortment (items carried per store)")
        all_item_labels = list(item_opts.keys())

        for store_label, store_id in store_opts.items():
            existing_item_ids  = [iid for (sid, iid) in cur_store_items if sid == store_id]
            existing_item_lbls = [item_label_by_id[i] for i in existing_item_ids if i in item_label_by_id]
            chosen_items = st.multiselect(
                f"Items for **{store_label}**",
                all_item_labels,
                default=existing_item_lbls,
                key=f"store_items_{store_id}",
            )
            for ilabel in chosen_items:
                new_store_items.append({"store_id": store_id, "item_id": item_opts[ilabel]})

        # ── 4. DC Assortment ─────────────────────────────────────────────────
        st.subheader("4. DC Assortment (items stocked per DC)")

        for dc_label, dc_id in dc_opts.items():
            existing_item_ids  = [iid for (did, iid) in cur_dc_items if did == dc_id]
            existing_item_lbls = [item_label_by_id[i] for i in existing_item_ids if i in item_label_by_id]
            chosen_items = st.multiselect(
                f"Items for **{dc_label}**",
                all_item_labels,
                default=existing_item_lbls,
                key=f"dc_items_{dc_id}",
            )
            for ilabel in chosen_items:
                new_dc_items.append({"dc_id": dc_id, "item_id": item_opts[ilabel]})

        # ── 5. Supplier Assortment ────────────────────────────────────────────
        st.subheader("5. Supplier Assortment (items each supplier can supply)")

        for sup_label, sup_id in supplier_opts.items():
            existing_item_ids  = [iid for (sid, iid) in cur_sup_items if sid == sup_id]
            existing_item_lbls = [item_label_by_id[i] for i in existing_item_ids if i in item_label_by_id]
            chosen_items = st.multiselect(
                f"Items for **{sup_label}**",
                all_item_labels,
                default=existing_item_lbls,
                key=f"sup_items_{sup_id}",
            )
            for ilabel in chosen_items:
                new_supplier_items.append({"supplier_id": sup_id, "item_id": item_opts[ilabel]})

        # ── Save ─────────────────────────────────────────────────────────────
        if st.button("Save Network Config", type="primary", key="save_network"):
            payload = {
                "account_id":     account_id,
                "store_items":    new_store_items,
                "dc_items":       new_dc_items,
                "supplier_items": new_supplier_items,
                "store_mappings": new_store_mappings,
                "dc_mappings":    new_dc_mappings,
            }
            try:
                r = httpx.post(f"{BACKEND_URL}/mappings", json=payload, timeout=30.0)
                r.raise_for_status()
                st.success("Network configuration saved.")
                _fetch_mappings()
                st.rerun()
            except httpx.HTTPStatusError as e:
                show_error("Failed to save network config", e, e.response)
            except Exception as e:
                show_error("Failed to save network config", e)


# ===========================================================================
# TAB 2 — Run Simulation
# ===========================================================================
with tab_simulate:

    # ── Sidebar: configuration ────────────────────────────────────────────────
    st.sidebar.header("Simulation Config")

    sim_name = st.sidebar.text_input("Simulation Name", value="Default Run")
    sim_notes = st.sidebar.text_area("Notes", value="", height=60)

    start_date = st.sidebar.date_input("Start Date", value=date(2024, 1, 1))
    end_date   = st.sidebar.date_input("End Date",   value=date(2024, 12, 31))

    replenishment_policy = st.sidebar.selectbox(
        "Replenishment Policy",
        ["trailing_avg_28d", "promo_aware_7d", "baseline_only"],
    )

    _policy_day_match = _re.search(r"(\d+)d", replenishment_policy)
    _default_smoothing = int(_policy_day_match.group(1)) if _policy_day_match else 28
    smoothing_days = st.sidebar.number_input("Demand Smoothing Window (days)", min_value=7, max_value=90, value=_default_smoothing)

    st.sidebar.subheader("Store Config")
    store_reorder_weeks  = st.sidebar.slider("Min Inventory Trigger (weeks of cover)", 1, 4, 2, 1)
    store_target_weeks   = st.sidebar.slider("Store Target Stock (weeks)",             1, 8, 3, 1)
    store_start_days     = st.sidebar.number_input("Store Starting Stock (days)", min_value=1, max_value=60, value=14)
    store_order_dow      = st.sidebar.selectbox("Store Order Day", ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"], index=0)

    st.sidebar.subheader("DC Config")
    dc_reorder_weeks     = st.sidebar.slider("DC Reorder Point (weeks of cover)", 1, 6, 2, 1)
    dc_target_weeks      = st.sidebar.slider("DC Target Stock (weeks)",           2, 12, 5, 1)
    dc_start_days        = st.sidebar.number_input("DC Starting Stock (days)", min_value=1, max_value=90, value=30)
    dc_review_dow        = st.sidebar.selectbox("DC Review Day", ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"], index=0)

    st.sidebar.subheader("Supplier Config")
    sup_lead_min   = st.sidebar.number_input("Lead Time Min (days)", min_value=1, max_value=14, value=3)
    sup_lead_max   = st.sidebar.number_input("Lead Time Max (days)", min_value=1, max_value=30, value=7)
    sup_on_time    = st.sidebar.slider("Supplier On-Time Rate", 0.5, 1.0, 0.90, 0.05)
    sup_partial    = st.sidebar.slider("Supplier Partial Delivery Rate", 0.0, 0.5, 0.10, 0.05)

    st.sidebar.subheader("DC → Store Config")
    dc_lead_days = st.sidebar.number_input("DC → Store Lead Time (days)", min_value=1, max_value=14, value=2)
    dc_on_time   = st.sidebar.slider("DC On-Time Rate (global)", 0.5, 1.0, 0.95, 0.05)
    dc_partial   = st.sidebar.slider("DC Partial Delivery Rate (global)", 0.0, 0.3, 0.05, 0.05)

    # Per-DC overrides
    _dc_list = entities.get("dcs", [])
    if not _dc_list and "sim_results" in st.session_state:
        _prev = st.session_state["sim_results"].get("dc_inv_df", pd.DataFrame())
        if not _prev.empty and "dc_code" in _prev.columns:
            _dc_list = [{"dc_code": c} for c in sorted(_prev["dc_code"].unique())]

    dc_on_time_by_dc: dict = {}
    dc_partial_by_dc: dict = {}
    dc_lead_days_by_dc: dict = {}

    if _dc_list:
        with st.sidebar.expander(f"Per-DC Delivery Rates & Lead Time ({len(_dc_list)} DCs)"):
            st.caption("Leave at global default or adjust per DC.")
            for _dc in _dc_list:
                _code = _dc.get("dc_code", "") or _dc.get("dc_id", "")
                if not _code:
                    continue
                st.markdown(f"**{_code}**")
                _ot = st.slider(f"On-time — {_code}", 0.5, 1.0, dc_on_time, 0.05,
                                key=f"dc_ot_{_code}")
                _pt = st.slider(f"Partial — {_code}", 0.0, 0.3, dc_partial, 0.05,
                                key=f"dc_pt_{_code}")
                _ld = st.number_input(f"Lead time (days) — {_code}", min_value=1, max_value=14,
                                      value=int(dc_lead_days), key=f"dc_ld_{_code}")
                if _ot != dc_on_time:
                    dc_on_time_by_dc[_code] = _ot
                if _pt != dc_partial:
                    dc_partial_by_dc[_code] = _pt
                if int(_ld) != int(dc_lead_days):
                    dc_lead_days_by_dc[_code] = int(_ld)

    seed = st.sidebar.number_input("Random Seed", min_value=0, value=42)

    run_btn = st.sidebar.button("▶ Run Simulation", type="primary")

    # ── Run history (sidebar) ─────────────────────────────────────────────────
    st.sidebar.divider()
    st.sidebar.subheader("Run History")
    if st.sidebar.button("Refresh History"):
        pass  # will re-fetch below

    try:
        history_resp = httpx.get(
            f"{BACKEND_URL}/runs",
            params={"account_id": account_id},
            timeout=10.0,
        )
        history_resp.raise_for_status()
        runs = history_resp.json()
    except Exception as e:
        runs = []
        st.sidebar.warning(f"Could not load history: {e}")

    if runs:
        for run in runs[:10]:
            status = run.get("simulation_status", "?")
            icon   = "✅" if status == "COMPLETED" else ("❌" if status == "FAILED" else "⏳")
            st.sidebar.caption(
                f"{icon} **{run.get('simulation_name', '—')}**  \n"
                f"  {run.get('created_at', '')[:16]}  \n"
                f"  {run.get('start_date', '')} → {run.get('end_date', '')}"
            )
    else:
        st.sidebar.caption("No runs yet.")

    # ── Summary placeholder metrics ────────────────────────────────────────────
    col1, col2, col3, col4 = st.columns(4)

    # ── Run button handler ─────────────────────────────────────────────────────
    if run_btn:
        if start_date >= end_date:
            st.error("Start date must be before end date.")
            st.stop()

        config = {
            "account_id":          account_id,
            "created_by":          st.session_state.user_id,
            "simulation_name":     sim_name,
            "notes":               sim_notes,
            "start_date":          start_date.isoformat(),
            "end_date":            end_date.isoformat(),
            "replenishment_policy": replenishment_policy,
            "smoothing_days":      int(smoothing_days),
            "store_reorder_weeks": store_reorder_weeks,
            "store_target_weeks":  store_target_weeks,
            "store_start_days":    int(store_start_days),
            "store_order_dow":     store_order_dow,
            "dc_reorder_weeks":    dc_reorder_weeks,
            "dc_target_weeks":     dc_target_weeks,
            "dc_start_days":       int(dc_start_days),
            "dc_review_dow":       dc_review_dow,
            "sup_lead_min":        int(sup_lead_min),
            "sup_lead_max":        int(sup_lead_max),
            "sup_on_time":         sup_on_time,
            "sup_partial":         sup_partial,
            "dc_on_time":          dc_on_time,
            "dc_partial":          dc_partial,
            "dc_lead_days":        int(dc_lead_days),
            "dc_on_time_by_dc":    dc_on_time_by_dc,
            "dc_partial_by_dc":    dc_partial_by_dc,
            "dc_lead_days_by_dc":  dc_lead_days_by_dc,
            "seed":                int(seed),
        }

        _t_start = time.time()
        with st.spinner("Running simulation…"):
            try:
                response = httpx.post(f"{BACKEND_URL}/run", json=config, timeout=300.0)
                response.raise_for_status()
            except httpx.ConnectError as e:
                show_error(f"Cannot reach backend at {BACKEND_URL}", e)
                st.stop()
            except httpx.TimeoutException as e:
                show_error("Simulation request timed out — try a shorter date range", e)
                st.stop()
            except httpx.HTTPStatusError as e:
                show_error("Simulation engine returned an error", e, e.response)
                st.stop()
            except Exception as e:
                show_error("Unexpected error", e)
                st.stop()

        sim_duration = round(time.time() - _t_start, 1)
        resp = response.json()
        sim_id = resp.get("simulation_id", "")
        st.success(f"Simulation complete. Run ID: `{sim_id}`")

        # ── Reconstruct DataFrames ─────────────────────────────────────────────
        # Daily data for Chart 1
        sales_daily_df = pd.DataFrame(resp.get("store_sales_daily", []))
        inv_daily_df   = pd.DataFrame(resp.get("store_inventory_daily", []))

        # Weekly data for Chart 2 + KPIs
        sales_hist_df  = pd.DataFrame(resp.get("sales_history", []))
        store_inv_df   = pd.DataFrame(resp.get("store_inventory", []))
        dc_inv_df      = pd.DataFrame(resp.get("dc_inventory", []))

        # Demand
        demand_df      = pd.DataFrame(resp.get("demand", []))

        # Orders & receipts
        sup_rec_df     = pd.DataFrame(resp.get("supplier_receipts", []))
        str_rec_df     = pd.DataFrame(resp.get("store_receipts", []))
        sup_orders_df  = pd.DataFrame(resp.get("supplier_orders", []))
        sup_od_df      = pd.DataFrame(resp.get("supplier_order_details", []))
        str_orders_df  = pd.DataFrame(resp.get("store_orders", []))
        store_od_df    = pd.DataFrame(resp.get("store_order_details", []))

        store_dc_map   = resp.get("store_dc_map", {})
        items_df       = pd.DataFrame(resp.get("items_meta", []))
        stores_df      = pd.DataFrame(resp.get("stores_meta", []))
        dcs_df         = pd.DataFrame(resp.get("dcs_meta", []))

        # ── Convert numeric columns (daily) ────────────────────────────────────
        for col in ["demand_qty", "sales_qty", "lost_sales_qty", "sales_amount"]:
            if col in sales_daily_df.columns:
                sales_daily_df[col] = pd.to_numeric(sales_daily_df[col], errors="coerce")

        for col in ["on_hand_qty", "on_order_qty", "woc"]:
            if col in inv_daily_df.columns:
                inv_daily_df[col] = pd.to_numeric(inv_daily_df[col], errors="coerce")

        # Convert numeric columns (weekly sales)
        for col in ["sales_quantity", "sales_amount"]:
            if col in sales_hist_df.columns:
                sales_hist_df[col] = pd.to_numeric(sales_hist_df[col], errors="coerce")

        for col in ["on_hand_quantity", "on_order_quantity", "woc"]:
            if col in store_inv_df.columns:
                store_inv_df[col] = pd.to_numeric(store_inv_df[col], errors="coerce")

        # Convert date columns
        if "date" in sales_daily_df.columns:
            sales_daily_df["date"] = pd.to_datetime(sales_daily_df["date"])
        if "date" in inv_daily_df.columns:
            inv_daily_df["date"] = pd.to_datetime(inv_daily_df["date"])
        if "demand_date" in demand_df.columns:
            demand_df["demand_date"] = pd.to_datetime(demand_df["demand_date"])

        # Convert demand qty
        if "demand_qty" in demand_df.columns:
            demand_df["demand_qty"] = pd.to_numeric(demand_df["demand_qty"], errors="coerce")

        # Normalise is_promo_demand
        if "is_promo_demand" in demand_df.columns:
            demand_df["is_promo_demand"] = demand_df["is_promo_demand"].map(
                lambda v: True if str(v) in ("1", "True", "true") else False
            )

        # Persist results so the UI survives selectbox / radio reruns
        st.session_state["sim_results"] = {
            "sim_id":           sim_id,
            "sim_start_date":   start_date,
            "sim_end_date":     end_date,
            "sim_duration":     sim_duration,
            "sim_config_block": config,
            "items_df":         items_df,
            "stores_df":        stores_df,
            "sales_daily_df":   sales_daily_df,
            "inv_daily_df":     inv_daily_df,
            "demand_df":        demand_df,
            "sales_hist_df":    sales_hist_df,
            "store_inv_df":     store_inv_df,
            "dc_inv_df":        dc_inv_df,
            "sup_rec_df":       sup_rec_df,
            "str_rec_df":       str_rec_df,
            "sup_orders_df":    sup_orders_df,
            "sup_od_df":        sup_od_df,
            "str_orders_df":    str_orders_df,
            "store_od_df":      store_od_df,
            "store_dc_map":     store_dc_map,
            "dcs_df":           dcs_df,
        }

    if "sim_results" in st.session_state:
        _r             = st.session_state["sim_results"]
        sim_id         = _r["sim_id"]
        start_date     = _r["sim_start_date"]
        end_date       = _r["sim_end_date"]
        items_df       = _r["items_df"]
        stores_df      = _r["stores_df"]
        sales_daily_df = _r["sales_daily_df"]
        inv_daily_df   = _r["inv_daily_df"]
        demand_df      = _r["demand_df"]
        sales_hist_df  = _r["sales_hist_df"]
        store_inv_df   = _r["store_inv_df"]
        dc_inv_df      = _r["dc_inv_df"]
        sup_rec_df     = _r["sup_rec_df"]
        str_rec_df     = _r["str_rec_df"]
        sup_orders_df  = _r["sup_orders_df"]
        sup_od_df      = _r["sup_od_df"]
        str_orders_df  = _r["str_orders_df"]
        store_od_df    = _r["store_od_df"]
        store_dc_map     = _r["store_dc_map"]
        dcs_df           = _r.get("dcs_df", pd.DataFrame())
        sim_duration     = _r.get("sim_duration")
        sim_config_block = _r.get("sim_config_block", {})

        # ── Summary metrics ────────────────────────────────────────────────────
        col1.metric("Items",     len(items_df))
        col2.metric("Stores",    len(stores_df))
        col3.metric("DCs",       len(set(store_dc_map.values())))
        col4.metric("Suppliers", 0)

        # ── Store / Item selectors ─────────────────────────────────────────────
        st.divider()
        stores_list  = sorted(sales_daily_df["store_id"].unique().tolist()) if not sales_daily_df.empty else []
        items_list   = sorted(sales_daily_df["item_id"].unique().tolist())  if not sales_daily_df.empty else []
        item_code_map = items_df.set_index("item_id")["item_code"].to_dict() if not items_df.empty else {}

        items_display = {f"{item_code_map.get(iid, iid)}": iid for iid in items_list}

        col_sel1, col_sel2 = st.columns(2)
        sel_store      = col_sel1.selectbox("Store", stores_list)
        sel_item_label = col_sel2.selectbox("Item", list(items_display.keys()))
        sel_item       = items_display[sel_item_label]

        # Filtered daily views
        s_inv_d   = inv_daily_df[
            (inv_daily_df["store_id"] == sel_store) & (inv_daily_df["item_id"] == sel_item)
        ].copy() if not inv_daily_df.empty else pd.DataFrame()

        s_sales_d = sales_daily_df[
            (sales_daily_df["store_id"] == sel_store) & (sales_daily_df["item_id"] == sel_item)
        ].copy() if not sales_daily_df.empty else pd.DataFrame()

        s_demand = demand_df[
            (demand_df["store_id"] == sel_store) & (demand_df["item_id"] == sel_item)
        ].copy() if not demand_df.empty else pd.DataFrame()

        # Filtered weekly views
        s_sales_w = sales_hist_df[
            (sales_hist_df["store_id"] == sel_store) & (sales_hist_df["item_id"] == sel_item)
        ].copy() if not sales_hist_df.empty else pd.DataFrame()

        s_inv_w = store_inv_df[
            (store_inv_df["store_id"] == sel_store) & (store_inv_df["item_id"] == sel_item)
        ].copy() if not store_inv_df.empty else pd.DataFrame()

        # ── Min Inventory Trigger info ─────────────────────────────────────────
        avg_daily_d = s_sales_d["demand_qty"].mean() if not s_sales_d.empty else 0
        trigger_units = int(round(store_reorder_weeks * avg_daily_d * 7))
        target_units  = int(round(store_target_weeks  * avg_daily_d * 7))
        st.caption(
            f"Min Inventory Trigger = **{store_reorder_weeks} weeks × {avg_daily_d:.1f} units/day × 7 = {trigger_units} units**"
        )
        st.caption(
            f"Store Target Stock = **{store_target_weeks} weeks × {avg_daily_d:.1f} units/day × 7 = {target_units} units**"
        )

        # ── KPI summary ────────────────────────────────────────────────────────
        st.subheader(f"KPI — {sel_store} / {sel_item_label}")
        total_demand  = s_sales_d["demand_qty"].sum()  if not s_sales_d.empty else 0
        total_sales   = s_sales_d["sales_qty"].sum()   if not s_sales_d.empty else 0
        total_lost    = s_sales_d["lost_sales_qty"].sum() if not s_sales_d.empty else 0
        fill_rate     = total_sales / total_demand * 100 if total_demand > 0 else 0
        stockout_days = (s_inv_d["inventory_status"] == "ZERO").sum() if not s_inv_d.empty else 0
        total_revenue = s_sales_d["sales_amount"].sum()  if not s_sales_d.empty else 0

        k1, k2, k3, k4, k5, k6 = st.columns(6)
        k1.metric("Total Demand",  f"{total_demand:,.0f}")
        k2.metric("Total Sales",   f"{total_sales:,.0f}")
        k3.metric("Lost Sales",    f"{total_lost:,.0f}")
        k4.metric("Fill Rate",     f"{fill_rate:.1f}%")
        k5.metric("Stockout Days", f"{stockout_days:,}")
        k6.metric("Revenue",       f"${total_revenue:,.0f}")

        # ── Promo spans (from demand_df, daily) ────────────────────────────────
        promo_date_ranges = []
        if not s_demand.empty and "is_promo_demand" in s_demand.columns:
            sd = s_demand.sort_values("demand_date").copy()
            in_promo = False
            span_start = None
            for _, row in sd.iterrows():
                if row["is_promo_demand"] and not in_promo:
                    span_start = row["demand_date"]
                    in_promo   = True
                elif not row["is_promo_demand"] and in_promo:
                    promo_date_ranges.append((span_start, row["demand_date"] - pd.Timedelta(days=1)))
                    in_promo = False
            if in_promo and span_start is not None:
                promo_date_ranges.append((span_start, sd["demand_date"].iloc[-1]))

        promo_weeks = set()
        if not s_demand.empty and "is_promo_demand" in s_demand.columns and "demand_week" in s_demand.columns:
            promo_weeks = set(s_demand[s_demand["is_promo_demand"] == True]["demand_week"].unique())

        def add_promo_shading_daily(fig):
            added = False
            for x0, x1 in promo_date_ranges:
                fig.add_vrect(
                    x0=x0, x1=x1 + pd.Timedelta(days=1),
                    fillcolor="rgba(255, 180, 0, 0.18)", layer="below", line_width=0,
                    name="Promo Period" if not added else None,
                    showlegend=not added, legendgroup="promo",
                )
                added = True

        def add_promo_shading_weekly(fig, weeks_list):
            added = False
            for i, w in enumerate(weeks_list):
                if w in promo_weeks:
                    fig.add_vrect(
                        x0=i - 0.5, x1=i + 0.5,
                        fillcolor="rgba(255, 180, 0, 0.22)", layer="below", line_width=0,
                        name="Promo Week" if not added else None,
                        showlegend=not added, legendgroup="promo_w",
                    )
                    added = True

        # ── Chart 1: Daily — Demand bar + Sales bar + On-hand line ──────────────
        st.divider()
        st.subheader("Inventory & Sales Charts")
        st.markdown("#### Daily: Demand vs Sales vs Inventory")
        fig_daily = go.Figure()

        if not s_sales_d.empty and not s_inv_d.empty:
            s_daily  = s_sales_d.merge(s_inv_d[["date", "on_hand_qty"]], on="date", how="left")
            day_lbl  = s_daily["date"].dt.strftime("%a, %b %d %Y")
            inv_lbl  = s_inv_d["date"].dt.strftime("%a, %b %d %Y")

            fig_daily.add_trace(go.Bar(
                x=s_daily["date"], y=s_daily["demand_qty"],
                name="Demand", marker_color="#BAD7F2", opacity=0.85,
                hovertemplate="<b>%{customdata}</b><br>Demand: %{y}<extra></extra>",
                customdata=day_lbl,
            ))
            fig_daily.add_trace(go.Bar(
                x=s_daily["date"], y=s_daily["sales_qty"],
                name="Sales (Fulfilled)", marker_color="#2E86AB", opacity=0.9,
                hovertemplate="<b>%{customdata}</b><br>Sales: %{y}<extra></extra>",
                customdata=day_lbl,
            ))
            lost_colors = ["#db5546" if oh == 0 else "#F1948A" for oh in s_daily["on_hand_qty"]]
            fig_daily.add_trace(go.Bar(
                x=s_daily["date"], y=s_daily["lost_sales_qty"],
                name="Lost Sales", marker_color=lost_colors, opacity=0.9,
                hovertemplate="<b>%{customdata}</b><br>Lost: %{y}<extra></extra>",
                customdata=day_lbl,
            ))
            fig_daily.add_trace(go.Scatter(
                x=s_inv_d["date"], y=s_inv_d["on_hand_qty"],
                name="On-Hand Inventory", mode="lines",
                line=dict(color="#E84855", width=2), yaxis="y2",
                hovertemplate="<b>%{customdata}</b><br>On-Hand: %{y}<extra></extra>",
                customdata=inv_lbl,
            ))
            fig_daily.add_trace(go.Scatter(
                x=s_inv_d["date"], y=s_inv_d["on_order_qty"],
                name="On-Order", mode="lines",
                line=dict(color="#F4A261", width=1.5, dash="dot"), yaxis="y2",
                hovertemplate="<b>%{customdata}</b><br>On-Order: %{y}<extra></extra>",
                customdata=inv_lbl,
            ))
            add_promo_shading_daily(fig_daily)

        fig_daily.update_layout(
            barmode="group",
            xaxis=dict(title="Date"),
            yaxis=dict(title="Units (Demand / Sales)", side="left"),
            yaxis2=dict(title="Units (Inventory)", overlaying="y", side="right", showgrid=False),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            height=420,
        )
        st.plotly_chart(fig_daily, use_container_width=True)

        # ── Chart 2: Weekly — aggregate sales + inventory ─────────────────────
        st.markdown("#### Weekly: Demand vs Sales vs Inventory")
        fig_weekly = go.Figure()

        if not s_sales_w.empty:
            weeks_list = sorted(s_sales_w["sales_week"].unique().tolist())

            # Merge weekly sales + inventory
            if not s_inv_w.empty:
                weekly_df = s_sales_w.merge(
                    s_inv_w[["sales_week" if "sales_week" in s_inv_w.columns else "inventory_week",
                              "on_hand_quantity"]].rename(
                        columns={"inventory_week": "sales_week"}
                    ),
                    on="sales_week", how="left",
                )
            else:
                weekly_df = s_sales_w.copy()
                weekly_df["on_hand_quantity"] = 0

            # Demand for weekly: sum from daily for chart consistency
            if not s_sales_d.empty and "week" in s_sales_d.columns:
                weekly_demand = (
                    s_sales_d.groupby("week", sort=True)["demand_qty"]
                    .sum()
                    .reset_index()
                    .rename(columns={"week": "sales_week", "demand_qty": "demand_quantity"})
                )
                weekly_df = weekly_df.merge(weekly_demand, on="sales_week", how="left")
            else:
                weekly_df["demand_quantity"] = weekly_df["sales_quantity"]

            fig_weekly.add_trace(go.Bar(
                x=weekly_df["sales_week"], y=weekly_df.get("demand_quantity", weekly_df["sales_quantity"]),
                name="Demand", marker_color="#BAD7F2", opacity=0.85,
            ))
            fig_weekly.add_trace(go.Bar(
                x=weekly_df["sales_week"], y=weekly_df["sales_quantity"],
                name="Sales", marker_color="#2E86AB", opacity=0.9,
            ))
            if "on_hand_quantity" in weekly_df.columns:
                fig_weekly.add_trace(go.Scatter(
                    x=weekly_df["sales_week"], y=weekly_df["on_hand_quantity"],
                    name="On-Hand (EOW)", mode="lines+markers",
                    line=dict(color="#F4A261", width=2), yaxis="y2",
                ))
            add_promo_shading_weekly(fig_weekly, weeks_list)

        fig_weekly.update_layout(
            barmode="group",
            xaxis=dict(title="Week", tickangle=-45),
            yaxis=dict(title="Units (Demand / Sales)", side="left"),
            yaxis2=dict(title="Units (Inventory EOW)", overlaying="y", side="right", showgrid=False),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            height=420,
        )
        st.plotly_chart(fig_weekly, use_container_width=True)

        # ── Chart 3: Inventory status heatmap ────────────────────────────────
        st.divider()
        st.subheader(f"Inventory Status — All Stores for {sel_item_label}")

        if not inv_daily_df.empty:
            heat_df = inv_daily_df[inv_daily_df["item_id"] == sel_item].copy()
            heat_df["date"] = pd.to_datetime(heat_df["date"])
            status_num_map = {"AVAILABLE": 2, "LOW": 1, "ZERO": 0}
            heat_df["status_num"] = heat_df["inventory_status"].map(status_num_map)
            pivot = heat_df.pivot_table(index="store_id", columns="date", values="status_num", aggfunc="first")

            y_labels = [f"► {s}" if s == sel_store else s for s in pivot.index.tolist()]
            fig_heat = go.Figure(go.Heatmap(
                z=pivot.values,
                x=pivot.columns.astype(str),
                y=y_labels,
                colorscale=[[0, "#E84855"], [0.5, "#F4A261"], [1, "#2E86AB"]],
                zmin=0, zmax=2,
                colorbar=dict(tickvals=[0, 1, 2], ticktext=["ZERO", "LOW", "AVAILABLE"]),
            ))
            fig_heat.update_layout(
                height=max(200, len(stores_list) * 35 + 80),
                xaxis_title="Date", yaxis_title="Store",
            )
            st.plotly_chart(fig_heat, use_container_width=True)

        # ── Raw data expanders ────────────────────────────────────────────────
        st.divider()
        st.subheader(f"Raw Output Tables — {sel_store} / {sel_item_label}")

        with st.expander("Demand Matrix"):
            filt = s_demand.reset_index(drop=True) if not s_demand.empty else pd.DataFrame()
            st.dataframe(filt)

        with st.expander("Daily Sales"):
            st.dataframe(s_sales_d.reset_index(drop=True))

        with st.expander("Daily Store Inventory"):
            st.dataframe(s_inv_d.reset_index(drop=True))

        with st.expander("Weekly Sales History"):
            st.dataframe(s_sales_w.reset_index(drop=True))

        with st.expander("Weekly Store Inventory"):
            st.dataframe(s_inv_w.reset_index(drop=True))

        def _has_cols(df, *cols):
            return not df.empty and all(c in df.columns for c in cols)

        if _has_cols(str_rec_df, "store_id", "item_id"):
            with st.expander("Store Receipts"):
                filt = str_rec_df[(str_rec_df["store_id"] == sel_store) & (str_rec_df["item_id"] == sel_item)]
                st.dataframe(filt.reset_index(drop=True))

        if _has_cols(store_od_df, "store_id", "item_id"):
            with st.expander("Store Order Details"):
                filt = store_od_df[(store_od_df["store_id"] == sel_store) & (store_od_df["item_id"] == sel_item)]
                st.dataframe(filt.reset_index(drop=True))

        if _has_cols(str_orders_df, "store_id"):
            with st.expander("Store Orders (header)"):
                st.dataframe(str_orders_df[str_orders_df["store_id"] == sel_store].reset_index(drop=True))

        if _has_cols(sup_rec_df, "item_id"):
            with st.expander("Supplier Receipts"):
                st.dataframe(sup_rec_df[sup_rec_df["item_id"] == sel_item].reset_index(drop=True))

        if _has_cols(sup_orders_df, "dc_id"):
            with st.expander("Supplier Orders (for DC serving this store)"):
                sel_dc = store_dc_map.get(sel_store)
                filt   = sup_orders_df[sup_orders_df["dc_id"] == sel_dc] if sel_dc else sup_orders_df
                st.dataframe(filt.reset_index(drop=True))

        if _has_cols(sup_od_df, "item_id"):
            with st.expander("Supplier Order Details"):
                st.dataframe(sup_od_df[sup_od_df["item_id"] == sel_item].reset_index(drop=True))

        if _has_cols(dc_inv_df, "dc_id", "item_id"):
            with st.expander("DC Inventory (Weekly)"):
                sel_dc = store_dc_map.get(sel_store)
                filt   = dc_inv_df[(dc_inv_df["dc_id"] == sel_dc) & (dc_inv_df["item_id"] == sel_item)] if sel_dc else dc_inv_df
                st.dataframe(filt.reset_index(drop=True))

        # ── Validation & Quality Report ───────────────────────────────────────
        st.divider()
        st.subheader("Validation")

        # Build the full (unfiltered) export set once — used for manifest + "all" ZIP
        _all_dfs = _prepare_export_dfs(
            filter_store=None, filter_item=None,
            items_df=items_df, stores_df=stores_df, dcs_df=dcs_df, dc_inv_df=dc_inv_df,
            sup_orders_df=sup_orders_df, sup_od_df=sup_od_df, sup_rec_df=sup_rec_df,
            str_orders_df=str_orders_df, store_od_df=store_od_df, str_rec_df=str_rec_df,
            sales_hist_df=sales_hist_df, store_inv_df=store_inv_df, demand_df=demand_df,
            store_dc_map=store_dc_map, start_date=start_date, end_date=end_date,
        )

        dq_report = _build_data_quality_report(
            store_inv_df, dc_inv_df, sales_hist_df, demand_df,
            sup_orders_df, sup_od_df, str_orders_df, store_od_df,
            sim_duration_seconds=sim_duration,
        )
        manifest = _build_run_manifest(
            sim_id=sim_id,
            config_block=sim_config_block,
            export_dfs=_all_dfs,
            validation_passed=dq_report["validation_passed"],
        )
        _extra_files = {
            "run_manifest.json":        json.dumps(manifest,  indent=2),
            "data_quality_report.json": json.dumps(dq_report, indent=2),
        }

        if dq_report["validation_passed"]:
            st.success("**All checks passed** — data quality validated.")
        else:
            st.error("**Validation failed** — one or more checks did not pass.")

        _check_rows = [
            {
                "Check":      c["name"],
                "Passed":     "✅" if c["passed"] else "❌",
                "Violations": c["violations"],
            }
            for c in dq_report["checks"]
        ]
        st.dataframe(pd.DataFrame(_check_rows), use_container_width=True, hide_index=True)

        with st.expander("run_manifest.json"):
            st.code(_extra_files["run_manifest.json"], language="json")
        with st.expander("data_quality_report.json"):
            st.code(_extra_files["data_quality_report.json"], language="json")

        # ── Output Data Feeds ─────────────────────────────────────────────────
        st.divider()
        st.subheader("Output Data Feeds")

        sel_store_code = stores_df.loc[stores_df["store_id"] == sel_store, "store_code"].iloc[0] \
            if not stores_df.loc[stores_df["store_id"] == sel_store, "store_code"].empty else sel_store
        feed_mode = st.radio(
            "View / download",
            [f"Filtered — {sel_store_code} / {sel_item_label}", "All Stores & Items"],
            horizontal=True,
            key="feed_mode",
        )
        filtered_mode = feed_mode.startswith("Filtered")
        fs = sel_store if filtered_mode else None
        fi = sel_item  if filtered_mode else None

        export_dfs = _prepare_export_dfs(
            filter_store=fs,
            filter_item=fi,
            items_df=items_df,
            stores_df=stores_df,
            dcs_df=dcs_df,
            dc_inv_df=dc_inv_df,
            sup_orders_df=sup_orders_df,
            sup_od_df=sup_od_df,
            sup_rec_df=sup_rec_df,
            str_orders_df=str_orders_df,
            store_od_df=store_od_df,
            str_rec_df=str_rec_df,
            sales_hist_df=sales_hist_df,
            store_inv_df=store_inv_df,
            demand_df=demand_df,
            store_dc_map=store_dc_map,
            start_date=start_date,
            end_date=end_date,
        )

        for fname, df in export_dfs.items():
            with st.expander(fname.replace(".csv", ""), expanded=False):
                st.dataframe(df, use_container_width=True)

        st.markdown("#### Download")
        dl_col1, dl_col2 = st.columns(2)
        with dl_col1:
            zip_filtered = _build_zip(
                _prepare_export_dfs(
                    filter_store=sel_store, filter_item=sel_item,
                    items_df=items_df, stores_df=stores_df, dcs_df=dcs_df, dc_inv_df=dc_inv_df,
                    sup_orders_df=sup_orders_df, sup_od_df=sup_od_df, sup_rec_df=sup_rec_df,
                    str_orders_df=str_orders_df, store_od_df=store_od_df, str_rec_df=str_rec_df,
                    sales_hist_df=sales_hist_df, store_inv_df=store_inv_df, demand_df=demand_df,
                    store_dc_map=store_dc_map, start_date=start_date, end_date=end_date,
                ),
                extra_files=_extra_files,
            )
            st.download_button(
                label=f"⬇ Download filtered ({sel_store_code} / {sel_item_label})",
                data=zip_filtered,
                file_name=f"metrai_export_{sel_store_code}_{sel_item_label}.zip",
                mime="application/zip",
                use_container_width=True,
            )
        with dl_col2:
            zip_all = _build_zip(_all_dfs, extra_files=_extra_files)
            st.download_button(
                label="⬇ Download all data",
                data=zip_all,
                file_name="metrai_export_all.zip",
                mime="application/zip",
                use_container_width=True,
            )

    else:
        col1.metric("Items",     "—")
        col2.metric("Stores",    "—")
        col3.metric("DCs",       "—")
        col4.metric("Suppliers", "—")
        st.info("Configure parameters in the sidebar and click **▶ Run Simulation** to start.")
