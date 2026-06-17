import { engineClient } from './client'
import type { RunYamlResponse, RunConfig, SimulationRun, FullSimulationOutput, DeleteResponse, EndingInventoryResponse, DemandJobResponse, ExtendSimulationPayload, SimulationExtensionRecord, ExtensionPromoInput, SaveExtensionPromosResponse, GenerateExtensionDemandRequest } from './types'

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

// GET /simulation/{simulation_id}/ending-inventory — used to seed Extend Forecast runs
export const getEndingInventory = (simulationId: string) =>
  engineClient.get<EndingInventoryResponse>(`/simulation/${simulationId}/ending-inventory`).then(r => r.data)

// POST /demand/generate — async demand generation job
export const generateDemand = (
  retailerAccountId: string, startDate: string, endDate: string, seed: number
) =>
  engineClient.post<{ job_id: string; status: string }>('/demand/generate', {
    retailer_account_id: retailerAccountId, start_date: startDate, end_date: endDate, seed,
  }).then(r => r.data)

// GET /demand/status/{job_id}
export const getDemandStatus = (jobId: string) =>
  engineClient.get<DemandJobResponse>(`/demand/status/${jobId}`).then(r => r.data)

// GET /demand/weekly-totals — aggregated demand from ClickHouse cache for chart preview
export const getDemandWeeklyTotals = (
  retailerAccountId: string, startWeek: string, endWeek: string, seed: number
) =>
  engineClient.get<{ pos_week: string; demand_qty: number }[]>('/demand/weekly-totals', {
    params: { retailer_account_id: retailerAccountId, start_week: startWeek, end_week: endWeek, seed },
  }).then(r => r.data)

// POST /simulation/{simulation_id}/extend — true continuation, writes to same simulation_id
export const extendSimulation = (simulationId: string, payload: ExtendSimulationPayload) =>
  engineClient.post<RunYamlResponse>(`/simulation/${simulationId}/extend`, payload).then(r => r.data)

// GET /simulation/{simulation_id}/extensions — extension history
export const getSimulationExtensions = (simulationId: string) =>
  engineClient.get<SimulationExtensionRecord[]>(`/simulation/${simulationId}/extensions`).then(r => r.data)

// POST /simulation/{id}/extension-promos — persist user-scheduled promos for a session
export const saveExtensionPromos = (
  simulationId: string,
  sessionId: string,
  retailerAccountId: string,
  promos: ExtensionPromoInput[],
) =>
  engineClient.post<SaveExtensionPromosResponse>(`/simulation/${simulationId}/extension-promos`, {
    session_id: sessionId,
    retailer_account_id: retailerAccountId,
    promos,
  }).then(r => r.data)

// POST /demand/generate/extend — generate demand for extension period using stored promo schedules
export const generateExtensionDemand = (req: GenerateExtensionDemandRequest) =>
  engineClient.post<{ job_id: string; status: string }>('/demand/generate/extend', req).then(r => r.data)
