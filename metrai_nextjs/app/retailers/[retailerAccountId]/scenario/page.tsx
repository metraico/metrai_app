'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { useSimulationStore } from '@/lib/store/simulationStore'
import { validateScenario } from '@/lib/api/scenarios'
import { generateDemand, pollDemandUntilDone } from '@/lib/api/demand'
import { runSimulation } from '@/lib/api/simulation'
import { ChevronLeft, TrendingUp, AlertTriangle, CheckCircle, AlertCircle, Loader2, Truck, BarChart2, Clock } from 'lucide-react'
import yaml from 'js-yaml'

const PF_TEMPLATE = `# SCENARIO: Promo Forecast Behavior
run:
  simulation_name: "2024 - Promo Over-Performance"
  start_date: "2024-01-01"
  end_date: "2024-12-31"
  seed: 42
  store_target_wos: 2
  retailer_dc_target_wos: 4
  supplier_dc_initial_wos: 4

scenario:
  type: promo_forecast
  promos:
    - name: "PEPSI_12PK_B2G2_SUPER_BOWL_2024"
      start_date: "2024-02-05"
      end_date: "2024-02-11"
      factor: 1.5
`

const HLS_TEMPLATE = `# SCENARIO: Hidden Lost Sales
run:
  simulation_name: "DC Stockout - Super Bowl Week 2024"
  start_date: "2024-01-01"
  end_date: "2024-12-31"
  seed: 42
  store_target_wos: 2
  retailer_dc_target_wos: 4
  supplier_dc_initial_wos: 4

scenario:
  type: hidden_lost_sales
  disruptions:
    - dc: DC_EAST
      items: all
      window_start: "2024-02-05"
      window_end: "2024-02-11"
      mode: stockout
    - dc: DC_WEST
      items: all
      window_start: "2024-04-01"
      window_end: "2024-04-17"
      mode: outage
      fulfillment_pct: 30
`

const CV_TEMPLATE = `# SCENARIO: Competitive Void
run:
  simulation_name: "2024 - Competitive Void Spike"
  start_date: "2024-01-01"
  end_date: "2024-12-31"
  seed: 42
  store_target_wos: 2
  retailer_dc_target_wos: 4
  supplier_dc_initial_wos: 4

scenario:
  type: competitive_void
  voids:
    - competitor: COMPETITOR_A
      stores: all
      window_start: "2024-03-01"
      window_end: "2024-03-28"
      demand_lift: 1.35
`

const LPC_TEMPLATE = `# SCENARIO: Late Promo Change
run:
  simulation_name: "2024 - Late Promo Cancellation"
  start_date: "2024-01-01"
  end_date: "2024-12-31"
  seed: 42
  store_target_wos: 2
  retailer_dc_target_wos: 4
  supplier_dc_initial_wos: 4

scenario:
  type: late_promo_change
  changes:
    - promo_name: "SPRING_PROMO_2024"
      original_start: "2024-04-01"
      cancelled_on: "2024-03-25"
      pre_built_inventory_wos: 3
`

const TILES = [
  { id: 'promo_forecast', title: 'Promo Forecast Behavior', description: 'Inject a demand realization gap into promo events. Observe post-promo replenishment distortion.', icon: TrendingUp, template: PF_TEMPLATE },
  { id: 'hidden_lost_sales', title: 'Hidden Lost Sales', description: 'Block or delay DC deliveries to stores. Suppressed sales corrupt the trailing average.', icon: Truck, template: HLS_TEMPLATE },
  { id: 'competitive_void', title: 'Competitive Void', description: 'Simulate a competitor going out-of-stock. Observe whether the demand spike is flagged as anomalous or chased.', icon: BarChart2, template: CV_TEMPLATE },
  { id: 'late_promo_change', title: 'Late Promo Change', description: 'Cancel a promo after pre-build inventory has shipped. Observe system response to stranded stock.', icon: Clock, template: LPC_TEMPLATE },
]

type ValidationResult = { valid: boolean; scenario_type: string; warnings: string[]; preview: Record<string, unknown>[] | null }
type RunStage = { type: 'idle' } | { type: 'generating_demand'; message: string } | { type: 'running_simulation'; message: string } | { type: 'error'; message: string }

