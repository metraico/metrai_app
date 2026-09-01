'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { useSimulationStore } from '@/lib/store/simulationStore'
import { validateScenario } from '@/lib/api/scenarios'
import { runSimulation } from '@/lib/api/simulation'
import { ChevronLeft, TrendingUp, AlertTriangle, CheckCircle, AlertCircle, Loader2, Truck, BarChart2, Clock, BookOpen, Code2 } from 'lucide-react'
import yaml from 'js-yaml'

const PF_TEMPLATE = `# SCENARIO: Promo Forecast Behavior
# performance_adjustment: signed %. 50 = promo performs 50% better than forecast.
# -50 = promo performs 50% worse. 0 = no change.
# Replace promo_id with the UUID from your retailer's promo list.
run:
  simulation_name: "2024 - Promo Over-Performance"
  start_date: "2024-01-01"
  end_date: "2024-12-31"
  seed: 42
  store_target_wos: 2
  retailer_dc_target_wos: 4
  supplier_dc_initial_wos: 4

scenario:
  scenario_type: promo_forecast
  promos:
    - promo_id: "ENTER_PROMO_UUID_HERE"
      performance_adjustment: 50
`

const HLS_TEMPLATE = `# SCENARIO: Hidden Lost Sales
# dc: must be a SUPPLIER DC code (not a retailer DC). Use the code from your
#     supplier DC list (e.g. SDC_EAST, SDC_WEST). The disruption blocks
#     manufacturer receipts into that supplier DC during the window.
run:
  simulation_name: "DC Stockout - Super Bowl Week 2024"
  start_date: "2024-01-01"
  end_date: "2024-12-31"
  seed: 42
  store_target_wos: 2
  retailer_dc_target_wos: 4
  supplier_dc_initial_wos: 4

scenario:
  scenario_type: hidden_lost_sales
  disruptions:
    - dc: DC_EAST
      items: all
      window_start: "02/05/2024"
      window_end: "02/11/2024"
      mode: stockout
    - dc: DC_WEST
      items: all
      window_start: "04/01/2024"
      window_end: "04/17/2024"
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
  scenario_type: competitive_void
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
  scenario_type: late_promo_change
  changes:
    - promo_name: "SPRING_PROMO_2024"
      original_start: "2024-04-01"
      cancelled_on: "2024-03-25"
      pre_built_inventory_wos: 3
`

