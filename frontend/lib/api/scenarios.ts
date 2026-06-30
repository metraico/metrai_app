import { apiClient } from './client'
import type { ScenarioValidateRequest, ScenarioValidateResponse } from './types'

export const validateScenario = (data: ScenarioValidateRequest) =>
  apiClient.post<ScenarioValidateResponse>('/scenario/validate', data).then(r => r.data)
