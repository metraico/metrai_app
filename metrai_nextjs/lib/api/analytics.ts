import { apiClient } from './client'
import type {
  AnalyticsMeta,
  StoreSalesResponse,
  StoreInventoryRecord,
  SupplyChainSalesResponse,
  UpstreamInventoryResponse,
} from './types'

export const getAnalyticsMeta = (simulationId: string) =>
  apiClient.get<AnalyticsMeta>(`/analytics/${simulationId}/meta`).then(r => r.data)

export const getStoreSales = (
  simulationId: string,
  params?: { store_id?: string; item_id?: string }
) =>
  apiClient
    .get<StoreSalesResponse>(`/analytics/${simulationId}/store-sales`, { params })
    .then(r => r.data)

export const getStoreInventory = (
  simulationId: string,
  params?: { store_id?: string; item_id?: string }
) =>
  apiClient
    .get<{ store_inventory: StoreInventoryRecord[] }>(
      `/analytics/${simulationId}/store-inventory`,
      { params }
    )
    .then(r => r.data)

export const getSupplyChainSales = (
  simulationId: string,
  params?: { item_id?: string; supplier_dc_id?: string; retailer_dc_id?: string }
) =>
  apiClient
    .get<SupplyChainSalesResponse>(`/analytics/${simulationId}/supply-chain-sales`, { params })
    .then(r => r.data)

export const getUpstreamInventory = (
  simulationId: string,
  params?: { item_id?: string; dc_id?: string; supplier_dc_id?: string }
) =>
  apiClient
    .get<UpstreamInventoryResponse>(`/analytics/${simulationId}/upstream-inventory`, { params })
    .then(r => r.data)
