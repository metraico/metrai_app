import { engineClient } from './client'
import type {
  AnalyticsMeta,
  StoreSalesResponse,
  StoreInventoryRecord,
  SupplyChainSalesResponse,
  UpstreamInventoryResponse,
} from './types'

// ── Meta ──────────────────────────────────────────────────────────────────────
// GET /analytics/{simulation_id}/meta
export const getAnalyticsMeta = (simulationId: string) =>
  engineClient.get<AnalyticsMeta>(`/analytics/${simulationId}/meta`).then(r => r.data)

// ── Detail (filterable, row-level) ────────────────────────────────────────────

// GET /analytics/{simulation_id}/store-sales?item_id=&store_id=
export const getStoreSales = (
  simulationId: string,
  params?: { store_id?: string; item_id?: string; category?: string; subcategory?: string; brand?: string }
) =>
  engineClient
    .get<StoreSalesResponse>(`/analytics/${simulationId}/store-sales`, { params })
    .then(r => r.data)

// GET /analytics/{simulation_id}/store-inventory?item_id=&store_id=
export const getStoreInventory = (
  simulationId: string,
  params?: { store_id?: string; item_id?: string; category?: string; subcategory?: string; brand?: string }
) =>
  engineClient
    .get<{ store_inventory: StoreInventoryRecord[] }>(`/analytics/${simulationId}/store-inventory`, { params })
    .then(r => r.data)

// GET /analytics/{simulation_id}/supplier-sales?item_id=&supplier_dc_id=&retailer_dc_id=
export const getSupplierSales = (
  simulationId: string,
  params?: { item_id?: string; supplier_dc_id?: string; retailer_dc_id?: string; category?: string; subcategory?: string; brand?: string }
) =>
  engineClient
    .get<SupplyChainSalesResponse>(`/analytics/${simulationId}/supplier-sales`, { params })
    .then(r => r.data)

// GET /analytics/{simulation_id}/dc-inventory?item_id=&dc_id=&supplier_dc_id=
export const getDCInventory = (
  simulationId: string,
  params?: { item_id?: string; dc_id?: string; supplier_dc_id?: string; category?: string; subcategory?: string; brand?: string }
) =>
  engineClient
    .get<UpstreamInventoryResponse>(`/analytics/${simulationId}/dc-inventory`, { params })
    .then(r => r.data)

// ── Raw / paginated ───────────────────────────────────────────────────────────

// GET /analytics/{simulation_id}/store-sales/raw?limit=1000&offset=0
export const getStoreSalesRaw = (
  simulationId: string,
  params?: { item_id?: string; store_id?: string; limit?: number; offset?: number }
) =>
  engineClient
    .get(`/analytics/${simulationId}/store-sales/raw`, { params })
    .then(r => r.data)

// GET /analytics/{simulation_id}/supplier-sales/raw
export const getSupplierSalesRaw = (
  simulationId: string,
  params?: { item_id?: string; supplier_dc_id?: string; retailer_dc_id?: string; limit?: number; offset?: number }
) =>
  engineClient
    .get(`/analytics/${simulationId}/supplier-sales/raw`, { params })
    .then(r => r.data)

// GET /analytics/{simulation_id}/store-inventory/raw
export const getStoreInventoryRaw = (
  simulationId: string,
  params?: { item_id?: string; store_id?: string; limit?: number; offset?: number }
) =>
  engineClient
    .get(`/analytics/${simulationId}/store-inventory/raw`, { params })
    .then(r => r.data)

// GET /analytics/{simulation_id}/dc-inventory/raw
export const getDCInventoryRaw = (
  simulationId: string,
  params?: { item_id?: string; dc_id?: string; supplier_dc_id?: string; limit?: number; offset?: number }
) =>
  engineClient
    .get(`/analytics/${simulationId}/dc-inventory/raw`, { params })
    .then(r => r.data)

// ── Summary (pre-aggregated, optionally filterable) ───────────────────────────

export type StoreSalesFilters = {
  item_id?: string
  category?: string
  subcategory?: string
  brand?: string
  store_id?: string
}

export type SupplyChainFilters = {
  item_id?: string
  category?: string
  subcategory?: string
  brand?: string
  supplier_dc_id?: string
  retailer_dc_id?: string
}

// GET /analytics/{simulation_id}/summary/store-sales
export const getSummaryStoreSales = (simulationId: string, filters?: StoreSalesFilters, preferredRunType?: string) =>
  engineClient
    .get<StoreSalesResponse>(`/analytics/${simulationId}/summary/store-sales`, {
      params: { ...filters, ...(preferredRunType ? { preferred_run_type: preferredRunType } : {}) },
    })
    .then(r => r.data)

// GET /analytics/{simulation_id}/summary/store-inventory
export const getSummaryStoreInventory = (simulationId: string, filters?: StoreSalesFilters) =>
  engineClient
    .get<{ store_inventory: StoreInventoryRecord[] }>(`/analytics/${simulationId}/summary/store-inventory`, { params: filters })
    .then(r => r.data)

// GET /analytics/{simulation_id}/summary/supply-chain-sales
export const getSummarySupplyChainSales = (simulationId: string, filters?: SupplyChainFilters) =>
  engineClient
    .get<SupplyChainSalesResponse>(`/analytics/${simulationId}/summary/supply-chain-sales`, { params: filters })
    .then(r => r.data)

// GET /analytics/{simulation_id}/summary/upstream-inventory
export const getSummaryUpstreamInventory = (simulationId: string, filters?: SupplyChainFilters) =>
  engineClient
    .get<UpstreamInventoryResponse>(`/analytics/${simulationId}/summary/upstream-inventory`, { params: filters })
    .then(r => r.data)

// ── Hidden Lost Sales ─────────────────────────────────────────────────────────

export interface HiddenLostSalesDisruptionWindow {
  supplier_dc_code: string
  item_codes: string[] | 'all'
  window_start: string
  window_end: string
  mode: string
}

export interface HiddenLostSalesShipment {
  shipment_week: string
  supplier_dc_code: string
  retailer_dc_code: string
  item_code: string
  ordered_qty: number
  shipped_qty: number
  gap: number
  fill_rate: number
}

export interface HiddenLostSalesResponse {
  simulation_id: string
  retailer_account_id: string
  disruption_windows: HiddenLostSalesDisruptionWindow[]
  under_fulfilled_shipments: HiddenLostSalesShipment[]
  totals: { gap_shipments: number; gap_units: number }
}

// GET /analytics/{simulation_id}/hidden-lost-sales
export const getHiddenLostSales = (simulationId: string) =>
  engineClient
    .get<HiddenLostSalesResponse>(`/analytics/${simulationId}/hidden-lost-sales`)
    .then(r => r.data)

// ── Compat aliases (old names used in run page) ───────────────────────────────
export const getSupplyChainSales = getSupplierSales
export const getUpstreamInventory = getDCInventory
