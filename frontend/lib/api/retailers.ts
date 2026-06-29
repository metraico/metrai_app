import { apiClient } from './client'
import type { RetailerAccount, CreateRetailerRequest, CreateRetailerResponse } from './types'

// GET /accounts → RetailerAccount[]
export const getRetailers = () =>
  apiClient.get<RetailerAccount[]>('/accounts').then(r => r.data)

// POST /accounts — app-backend auto-generates the account code from the name.
export const createRetailer = (data: CreateRetailerRequest) =>
  apiClient.post<CreateRetailerResponse>('/accounts', {
    account_name:  data.retailer_account_name,
    account_type:  'GROCERY',
    country_code:  data.country_code,
    currency_code: data.currency_code,
  }).then(r => r.data)

// POST /switch-account — mints a new JWT with retailer_account_id embedded
export const switchAccount = (retailerAccountId: string): Promise<{ access_token: string; refresh_token: string; retailer_account_id: string }> =>
  apiClient.post<{ access_token: string; refresh_token: string; retailer_account_id: string }>(
    '/switch-account',
    { retailer_account_id: retailerAccountId },
  ).then(r => r.data)
