'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { useSimulationStore } from '@/lib/store/simulationStore'
import { validateScenario } from '@/lib/api/scenarios'
import { generateDemand, pollDemandUntilDone } from '@/lib/api/demand'
import { runSimulation } from '@/lib/api/simulation'
import { ChevronLeft, TrendingUp, AlertTriangle, CheckCircle, AlertCircle, Loader2, Truck } from 'lucide-react'
import yaml from 'js-yaml'

// ── Templates ─────────────────────────────────────────────────────────────────

const PF_TEMPLATE = `# =============================================================================
# SCENARIO: Promo Forecast Behavior
# =============================================================================
# Inject a gap between forecasted and actual shelf demand during a promo event.
# The trailing average learns from the anomaly, distorting replenishment in
# the weeks after the promo ends.
# =============================================================================

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

const HLS_TEMPLATE = `# =============================================================================
# SCENARIO: Hidden Lost Sales
# =============================================================================
# Block or delay DC deliveries to stores for a defined window.
# Suppressed sales corrupt the replenishment signal — causing under-ordering
# in the weeks after deliveries resume.
# =============================================================================

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

// ── Scenario tiles ────────────────────────────────────────────────────────────

const TILES = [
  {
    id: 'promo_forecast',
    title: 'Promo Forecast Behavior',
    description:
      'Inject a demand realization gap into promo events. The system forecasts normal promo demand; actual shelf demand is higher or lower. Observe post-promo replenishment distortion.',
    icon: TrendingUp,
    template: PF_TEMPLATE,
  },
  {
    id: 'hidden_lost_sales',
    title: 'Hidden Lost Sales',
    description:
      'Block or delay DC deliveries to stores for a defined window. Suppressed sales corrupt the trailing average — causing under-ordering in the weeks after deliveries resume.',
    icon: Truck,
    template: HLS_TEMPLATE,
  },
]

// ── Types ─────────────────────────────────────────────────────────────────────

type ValidationResult = {
  valid: boolean
  scenario_type: string
  warnings: string[]
  preview: Record<string, unknown>[] | null
}

