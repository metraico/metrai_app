import { apiClient } from './client'
import type { RunYamlResponse, RunConfig, SimulationRun } from './types'

export const runSimulation = (yamlContent: string) =>
  apiClient.post<RunYamlResponse>('/run/yaml', { yaml_content: yamlContent }).then(r => r.data)

export const getRunConfig = (simulationId: string) =>
  apiClient.get<RunConfig>(`/run-config/${simulationId}`).then(r => r.data)

export const getRuns = (retailerAccountId: string, userId: string) =>
  apiClient
    .get<SimulationRun[]>('/runs', {
      params: { retailer_account_id: retailerAccountId, user_id: userId },
    })
    .then(r => r.data)

export const getRunYamlTemplate = () =>
  apiClient.get<{ yaml: string }>('/run-yaml-template').then(r => r.data)

export const getSimulation = (simulationId: string) =>
  apiClient.get<Record<string, unknown>>(`/simulation/${simulationId}`).then(r => r.data)

export const deleteSimulation = (simulationId: string) =>
  apiClient.delete<{ deleted: string }>(`/simulation/${simulationId}`).then(r => r.data)

export const pollSimulationUntilDone = (
  simulationId: string,
  intervalMs = 3000,
  onUpdate?: (status: RunConfig) => void
): Promise<RunConfig> =>
  new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const status = await getRunConfig(simulationId)
        onUpdate?.(status)
        if (status.status === 'COMPLETED') return resolve(status)
        if (status.status === 'FAILED') return reject(new Error('Simulation failed'))
        setTimeout(tick, intervalMs)
      } catch (err) {
        reject(err)
      }
    }
    tick()
  })
