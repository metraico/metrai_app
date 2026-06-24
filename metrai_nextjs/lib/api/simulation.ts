import { engineClient } from './client'
import type { RunYamlResponse, RunConfig, SimulationRun, FullSimulationOutput, DeleteResponse, EndingInventoryResponse, DemandJobResponse, GenerateExtensionDemandRequest, RollingForecastSession, RunChunkRequest, RunChunkResponse, RecalculateDemandRequest } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// YAML body helpers — shared by rolling-forecast-modal and run-chunk-modal
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_WEEKS = 4

/**
 * Build the YAML textarea content for the run-chunk modal.
 * The comment header shows the chunk window. Each active promo becomes one
 * `performance` entry with schedule_id and pct: 0.
 */
export function buildRunChunkYaml(
  promos: { id: string; promo_group_name: string; start_date: string; end_date: string; demand_multiplier: number }[],
  chunkStart: string,
  chunkEnd: string,
  sessionId?: string,
): string {
  const sessionLine = sessionId ? `# Session: ${sessionId}\n` : ''
  const header = [
    `# Chunk window: ${chunkStart} → ${chunkEnd}  (SIM, ${CHUNK_WEEKS} weeks)`,
    sessionLine.trimEnd(),
    `# Edit pct for each promo: +50 = overperformed 50%, -30 = underperformed 30%, 0 = on plan`,
    '',
  ].filter(l => l !== undefined).join('\n')

  if (promos.length === 0) {
    return header + 'performance: []\n'
  }

  const entries = promos.map(p =>
    [
      `  - schedule_id: "${p.id}"`,
      `    pct: 0        # ${p.promo_group_name}  ${p.start_date} → ${p.end_date}`,
    ].join('\n')
  ).join('\n\n')

  return header + 'performance:\n' + entries + '\n'
}

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
  retailerAccountId: string,
  startWeek: string,
  endWeek: string,
  seed: number,
  filters?: {
    item_id?: string
    store_id?: string
    category?: string
    subcategory?: string
    brand?: string
  },
) =>
  engineClient.get<{ pos_week: string; demand_qty: number }[]>('/demand/weekly-totals', {
    params: {
      retailer_account_id: retailerAccountId,
      start_week: startWeek,
      end_week: endWeek,
      seed,
      ...filters,
    },
  }).then(r => r.data)

// POST /demand/generate/extend — generate demand for rolling session using stored promo schedules
export const generateExtensionDemand = (req: GenerateExtensionDemandRequest) =>
  engineClient.post<{ job_id: string; status: string }>('/demand/generate/extend', req).then(r => r.data)

// ─────────────────────────────────────────────────────────────────────────────
// Rolling Forecast API
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CHUNK_TYPE_SEQUENCE = ['SIM', 'FORECAST', 'SIM', 'FORECAST', 'SIM']

// POST /simulation/{id}/rolling-session  (JSON path — kept for backward compat)
export const createRollingSession = (
  simulationId: string,
  retailerAccountId: string,
  totalEndDate: string,
  chunkTypeSequence: string[] = DEFAULT_CHUNK_TYPE_SEQUENCE,
) =>
  engineClient.post<RollingForecastSession>(`/simulation/${simulationId}/rolling-session`, {
    retailer_account_id: retailerAccountId,
    total_end_date: totalEndDate,
    chunk_type_sequence: chunkTypeSequence,
  }).then(r => r.data)

// POST /simulation/{id}/rolling-session  (YAML path — used by the new YAML modal)
export const createRollingSessionYaml = async (
  simulationId: string,
  yamlBody: string,
): Promise<RollingForecastSession> => {
  const baseURL = (engineClient.defaults.baseURL as string) || 'http://localhost:8001'
  const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null
  const resp = await fetch(`${baseURL}/simulation/${simulationId}/rolling-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/yaml',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: yamlBody,
  })
  if (!resp.ok) {
    let msg = `Server error ${resp.status}`
    try { const b = await resp.json(); msg = b?.detail ?? b?.message ?? msg } catch {}
    throw new Error(msg)
  }
  return resp.json()
}

// POST /rolling-session/{id}/run-chunk  (YAML path — used by run-chunk-modal)
export const runRollingChunkYaml = async (
  sessionId: string,
  yamlBody: string,
): Promise<RunChunkResponse> => {
  const baseURL = (engineClient.defaults.baseURL as string) || 'http://localhost:8001'
  const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') : null
  const resp = await fetch(`${baseURL}/rolling-session/${sessionId}/run-chunk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/yaml',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: yamlBody,
  })
  if (!resp.ok) {
    let msg = `Server error ${resp.status}`
    try { const b = await resp.json(); msg = b?.detail ?? b?.message ?? msg } catch {}
    throw new Error(msg)
  }
  return resp.json()
}

// GET /simulation/{id}/rolling-session
export const getRollingSession = (simulationId: string) =>
  engineClient.get<RollingForecastSession>(`/simulation/${simulationId}/rolling-session`).then(r => r.data)

// POST /rolling-session/{id}/run-chunk
export const runRollingChunk = (sessionId: string, req: RunChunkRequest) =>
  engineClient.post<RunChunkResponse>(`/rolling-session/${sessionId}/run-chunk`, req).then(r => r.data)

// POST /rolling-session/{id}/recalculate-demand
export const recalculateRollingDemand = (sessionId: string, req: RecalculateDemandRequest) =>
  engineClient.post<{ job_id: string; status: string; promos_updated: number }>(
    `/rolling-session/${sessionId}/recalculate-demand`,
    req,
  ).then(r => r.data)

// DELETE /rolling-session/{id}
export const abandonRollingSession = (sessionId: string) =>
  engineClient.delete<{ abandoned: string }>(`/rolling-session/${sessionId}`).then(r => r.data)

// GET /rolling-session/{id}/promo-schedules — promo groups active in a date range
export const getSessionPromoSchedules = (
  sessionId: string,
  startDate?: string,
  endDate?: string,
) =>
  engineClient.get<{
    id: string
    promo_group_name: string
    start_date: string
    end_date: string
    demand_multiplier: number
    performance_pct: number | null
  }[]>(
    `/rolling-session/${sessionId}/promo-schedules`,
    { params: { start_date: startDate, end_date: endDate } },
  ).then(r => r.data)
