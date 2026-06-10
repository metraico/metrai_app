import { engineClient } from './client'
import type { SimulatePreviewResponse } from './types'

export const getSimulatePreview = (
  retailerAccountId: string,
  startDate: string,
  endDate: string,
) =>
  engineClient
    .get<SimulatePreviewResponse>('/simulate/preview', {
      params: { retailer_account_id: retailerAccountId, start_date: startDate, end_date: endDate },
    })
    .then(r => r.data)

export const getPromoYamlTemplate = (
  retailerAccountId: string,
  startDate: string,
  endDate: string,
) =>
  engineClient
    .get<{ yaml: string }>('/promo-yaml-template', {
      params: { retailer_account_id: retailerAccountId, start_date: startDate, end_date: endDate },
    })
    .then(r => r.data)
