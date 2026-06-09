import { engineClient } from './client'
import type { RunYamlResponse, RunConfig, SimulationRun, FullSimulationOutput, DeleteResponse } from './types'

// POST /simulate — synchronous, returns completed result inline
export const runSimulation = (yamlContent: string) =>
  engineClient.post<RunYamlResponse>('/simulate', { yaml_content: yamlContent }).then(r => r.data)

// Compat shim — simulate is synchronous so there's nothing to poll
export const pollSimulationUntilDone = (result: RunYamlResponse) =>
  Promise.resolve(result)

// GET /run-config/{simulation_id}
export const getRunConfig = (simulationId: string) =>
  engineClient.get<RunConfig>(`/run-config/${simulationId}`).then(r => r.data)

// GET /runs?retailer_account_id=&user_id=
export const getRuns = (retailerAccountId: string, userId: string) =>
  engineClient.get<SimulationRun[]>('/runs', { params: { retailer_account_id: retailerAccountId, user_id: userId } }).then(r => r.data)

// GET /run-yaml-template
export const getRunYamlTemplate = () =>
  engineClient.get<{ yaml: string }>('/run-yaml-template').then(r => r.data)

// GET /simulation/{simulation_id} — full ClickHouse output (available after background write)
export const getSimulation = (simulationId: string) =>
  engineClient.get<FullSimulationOutput>(`/simulation/${simulationId}`).then(r => r.data)

// DELETE /simulation/{simulation_id}
export const deleteSimulation = (simulationId: string) =>
  engineClient.delete<DeleteResponse>(`/simulation/${simulationId}`).then(r => r.data)

// GET /simulation/{simulation_id}/export — returns ZIP stream
export const getSimulationExportUrl = (simulationId: string) =>
  `${engineClient.defaults.baseURL}/simulation/${simulationId}/export`