const TILES = [
  {
    id: 'promo_forecast',
    title: 'Promo Forecast Behavior',
    description: 'Inject a demand realization gap into promo events. Observe post-promo replenishment distortion.',
    icon: TrendingUp,
    template: PF_TEMPLATE,
    explainer: {
      what: 'A promotional event drives a demand spike, but actual sell-through falls short of the forecast. The system must distinguish between a genuine demand decline and an execution failure.',
      why: 'Replenishment systems that chase the inflated forecast will over-order in subsequent weeks, creating a bullwhip oscillation that takes weeks to dampen.',
      what_to_watch: [
        'Does the supplier DC over-ship in weeks following the promo?',
        'How many weeks does it take for retailer DC inventory to normalise?',
        'Does the fill rate drop as the RDC becomes overstocked and stops ordering?',
      ],
      key_params: ['factor — demand multiplier during the promo window (e.g. 1.5 = 50% uplift)', 'start_date / end_date — the promo window'],
    },
  },
  {
    id: 'hidden_lost_sales',
    title: 'Hidden Lost Sales',
    description: 'Block or delay DC deliveries to stores. Suppressed sales corrupt the trailing average.',
    icon: Truck,
    template: HLS_TEMPLATE,
    explainer: {
      what: 'A DC outage or partial fulfilment drops store inventory to zero. Stores record zero sales — not because demand disappeared, but because there was nothing to sell.',
      why: 'Replenishment systems that use trailing sales as a demand signal will interpret the zeros as genuine low demand, permanently underestimating the true rate. Lost sales become invisible.',
      what_to_watch: [
        'Does store on-hand hit zero during the disruption window?',
        'Does the system under-replenish after the disruption ends?',
        'How long before the trailing average recovers to true demand?',
      ],
      key_params: ['mode — "stockout" (zero inventory) or "outage" (partial fill %)', 'fulfillment_pct — fill rate during outage (e.g. 30 = 30%)', 'window_start / window_end — disruption window per DC'],
    },
  },
  {
    id: 'competitive_void',
    title: 'Competitive Void',
    description: 'Simulate a competitor going out-of-stock. Observe whether the demand spike is flagged as anomalous or chased.',
    icon: BarChart2,
    template: CV_TEMPLATE,
    explainer: {
      what: 'A competitor product goes out of stock, temporarily redirecting their demand to your SKUs. This creates a demand spike that is entirely external — it will reverse once the competitor restocks.',
      why: 'A system that treats this spike as a real demand shift will over-forecast and over-order, building inventory that becomes stranded when the competitor returns.',
      what_to_watch: [
        'Does the spike lift sales across all stores or only stores near the competitor?',
        'Does replenishment chase the spike, inflating orders?',
        'Does inventory overshoot and accumulate once the void ends?',
      ],
      key_params: ['demand_lift — multiplier applied during the void window (e.g. 1.35 = 35% uplift)', 'stores — "all" or a specific store list', 'window_start / window_end — the void window'],
    },
  },
  {
    id: 'late_promo_change',
    title: 'Late Promo Change',
    description: 'Cancel a promo after pre-build inventory has shipped. Observe system response to stranded stock.',
    icon: Clock,
    template: LPC_TEMPLATE,
    explainer: {
      what: 'A promotional event is cancelled after the supply chain has already built and shipped inventory in anticipation of the uplift. The system must act on the cancellation signal — not wait for sell-through proof.',
      why: 'Slow-reacting systems will continue to replenish as if the promo is live, compounding the overstock. The stranded pre-build takes weeks to clear at the baseline demand rate.',
      what_to_watch: [
        'Does the RDC stop ordering once the cancellation is known?',
        'How long does it take to burn through the pre-built inventory?',
        'Does the SDC fill rate drop as the RDC halts orders?',
      ],
      key_params: ['cancelled_on — the date the cancellation is communicated (before original_start)', 'pre_built_inventory_wos — weeks of supply already shipped to the DC before cancellation'],
    },
  },
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
      const parsed = yaml.load(yamlText) as any
      const runBlock = parsed?.run
      const scenarioBlock = parsed?.scenario
      if (!scenarioBlock) throw new Error('No scenario: block found in YAML.')
      const result = await validateScenario({
        scenario_yaml: yaml.dump(scenarioBlock),
        retailer_account_id: accountId ?? '',
        start_date: String(runBlock?.start_date ?? ''),
        end_date: String(runBlock?.end_date ?? ''),
      })
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

  const [activeTab, setActiveTab] = useState<'configure' | 'about'>('about')

  return (
    <div className="w-full px-6 py-6">
      <div className="w-full">
        <button onClick={onBack} className="mb-4 inline-flex items-center gap-1 rounded-full border border-charcoal-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-charcoal-blue-600 shadow-sm transition hover:border-charcoal-blue-400 hover:text-charcoal-blue-800">
          <ChevronLeft size={13} /> All Scenarios
        </button>
        <div className="mb-5">
          <h1 className="text-xl font-black tracking-tight text-charcoal-blue-950">{tile.title}</h1>
          <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">{tile.description}</p>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 border-b border-charcoal-blue-200">
          <button
            onClick={() => setActiveTab('about')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition-all ${activeTab === 'about' ? 'border-majorelle-blue-500 text-majorelle-blue-600' : 'border-transparent text-charcoal-blue-400 hover:text-charcoal-blue-700'}`}
          >
            <BookOpen size={13} /> About
          </button>
          <button
            onClick={() => setActiveTab('configure')}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition-all ${activeTab === 'configure' ? 'border-majorelle-blue-500 text-majorelle-blue-600' : 'border-transparent text-charcoal-blue-400 hover:text-charcoal-blue-700'}`}
          >
            <Code2 size={13} /> Configure & Run
          </button>
        </div>

        {/* About tab — bento grid */}
        {activeTab === 'about' && (
          <div className="grid gap-3 lg:grid-cols-2">
            {/* What this models — full width */}
            <div className="lg:col-span-2 rounded-xl border border-charcoal-blue-200 bg-white p-5 shadow-sm">
              <h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-charcoal-blue-400">What this scenario models</h3>
              <p className="text-sm leading-relaxed text-charcoal-blue-700">{tile.explainer.what}</p>
            </div>

            {/* Why it matters */}
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
              <h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-amber-600">Why it matters</h3>
              <p className="text-sm leading-relaxed text-amber-900">{tile.explainer.why}</p>
            </div>

            {/* What to watch */}
            <div className="rounded-xl border border-charcoal-blue-200 bg-white p-5 shadow-sm">
              <h3 className="mb-3 text-[10px] font-bold uppercase tracking-widest text-charcoal-blue-400">What to watch</h3>
              <ul className="space-y-2.5">
                {tile.explainer.what_to_watch.map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-xs text-charcoal-blue-700">
                    <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-majorelle-blue-100 text-[9px] font-bold text-majorelle-blue-600">{i + 1}</span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Key YAML params */}
            <div className="rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50 p-5 shadow-sm">
              <h3 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-charcoal-blue-400">Key YAML parameters</h3>
              <p className="mb-3 text-[10px] text-charcoal-blue-400">Edit these in <strong>Configure & Run</strong> to customise for your data.</p>
              <ul className="space-y-2">
                {tile.explainer.key_params.map((p, i) => {
                  const [key, desc] = p.split(' — ')
                  return (
                    <li key={i} className="rounded-lg border border-charcoal-blue-200 bg-white p-2.5">
                      <span className="mb-1 block rounded bg-majorelle-blue-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-majorelle-blue-600 w-fit">{key}</span>
                      <p className="text-[10px] text-charcoal-blue-500">{desc}</p>
                    </li>
                  )
                })}
              </ul>
            </div>

            {/* How to configure */}
            <div className="rounded-xl border border-majorelle-blue-100 bg-majorelle-blue-50 p-5 shadow-sm">
              <h3 className="mb-3 text-[10px] font-bold uppercase tracking-widest text-majorelle-blue-600">How to run this scenario</h3>
              <ol className="space-y-2.5">
                {[
                  'Switch to the Configure & Run tab.',
                  'Edit the YAML — update dates, factors, or key parameters.',
                  'Click Validate to check syntax and preview.',
                  'If valid, click Run Simulation.',
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-majorelle-blue-800">
                    <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-majorelle-blue-200 text-[9px] font-bold text-majorelle-blue-700">{i + 1}</span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
              <button
                onClick={() => setActiveTab('configure')}
                className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition hover:bg-majorelle-blue-600"
              >
                <Code2 size={13} /> Configure & Run →
              </button>
            </div>
          </div>
        )}

        {/* Configure & Run tab */}
        {activeTab === 'configure' && (
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
                className="flex w-full items-center justify-center gap-1.5 rounded-full border-2 border-majorelle-blue-500 bg-white px-4 py-2 text-xs font-bold text-majorelle-blue-500 transition hover:bg-majorelle-blue-50 disabled:opacity-50">
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
                className="flex w-full items-center justify-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300">
                {isRunning ? <><Loader2 size={14} className="animate-spin" /> Running…</> : 'Run Simulation'}
              </button>

              {!validation && !validateError && (
                <p className="text-center text-[10px] text-charcoal-blue-400">Validate first to enable Run</p>
              )}
            </div>
          </div>
        )}
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
            className="mb-4 inline-flex items-center gap-1 rounded-full border border-charcoal-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-charcoal-blue-500 shadow-sm transition hover:border-charcoal-blue-400 hover:text-charcoal-blue-800">
            <ChevronLeft size={13} /> All Scenarios
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
