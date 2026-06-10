import { engineClient } from './client'
import type { RetailerAccount, CreateRetailerRequest, CreateRetailerResponse } from './types'

// GET /retailers → { retailers: RetailerAccount[] }
export const getRetailers = () =>
  engineClient.get<{ retailers: RetailerAccount[] }>('/retailers').then(r => r.data.retailers)

// POST /retailers → CreateRetailerResponse
export const createRetailer = (data: CreateRetailerRequest) =>
  engineClient.post<CreateRetailerResponse>('/retailers', data).then(r => r.data)

// No switch-account on engine — kept for compat, always rejects (caller falls through to catch)
export const switchAccount = (_retailerAccountId: string): Promise<{ access_token: string; refresh_token: string; retailer_account_id: string }> =>
  Promise.reject(new Error('no-op'))