type RunStage =
  | { type: 'idle' }
  | { type: 'generating_demand'; message: string }
  | { type: 'running_simulation'; message: string }
  | { type: 'error'; message: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseRunBlock(yamlText: string): { start_date: string; end_date: string; seed: number } | null {
  try {
    const parsed = yaml.load(yamlText) as { run?: Record<string, unknown> }
    const run = parsed?.run
    if (!run) return null
    return {
      start_date: String(run.start_date ?? ''),
      end_date: String(run.end_date ?? ''),
      seed: Number(run.seed ?? 42),
    }
  } catch {
    return null
  }
}

// ── Preview table ─────────────────────────────────────────────────────────────

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return null
  const cols = Object.keys(rows[0])
  return (
    <div className="overflow-x-auto rounded-xl border border-charcoal-blue-200">
      <table className="w-full text-sm">
        <thead className="bg-charcoal-blue-50">
          <tr>
            {cols.map(c => (
              <th key={c} className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wide text-charcoal-blue-500">
                {c.replace(/_/g, ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-charcoal-blue-50/50'}>
              {cols.map(c => (
                <td key={c} className="px-3 py-2 text-charcoal-blue-700">
                  {String(row[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Editor view ───────────────────────────────────────────────────────────────

function ScenarioEditor({
  tile,
  onBack,
}: {
  tile: (typeof TILES)[number]
  onBack: () => void
}) {
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
    setValidating(true)
    setValidation(null)
    setValidateError(null)
    try {
      const runParams = parseRunBlock(yamlText)
      const result = await validateScenario({
        scenario_yaml: yamlText,
        start_date: runParams?.start_date,
        end_date: runParams?.end_date,
      })
      setValidation(result as ValidationResult)
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        (err instanceof Error ? err.message : 'Validation failed.')
      setValidateError(msg)
    } finally {
      setValidating(false)
    }
  }

  const handleRun = async () => {
    const runParams = parseRunBlock(yamlText)
    if (!runParams?.start_date || !runParams?.end_date) {
      setStage({ type: 'error', message: 'Could not parse start_date / end_date from YAML.' })
      return
    }
    if (!accountId) {
      setStage({ type: 'error', message: 'No retailer account selected.' })
      return
    }

    try {
      setStage({ type: 'generating_demand', message: 'Generating demand data…' })
      const { job_id } = await generateDemand({
        retailer_account_id: accountId,
        start_date: runParams.start_date,
        end_date: runParams.end_date,
        seed: runParams.seed,
      })
      await pollDemandUntilDone(job_id, 3000, (s) => {
        setStage({ type: 'generating_demand', message: `Demand generation: ${s.status}…` })
      })

      setStage({ type: 'running_simulation', message: 'Starting simulation…' })
      // Inject auth context into YAML (engine reads from run: block directly)
      const parsedYaml = yaml.load(yamlText) as any
      if (parsedYaml?.run) {
        parsedYaml.run.retailer_account_id = accountId
        if (userId) parsedYaml.run.user_id = userId
      }
      const yamlWithAuth = yaml.dump(parsedYaml)
      const result = await runSimulation(yamlWithAuth)
      const { simulation_id, summary } = result
      const simName = parsedYaml?.run?.simulation_name ?? 'Simulation Results'
      if (summary) {
        setCache({ simulationId: simulation_id, simulationName: simName, summary })
      }
      router.push(`/retailers/${routeAccountId}/simulation/${simulation_id}/run`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An error occurred.'
      setStage({ type: 'error', message: msg })
    }
  }

  return (
    <div className="w-full px-8 py-10">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-8 flex items-start gap-4">
          <button
            onClick={onBack}
            className="mt-1 flex items-center gap-1 rounded-xl border border-charcoal-blue-200 bg-white px-3 py-2 text-sm font-semibold text-charcoal-blue-600 transition hover:bg-charcoal-blue-50"
          >
            <ChevronLeft size={16} />
            Back
          </button>
          <div>
            <h1 className="text-3xl font-black tracking-tight text-charcoal-blue-950">{tile.title}</h1>
            <p className="mt-1 text-sm font-medium text-charcoal-blue-400">{tile.description}</p>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          {/* YAML Editor */}
          <div className="rounded-2xl border border-charcoal-blue-200 bg-white shadow-sm">
            <div className="border-b border-charcoal-blue-100 px-6 py-4">
              <p className="text-xs font-bold uppercase tracking-wide text-charcoal-blue-400">Scenario YAML</p>
            </div>
            <div className="p-4">
              <textarea
                value={yamlText}
                onChange={e => {
                  setYamlText(e.target.value)
                  setValidation(null)
                  setValidateError(null)
                  if (stage.type !== 'idle') setStage({ type: 'idle' })
                }}
                className="w-full rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50 px-4 py-3 font-mono text-sm text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500"
                rows={30}
                spellCheck={false}
                disabled={isRunning}
              />
            </div>
          </div>

          {/* Right panel */}
          <div className="flex flex-col gap-4">
            {/* Validate */}
            <button
              onClick={handleValidate}
              disabled={validating || isRunning}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-majorelle-blue-500 bg-white px-6 py-3 font-bold text-majorelle-blue-500 transition hover:bg-majorelle-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {validating
                ? <><Loader2 size={18} className="animate-spin" /> Validating…</>
                : <><CheckCircle size={18} /> Validate Scenario</>}
            </button>

            {/* Validate error */}
            {validateError && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4">
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-rose-500" />
                <p className="text-sm font-medium text-rose-800">{validateError}</p>
              </div>
            )}

            {/* Validation result */}
            {validation && (
              <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-5 shadow-sm">
                <div className={`mb-3 flex items-center gap-2 font-bold ${validation.valid ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {validation.valid ? <CheckCircle size={18} /> : <AlertTriangle size={18} />}
                  {validation.valid ? 'Scenario is valid' : 'Validation warnings'}
                </div>

                {validation.warnings.length > 0 && (
                  <div className="mb-4 space-y-2">
                    {validation.warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                        <AlertTriangle size={13} className="mt-0.5 flex-shrink-0 text-amber-500" />
                        <p className="text-xs font-medium text-amber-800">{w}</p>
                      </div>
                    ))}
                  </div>
                )}

                {validation.preview && validation.preview.length > 0 && (
                  <div>
                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-charcoal-blue-400">Preview</p>
                    <PreviewTable rows={validation.preview} />
                  </div>
                )}
              </div>
            )}

            {/* Run stage feedback */}
            {stage.type === 'error' && (
              <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4">
                <AlertCircle size={16} className="mt-0.5 flex-shrink-0 text-rose-500" />
                <p className="text-sm font-medium text-rose-800">{stage.message}</p>
              </div>
            )}

            {isRunning && (
              <div className="flex items-center gap-3 rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50 p-4">
                <Loader2 size={16} className="flex-shrink-0 animate-spin text-majorelle-blue-500" />
                <p className="text-sm font-semibold text-majorelle-blue-800">{stage.message}</p>
              </div>
            )}

            {/* Run button */}
            <button
              onClick={handleRun}
              disabled={!validation?.valid || isRunning}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-6 py-3 font-bold text-white transition hover:bg-emerald-600 hover:shadow-lg hover:shadow-emerald-500/30 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300"
            >
              {isRunning
                ? <><Loader2 size={18} className="animate-spin" /> Running…</>
                : 'Run Simulation'}
            </button>

            {!validation && !validateError && (
              <p className="text-center text-xs text-charcoal-blue-400">
                Validate your scenario first to enable Run
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ScenarioPage() {
  const router = useRouter()
  const params = useParams()
  const retailerAccountId = params.retailerAccountId as string

  const [selectedTile, setSelectedTile] = useState<(typeof TILES)[number] | null>(null)

  if (selectedTile) {
    return <ScenarioEditor tile={selectedTile} onBack={() => setSelectedTile(null)} />
  }

  return (
    <div className="w-full px-8 py-10">
      <div className="mx-auto max-w-4xl">
        <div className="mb-10">
          <button
            onClick={() => router.push(`/retailers/${retailerAccountId}/runs`)}
            className="mb-6 flex items-center gap-2 text-sm font-semibold text-charcoal-blue-400 transition hover:text-charcoal-blue-700"
          >
            <ChevronLeft size={16} />
            Back to Runs
          </button>
          <h1 className="mb-2 text-4xl font-black tracking-tight text-charcoal-blue-950">
            Scenario Setup
          </h1>
          <p className="text-base font-medium text-charcoal-blue-400">
            Choose a scenario type to model specific supply chain disruptions or demand behaviours
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TILES.map(tile => {
            const Icon = tile.icon
            return (
              <button
                key={tile.id}
                onClick={() => setSelectedTile(tile)}
                className="rounded-2xl border-2 border-charcoal-blue-200 bg-white p-6 text-left shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-majorelle-blue-500 hover:shadow-xl hover:shadow-majorelle-blue-500/15"
              >
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-majorelle-blue-50">
                  <Icon size={24} className="text-majorelle-blue-500" />
                </div>
                <h3 className="mb-2 text-lg font-bold text-charcoal-blue-950">{tile.title}</h3>
                <p className="mb-4 text-sm leading-relaxed text-charcoal-blue-400">{tile.description}</p>
                <span className="text-sm font-semibold text-majorelle-blue-500">Open →</span>
              </button>
            )
          })}

          {/* Coming soon */}
          <div className="rounded-2xl border-2 border-dashed border-charcoal-blue-200 bg-charcoal-blue-50/50 p-6 opacity-60">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-charcoal-blue-100">
              <AlertTriangle size={24} className="text-charcoal-blue-400" />
            </div>
            <h3 className="mb-2 text-lg font-bold text-charcoal-blue-500">More Scenarios</h3>
            <p className="mb-4 text-sm leading-relaxed text-charcoal-blue-400">Additional scenario types in development.</p>
            <span className="text-sm font-semibold text-charcoal-blue-400">Coming soon</span>
          </div>
        </div>
      </div>
    </div>
  )
}