function parseRunBlock(yamlText: string): { start_date: string; end_date: string; seed: number } | null {
  try {
    const parsed = yaml.load(yamlText) as { run?: Record<string, unknown> }
    const run = parsed?.run
    if (!run) return null
    return { start_date: String(run.start_date ?? ''), end_date: String(run.end_date ?? ''), seed: Number(run.seed ?? 42) }
  } catch { return null }
}

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return null
  const cols = Object.keys(rows[0])
  return (
    <div className="overflow-x-auto rounded-lg border border-charcoal-blue-200">
      <table className="w-full text-xs">
        <thead className="bg-charcoal-blue-50">
          <tr>{cols.map(c => <th key={c} className="px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-charcoal-blue-500">{c.replace(/_/g, ' ')}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-charcoal-blue-50/50'}>
              {cols.map(c => <td key={c} className="px-2 py-1.5 text-charcoal-blue-700">{String(row[c] ?? '')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ScenarioEditor({ tile, onBack }: { tile: (typeof TILES)[number]; onBack: () => void }) {
  const params = useParams()
  const router = useRouter()
  const { retailerAccountId: storeAccountId, userId } = useAuthStore()
  const { setCache } = useSimulationStore()
  const routeAccountId = params.retailerAccountId as string
  const accountId = routeAccountId || storeAccountId

  const [yamlText, setYamlText] = useState(tile.template)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [validateError, setValidateError] = useState<string | null>(null)
  const [stage, setStage] = useState<RunStage>({ type: 'idle' })
  const isRunning = stage.type === 'generating_demand' || stage.type === 'running_simulation'

  const handleValidate = async () => {
    setValidating(true); setValidation(null); setValidateError(null)
    try {
      const runParams = parseRunBlock(yamlText)
      const result = await validateScenario({ scenario_yaml: yamlText, start_date: runParams?.start_date, end_date: runParams?.end_date })
      setValidation(result as ValidationResult)
    } catch (err: unknown) {
      setValidateError((err as any)?.response?.data?.detail || (err instanceof Error ? err.message : 'Validation failed.'))
    } finally { setValidating(false) }
  }

  const handleRun = async () => {
    const runParams = parseRunBlock(yamlText)
    if (!runParams?.start_date || !runParams?.end_date) { setStage({ type: 'error', message: 'Could not parse start_date / end_date.' }); return }
    if (!accountId) { setStage({ type: 'error', message: 'No retailer account selected.' }); return }
    try {
      const parsedYaml = yaml.load(yamlText) as any
      if (parsedYaml?.run) { parsedYaml.run.retailer_account_id = accountId; if (userId) parsedYaml.run.user_id = userId }
      const yamlWithAuth = yaml.dump(parsedYaml)
      setStage({ type: 'running_simulation', message: 'Running simulation…' })
      const result = await runSimulation(yamlWithAuth)
      const { simulation_id, summary } = result
      const simName = parsedYaml?.run?.simulation_name ?? 'Simulation Results'
      if (summary) setCache({ simulationId: simulation_id, simulationName: simName, summary })
      router.push(`/retailers/${routeAccountId}/simulation/${simulation_id}`)
    } catch (err: unknown) {
      setStage({ type: 'error', message: err instanceof Error ? err.message : 'An error occurred.' })
    }
  }

  return (
    <div className="w-full px-6 py-6">
      <div className="w-full">
        <div className="mb-5 flex items-start gap-3">
          <button onClick={onBack} className="mt-0.5 flex items-center gap-1 rounded-lg border border-charcoal-blue-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-charcoal-blue-600 transition hover:bg-charcoal-blue-50">
            <ChevronLeft size={13} /> Back
          </button>
          <div>
            <h1 className="text-xl font-black tracking-tight text-charcoal-blue-950">{tile.title}</h1>
            <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">{tile.description}</p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="rounded-xl border border-charcoal-blue-200 bg-white shadow-sm">
            <div className="border-b border-charcoal-blue-100 px-4 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wide text-charcoal-blue-400">Scenario YAML</p>
            </div>
            <div className="p-3">
              <textarea
                value={yamlText}
                onChange={e => { setYamlText(e.target.value); setValidation(null); setValidateError(null); if (stage.type !== 'idle') setStage({ type: 'idle' }) }}
                className="w-full rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 px-3 py-2 font-mono text-xs text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500"
                rows={28} spellCheck={false} disabled={isRunning}
              />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <button onClick={handleValidate} disabled={validating || isRunning}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border-2 border-majorelle-blue-500 bg-white px-4 py-2 text-xs font-bold text-majorelle-blue-500 transition hover:bg-majorelle-blue-50 disabled:opacity-50">
              {validating ? <><Loader2 size={14} className="animate-spin" /> Validating…</> : <><CheckCircle size={14} /> Validate</>}
            </button>

            {validateError && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0 text-rose-500" />
                <p className="text-xs font-medium text-rose-800">{validateError}</p>
              </div>
            )}

            {validation && (
              <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
                <div className={`mb-2 flex items-center gap-1.5 text-sm font-bold ${validation.valid ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {validation.valid ? <CheckCircle size={15} /> : <AlertTriangle size={15} />}
                  {validation.valid ? 'Valid' : 'Warnings'}
                </div>
                {validation.warnings.length > 0 && (
                  <div className="mb-3 space-y-1.5">
                    {validation.warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5">
                        <AlertTriangle size={11} className="mt-0.5 flex-shrink-0 text-amber-500" />
                        <p className="text-[10px] font-medium text-amber-800">{w}</p>
                      </div>
                    ))}
                  </div>
                )}
                {validation.preview && validation.preview.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-charcoal-blue-400">Preview</p>
                    <PreviewTable rows={validation.preview} />
                  </div>
                )}
              </div>
            )}

            {stage.type === 'error' && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0 text-rose-500" />
                <p className="text-xs font-medium text-rose-800">{stage.message}</p>
              </div>
            )}

            {isRunning && (
              <div className="flex items-center gap-2 rounded-lg border border-majorelle-blue-200 bg-majorelle-blue-50 p-3">
                <Loader2 size={13} className="flex-shrink-0 animate-spin text-majorelle-blue-500" />
                <p className="text-xs font-semibold text-majorelle-blue-800">{stage.message}</p>
              </div>
            )}

            <button onClick={handleRun} disabled={!validation?.valid || isRunning}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300">
              {isRunning ? <><Loader2 size={14} className="animate-spin" /> Running…</> : 'Run Simulation'}
            </button>

            {!validation && !validateError && (
              <p className="text-center text-[10px] text-charcoal-blue-400">Validate first to enable Run</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ScenarioPage() {
  const router = useRouter()
  const params = useParams()
  const retailerAccountId = params.retailerAccountId as string
  const [selectedTile, setSelectedTile] = useState<(typeof TILES)[number] | null>(null)

  if (selectedTile) return <ScenarioEditor tile={selectedTile} onBack={() => setSelectedTile(null)} />

  return (
    <div className="w-full px-6 py-6">
      <div className="w-full">
        <div className="mb-5">
          <button onClick={() => router.push(`/retailers/${retailerAccountId}`)}
            className="mb-4 flex items-center gap-1 text-xs font-semibold text-charcoal-blue-400 transition hover:text-charcoal-blue-700">
            <ChevronLeft size={13} /> Back
          </button>
          <h1 className="text-2xl font-black tracking-tight text-charcoal-blue-950">Scenario Setup</h1>
          <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">
            Choose a scenario type to model specific supply chain disruptions or demand behaviours
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map(tile => {
            const Icon = tile.icon
            return (
              <button key={tile.id} onClick={() => setSelectedTile(tile)}
                className="rounded-xl border-2 border-charcoal-blue-200 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-majorelle-blue-500 hover:shadow-lg hover:shadow-majorelle-blue-500/15">
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-majorelle-blue-50">
                  <Icon size={18} className="text-majorelle-blue-500" />
                </div>
                <h3 className="mb-1 text-sm font-bold text-charcoal-blue-950">{tile.title}</h3>
                <p className="mb-3 text-xs leading-relaxed text-charcoal-blue-400">{tile.description}</p>
                <span className="text-xs font-semibold text-majorelle-blue-500">Open →</span>
              </button>
            )
          })}

        </div>
      </div>
    </div>
  )
}
