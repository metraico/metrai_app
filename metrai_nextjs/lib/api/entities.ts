import { apiClient } from './client'
import type { EntitiesResponse, MappingsResponse, Promo } from './types'

export const getEntities = () =>
  apiClient.get<EntitiesResponse>('/entities').then(r => r.data)

export const getMappings = () =>
  apiClient.get<MappingsResponse>('/mappings').then(r => r.data)

export const postMappings = (data: MappingsResponse) =>
  apiClient.post<{ status: string }>('/mappings', data).then(r => r.data)

export const getPromos = () =>
  apiClient.get<Promo[]>('/promos').then(r => r.data)
