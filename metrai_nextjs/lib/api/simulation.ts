import { engineClient } from './client'
import type { RunYamlResponse, RunConfig, SimulationRun, FullSimulationOutput, DeleteResponse } from './types'

export const engineBaseUrl: string = (process.env.NEXT_PUBLIC_ENGINE_URL as string) || 'http://localhost:8001'

// POST /simulate — synchronous, returns completed result inline
export const runSimulation = (yamlContent: string, promoYamlContent = '', scenarioYamlContent = '', simulationId?: string) =>
  engineClient.post<RunYamlResponse>('/simulate', {
    yaml_content: yamlContent,
    promo_yaml_content: promoYamlContent,
    scenario_yaml_content: scenarioYamlContent,
    ...(simulationId ? { simulation_id: simulationId } : {}),
  }).then(r => r.data)

// Compat shim — simulate is synchronous so there's nothing to poll
export const pollSimulationUntilDone = (result: RunYamlResponse) =>
  Promise.resolve(result)

// GET /run-config/{simulation_id}
export const getRunConfig = (simulationId: string) =>
  engineClient.get<RunConfig>(`/run-config/${simulationId}`).then(r => r.data)

// GET /runs?retailer_account_id=&user_id=&scenario_type=
export const getRuns = (retailerAccountId: string, userId: string, scenarioType?: string) =>
  engineClient.get<SimulationRun[]>('/runs', {
    params: {
      retailer_account_id: retailerAccountId,
      user_id: userId,
      ...(scenarioType ? { scenario_type: scenarioType } : {}),
    }
  }).then(r => r.data)

// GET /run-yaml-template
export interface YamlTemplateParams {
  retailerAccountId?: string
  store_target_wos?: number
  store_initial_wos?: number
  retailer_dc_target_wos?: number
  retailer_dc_initial_wos?: number
  supplier_dc_initial_wos?: number
  retailer_dc_to_store_lead_weeks?: number
  supplier_dc_to_retailer_dc_lead_weeks?: number
  dc_otd_rate?: number
  dc_in_full_rate?: number
  supplier_otd_rate?: number
  supplier_in_full_rate?: number
}

export const getRunYamlTemplate = (params: YamlTemplateParams = {}) => {
  const { retailerAccountId, ...rest } = params
  return engineClient.get<{ yaml: string }>('/run-yaml-template', {
    params: { ...(retailerAccountId ? { retailer_account_id: retailerAccountId } : {}), ...rest },
  }).then(r => r.data)
}

// GET /simulation/{simulation_id} — full ClickHouse output (available after background write)
export const getSimulation = (simulationId: string) =>
  engineClient.get<FullSimulationOutput>(`/simulation/${simulationId}`).then(r => r.data)

// DELETE /simulation/{simulation_id}
export const deleteSimulation = (simulationId: string) =>
  engineClient.delete<DeleteResponse>(`/simulation/${simulationId}`).then(r => r.data)

// GET /analytics-status/{simulation_id}
export const getAnalyticsStatus = (simulationId: string) =>
  engineClient.get<{ ready: boolean }>(`/analytics-status/${simulationId}`).then(r => r.data)

// GET /simulation/{simulation_id}/export — returns ZIP stream
export const getSimulationExportUrl = (simulationId: string) =>
  `${engineClient.defaults.baseURL}/simulation/${simulationId}/export`
