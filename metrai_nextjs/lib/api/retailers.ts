import { apiClient } from './client'
import type { RetailerAccount, CreateAccountRequest } from './types'

export const getRetailers = () =>
  apiClient.get<RetailerAccount[]>('/retailers').then(r => r.data)

export const createAccount = (data: CreateAccountRequest) =>
  apiClient.post<RetailerAccount>('/accounts', data).then(r => r.data)

export const switchAccount = (retailerAccountId: string) =>
  apiClient
    .post<{ access_token: string; refresh_token: string; token_type: string; retailer_account_id: string }>(
      '/switch-account',
      { retailer_account_id: retailerAccountId }
    )
    .then(r => r.data)
