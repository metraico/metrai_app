'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { getRunYamlTemplate, runSimulation } from '@/lib/api/simulation'
import { getSimulatePreview, getPromoYamlTemplate } from '@/lib/api/promos'
import { useSimulationStore } from '@/lib/store/simulationStore'
import { ChevronRight, ChevronLeft, Check, AlertCircle, Code, TrendingUp, Tag } from 'lucide-react'
import yaml from 'js-yaml'
import type { SimulatePreviewResponse } from '@/lib/api/types'
import { SCENARIOS, NO_SCENARIO, type ScenarioId } from '@/lib/scenarios'

const PROMO_SCENARIO_TEMPLATE = `scenario:
  type: promo_forecast
  promos:
    - name: "Promo Event"
      start_date: "2024-06-01"
      end_date: "2024-06-30"
      factor: 1.5
`

function StepIndicator({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  return (
    <div className="mb-5 flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: totalSteps }).map((_, idx) => (
          <div key={idx} className="flex items-center">
            <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all ${
              idx < currentStep ? 'bg-emerald-500 text-white' : idx === currentStep ? 'bg-majorelle-blue-500 text-white' : 'bg-charcoal-blue-200 text-charcoal-blue-400'
            }`}>
              {idx < currentStep ? <Check size={13} /> : idx + 1}
            </div>
            {idx < totalSteps - 1 && <div className={`mx-1 h-0.5 w-8 ${idx < currentStep ? 'bg-emerald-500' : 'bg-charcoal-blue-200'}`} />}
          </div>
        ))}
      </div>
      <span className="text-[10px] font-semibold text-charcoal-blue-400">Step {currentStep + 1} of {totalSteps}</span>
    </div>
  )
}

function YamlEditor({
  value,
  onChange,
  label,
  description,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  description: string
}) {
  return (
    <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Code size={15} className="text-majorelle-blue-500" />
        <div>
          <h3 className="text-sm font-bold text-charcoal-blue-950">{label}</h3>
          <p className="text-[10px] text-charcoal-blue-400">{description}</p>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 px-3 py-2 font-mono text-xs text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500"
        rows={20}
        spellCheck={false}
      />
    </div>
  )
}

type RunStage =
  | { type: 'idle' }
  | { type: 'generating_demand'; message: string }
  | { type: 'running_simulation'; message: string }
  | { type: 'error'; message: string }

export default function NewSimulationPage() {
  const params = useParams()
  const router = useRouter()
  const { userId, retailerAccountId } = useAuthStore()
  const routeAccountId = params.retailerAccountId as string

  const { setCache } = useSimulationStore()
  const [currentStep, setCurrentStep] = useState(0)
  const [runYaml, setRunYaml] = useState('')
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId>('no_scenario')
  const [scenarioYaml, setScenarioYaml] = useState(PROMO_SCENARIO_TEMPLATE)
  const [stage, setStage] = useState<RunStage>({ type: 'idle' })
  const [templateLoading, setTemplateLoading] = useState(true)

  const [promoPreview, setPromoPreview] = useState<SimulatePreviewResponse | null>(null)
  const [promoPreviewLoading, setPromoPreviewLoading] = useState(false)
  const [promoYaml, setPromoYaml] = useState('')
  const [promoYamlLoading, setPromoYamlLoading] = useState(false)
  const [promoYamlValid, setPromoYamlValid] = useState<boolean | null>(null)

  useEffect(() => {
    getRunYamlTemplate(routeAccountId)
      .then(({ yaml: tpl }) => setRunYaml(tpl))
      .catch((err) => setStage({ type: 'error', message: `Failed to load template: ${err?.message ?? err}` }))
      .finally(() => setTemplateLoading(false))
  }, [])

  // Steps: 0=Config, 1=Promo Preview+Overrides, 2=Scenario, 3=Scenario YAML (any scenario except no_scenario), 4=Review & Run
  const hasScenario = selectedScenario !== 'no_scenario'
  const isRunning = stage.type === 'generating_demand' || stage.type === 'running_simulation'

  // Visual step indicator: skip step 3 when no scenario selected
  const totalVisualSteps = hasScenario ? 5 : 4
  const visualStep = (hasScenario || currentStep < 3) ? currentStep : currentStep - 1

  const parseRunParams = (): { start_date: string; end_date: string; seed: number } | null => {
    try {
      const parsed = yaml.load(runYaml) as { run?: Record<string, unknown> }
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

  const handleNext = () => {
    if (currentStep === 0) {
      // Step 0 → 1: fetch promo preview + overrides as we enter step 1
      const runParams = parseRunParams()
      setCurrentStep(1)
      if (runParams?.start_date && runParams?.end_date) {
        setPromoPreviewLoading(true)
        getSimulatePreview(routeAccountId, runParams.start_date, runParams.end_date)
          .then(setPromoPreview).catch(() => {}).finally(() => setPromoPreviewLoading(false))
        if (!promoYaml) {
          setPromoYamlLoading(true)
          getPromoYamlTemplate(routeAccountId, runParams.start_date, runParams.end_date)
            .then(({ yaml: tpl }) => setPromoYaml(tpl)).catch(() => {}).finally(() => setPromoYamlLoading(false))
        }
      }
    } else if (currentStep === 2) {
      // Step 2 → 3 (scenario YAML) if any scenario selected, else skip to step 4 (review)
      setCurrentStep(hasScenario ? 3 : 4)
    } else {
      setCurrentStep(s => s + 1)
    }
  }

  const handlePrev = () => {
    setStage({ type: 'idle' })
    if (currentStep === 4 && !hasScenario) {
      // skipped step 3, go back to step 2
      setCurrentStep(2)
    } else {
      setCurrentStep(s => s - 1)
    }
  }

  const handleRun = async () => {
    const runParams = parseRunParams()
    if (!runParams?.start_date || !runParams?.end_date) {
      setStage({ type: 'error', message: 'Could not parse start_date, end_date, or seed from YAML.' })
      return
    }

    const accountId = routeAccountId || retailerAccountId
    if (!accountId) {
      setStage({ type: 'error', message: 'No retailer account selected.' })
      return
    }

    // Inject retailer_account_id and user_id into YAML top level
    let finalYaml = runYaml
    try {
      const parsed = yaml.load(runYaml) as Record<string, unknown>
      parsed.retailer_account_id = accountId
      if (userId) parsed.user_id = userId
      finalYaml = yaml.dump(parsed)
    } catch {
      // keep original yaml if parse fails
    }

    const combinedYaml = hasScenario ? `${finalYaml.trimEnd()}\n\n${scenarioYaml}` : finalYaml

    try {
      // /simulate handles demand generation + simulation inline — no separate steps needed
      setStage({ type: 'running_simulation', message: 'Running simulation…' })
      const result = await runSimulation(combinedYaml, promoYaml)
      const { simulation_id, summary } = result

      const simName = (yaml.load(runYaml) as any)?.run?.simulation_name ?? 'Simulation Results'
      if (summary) setCache({ simulationId: simulation_id, simulationName: simName, summary })

      router.push(`/retailers/${routeAccountId}/simulation/${simulation_id}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An error occurred.'
      setStage({ type: 'error', message: msg })
    }
  }

  return (
    <div className="w-full px-6 py-6">
      <div className="w-full">
        <div className="mb-5">
          <h1 className="mb-1 text-2xl font-black tracking-tight text-charcoal-blue-950">
            Create New Simulation
          </h1>
          <p className="text-xs font-medium text-charcoal-blue-400">
            Configure your simulation parameters and run it
          </p>
        </div>

        <StepIndicator currentStep={visualStep} totalSteps={totalVisualSteps} />

        {currentStep === 0 && (
          <div className="mb-5">
            {templateLoading
              ? <div className="flex items-center justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" /></div>
              : <YamlEditor value={runYaml} onChange={setRunYaml} label="Simulation Configuration" description="Dates, seed, WOS targets, DC/supplier/store overrides" />}
          </div>
        )}

        {/* Step 1 — Promo Preview + Promo Overrides */}
        {currentStep === 1 && (
          <div className="mb-5 space-y-3">
            {/* Promo Preview */}
            <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <TrendingUp size={15} className="text-majorelle-blue-500" />
                <div>
                  <h3 className="text-sm font-bold text-charcoal-blue-950">Promo Preview</h3>
                  <p className="text-[10px] text-charcoal-blue-400">Baseline promotions active during your simulation window</p>
                </div>
              </div>
              {promoPreviewLoading && (
                <div className="flex items-center justify-center py-8">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                </div>
              )}
              {!promoPreviewLoading && promoPreview && (
                <>
                  <div className="mb-3 grid grid-cols-3 gap-2">
                    <div className="rounded-lg bg-majorelle-blue-50 p-2 text-center">
                      <p className="text-lg font-black text-majorelle-blue-600">{promoPreview.active_promos}</p>
                      <p className="text-[9px] font-semibold text-charcoal-blue-400">Active Promos</p>
                    </div>
                    <div className="rounded-lg bg-charcoal-blue-50 p-2 text-center">
                      <p className="text-lg font-black text-charcoal-blue-950">{promoPreview.total_promo_groups}</p>
                      <p className="text-[9px] font-semibold text-charcoal-blue-400">Promo Groups</p>
                    </div>
                    <div className="rounded-lg bg-charcoal-blue-50 p-2 text-center">
                      <p className="text-lg font-black text-charcoal-blue-950">{promoPreview.total_promos}</p>
                      <p className="text-[9px] font-semibold text-charcoal-blue-400">Total in Account</p>
                    </div>
                  </div>
                  {promoPreview.active_promos === 0 ? (
                    <div className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 p-4 text-center">
                      <Tag size={20} className="mx-auto mb-1.5 text-charcoal-blue-300" />
                      <p className="text-xs font-semibold text-charcoal-blue-950">No promos active in this date range</p>
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-charcoal-blue-200">
                      <div className="max-h-48 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-charcoal-blue-50">
                            <tr>
                              {['Promo Name', 'Event Type', 'Dates', 'Uplift', 'Stores', 'Items'].map(h => (
                                <th key={h} className="px-2 py-1.5 text-left font-bold uppercase tracking-wide text-charcoal-blue-400 text-[9px]">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-charcoal-blue-100">
                            {promoPreview.promos.map(p => (
                              <tr key={p.promo_id} className="bg-white hover:bg-charcoal-blue-50">
                                <td className="px-2 py-1 font-semibold text-charcoal-blue-950">{p.promo_name}</td>
                                <td className="px-2 py-1">
                                  <span className="rounded bg-majorelle-blue-50 px-1 py-0.5 font-bold text-majorelle-blue-600">{p.event_type || '—'}</span>
                                </td>
                                <td className="px-2 py-1 whitespace-nowrap text-charcoal-blue-400">{p.start_date} → {p.end_date}</td>
                                <td className="px-2 py-1 text-center font-bold text-emerald-600">{p.demand_multiplier}×</td>
                                <td className="px-2 py-1 text-center">{p.store_count}</td>
                                <td className="px-2 py-1 text-center">{p.item_count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
              {!promoPreviewLoading && !promoPreview && (
                <p className="text-[10px] text-amber-700">Could not load preview — simulation will use promos from database.</p>
              )}
            </div>

            {/* Promo Overrides YAML */}
            <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
              <div className="mb-2">
                <h3 className="text-sm font-bold text-charcoal-blue-950">Promo Overrides</h3>
                <p className="text-[10px] text-charcoal-blue-400">Optionally override start date, end date, or demand multiplier for any baseline promo — this run only. Leave empty to use promos as stored.</p>
              </div>
              {promoYamlLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                </div>
              ) : (
                <textarea
                  value={promoYaml}
                  onChange={e => {
                    setPromoYaml(e.target.value)
                    try { yaml.load(e.target.value); setPromoYamlValid(true) } catch { setPromoYamlValid(false) }
                  }}
                  className="w-full rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 px-3 py-2 font-mono text-xs text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500"
                  rows={8}
                  spellCheck={false}
                  placeholder="# Leave empty to use promos as stored&#10;# Example:&#10;# promos:&#10;#   - promo_name: Summer Sale&#10;#     start_date: 2024-06-01&#10;#     demand_multiplier: 1.8"
                />
              )}
              {!promoYamlLoading && promoYaml && promoYamlValid === false && (
                <p className="mt-1.5 flex items-center gap-1 text-[10px] text-rose-600"><AlertCircle size={11} /> Invalid YAML</p>
              )}
              {!promoYamlLoading && promoYaml && promoYamlValid === true && (
                <p className="mt-1.5 flex items-center gap-1 text-[10px] text-emerald-600"><Check size={11} /> Valid YAML</p>
              )}
            </div>
          </div>
        )}

        {/* Step 2 — Scenario selection */}
        {currentStep === 2 && (
          <div className="mb-5 space-y-4">
            <div>
              <h3 className="mb-1 text-sm font-bold text-charcoal-blue-950">Choose a Scenario</h3>
              <p className="text-[10px] text-charcoal-blue-400">Select a scenario to apply to this run, or run with baseline demand only.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {[NO_SCENARIO, ...SCENARIOS].map(s => {
                const Icon = s.icon
                const active = selectedScenario === s.id
                const isNoScenario = s.id === 'no_scenario'
                const isPromoForecast = s.id === 'promo_forecast'
                return (
                  <button key={s.id} onClick={() => setSelectedScenario(s.id as ScenarioId)}
                    className={`rounded-xl border-2 p-4 text-left transition-all ${active ? 'border-majorelle-blue-500 bg-majorelle-blue-50' : 'border-charcoal-blue-200 bg-white hover:border-majorelle-blue-300'}`}>
                    <div className="mb-2 flex items-center justify-between">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-xl ${active ? 'bg-majorelle-blue-500' : 'bg-majorelle-blue-50'}`}>
                        <Icon size={15} className={active ? 'text-white' : 'text-majorelle-blue-500'} />
                      </div>
                      <div className="flex items-center gap-2">
                        {!isNoScenario && <span className="rounded-full border border-majorelle-blue-200 px-2 py-0.5 text-[9px] font-semibold text-majorelle-blue-500">{(s as any).badge}</span>}
                        {active && <div className="flex h-5 w-5 items-center justify-center rounded-full bg-majorelle-blue-500"><Check size={11} className="text-white" /></div>}
                      </div>
                    </div>
                    <p className="text-xs font-bold text-charcoal-blue-950">{s.title}</p>
                    <p className="mt-0.5 text-[10px] text-charcoal-blue-400">{s.question}</p>
                    {!isNoScenario && (
                      <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-charcoal-blue-50 px-2 py-0.5 text-[9px] font-semibold text-charcoal-blue-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                        Coming soon
                      </span>
                    )}
                    {isNoScenario && <p className="mt-1.5 text-[9px] font-semibold text-majorelle-blue-500">Selected — baseline demand only</p>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Step 3 — Scenario YAML config (under construction — Next is disabled) */}
        {currentStep === 3 && hasScenario && (
          <div className="mb-5 space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start gap-2">
                <AlertCircle size={15} className="mt-0.5 flex-shrink-0 text-amber-500" />
                <div>
                  <p className="text-xs font-bold text-amber-900">Scenario configuration — coming soon</p>
                  <p className="mt-0.5 text-[10px] text-amber-700">
                    This step is currently under construction. Scenario-specific YAML parameters will be configurable here in a future release.
                    For now the simulation runs with baseline demand only. Use <strong>Scenario Setup</strong> in the sidebar to explore the full YAML editor.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm opacity-60 pointer-events-none select-none">
              <div className="mb-3 flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-majorelle-blue-50">
                  {(() => { const s = [...SCENARIOS].find(s => s.id === selectedScenario); if (!s) return null; const Icon = s.icon; return <Icon size={15} className="text-majorelle-blue-500" /> })()}
                </div>
                <div>
                  <p className="text-sm font-bold text-charcoal-blue-950">
                    {SCENARIOS.find(s => s.id === selectedScenario)?.title ?? selectedScenario}
                  </p>
                  <p className="text-[10px] text-charcoal-blue-400">Scenario YAML editor — locked</p>
                </div>
              </div>
              <div className="h-32 rounded-lg border border-dashed border-charcoal-blue-300 bg-charcoal-blue-50 flex items-center justify-center">
                <p className="text-xs font-semibold text-charcoal-blue-400">Configuration fields coming soon</p>
              </div>
            </div>
          </div>
        )}

        {/* Step 4 — Review & Run */}
        {currentStep === 4 && (
          <div className="mb-5 rounded-xl border border-charcoal-blue-200 bg-white p-5 shadow-sm">
            <h3 className="mb-4 text-base font-bold text-charcoal-blue-950">Review & Run</h3>
            <div className="mb-4 space-y-2">
              <div className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 p-3">
                <p className="text-xs font-semibold text-charcoal-blue-950">Simulation Config</p>
                <p className="mt-0.5 text-[10px] text-charcoal-blue-400">{runYaml.split('\n').filter(Boolean).length} lines</p>
              </div>
              <div className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 p-3">
                <p className="text-xs font-semibold text-charcoal-blue-950">Scenario</p>
                <p className="mt-0.5 text-[10px] text-majorelle-blue-500">
                  {selectedScenario === 'no_scenario'
                    ? 'None — baseline demand'
                    : [...SCENARIOS].find(s => s.id === selectedScenario)?.title ?? selectedScenario}
                </p>
              </div>
              <div className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 p-3">
                <p className="text-xs font-semibold text-charcoal-blue-950">Promo Overrides</p>
                <p className="mt-0.5 text-[10px] text-majorelle-blue-500">
                  {promoYaml.trim()
                    ? `${(promoYaml.match(/promo_name:/g) ?? []).length} promo(s) overridden`
                    : 'None — using promos as stored'}
                </p>
              </div>
            </div>
            {stage.type === 'error' && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0 text-rose-500" />
                <p className="text-xs font-semibold text-rose-950">{stage.message}</p>
              </div>
            )}
            {stage.type === 'running_simulation' && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-majorelle-blue-200 bg-majorelle-blue-50 p-3">
                <div className="h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                <p className="text-xs font-semibold text-majorelle-blue-950">{stage.message}</p>
              </div>
            )}
            {stage.type === 'idle' && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <p className="text-xs font-medium text-emerald-950">✓ Ready to run. Click Run Simulation to start.</p>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-3">
          <button
            onClick={handlePrev}
            disabled={currentStep === 0 || isRunning}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold transition-all ${
              currentStep === 0 || isRunning
                ? 'cursor-not-allowed bg-charcoal-blue-100 text-charcoal-blue-400'
                : 'border border-charcoal-blue-200 bg-white text-charcoal-blue-950 hover:bg-charcoal-blue-50'
            }`}
          >
            <ChevronLeft size={15} /> Previous
          </button>
          {currentStep < 4
            ? <button
                onClick={handleNext}
                disabled={currentStep === 3 && hasScenario}
                title={currentStep === 3 && hasScenario ? 'Scenario configuration coming soon' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold transition-all ${
                  currentStep === 3 && hasScenario
                    ? 'cursor-not-allowed bg-charcoal-blue-200 text-charcoal-blue-400'
                    : 'bg-majorelle-blue-500 text-white hover:bg-majorelle-blue-600'
                }`}
              >
                Next <ChevronRight size={15} />
              </button>
            : <button onClick={handleRun} disabled={isRunning}
                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300">
                {isRunning ? 'Running…' : 'Run Simulation'}
              </button>
          }
        </div>
      </div>
    </div>
  )
}
