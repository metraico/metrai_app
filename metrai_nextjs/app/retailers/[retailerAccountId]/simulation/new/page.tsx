'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { getRunYamlTemplate, runSimulation, pollSimulationUntilDone } from '@/lib/api/simulation'
import { generateDemand, pollDemandUntilDone } from '@/lib/api/demand'
import { getSimulatePreview, getPromoYamlTemplate } from '@/lib/api/promos'
import type { SimulatePreviewResponse } from '@/lib/api/types'
import { ChevronRight, ChevronLeft, Check, AlertCircle, Code, TrendingUp, Tag, FileEdit } from 'lucide-react'
import yaml from 'js-yaml'

function StepIndicator({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  return (
    <div className="mb-8 flex items-center justify-between">
      <div className="flex items-center gap-2">
        {Array.from({ length: totalSteps }).map((_, idx) => (
          <div key={idx} className="flex items-center">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-full font-bold text-sm transition-all ${
                idx < currentStep
                  ? 'bg-emerald-500 text-white'
                  : idx === currentStep
                  ? 'bg-majorelle-blue-500 text-white'
                  : 'bg-charcoal-blue-200 text-charcoal-blue-400'
              }`}
            >
              {idx < currentStep ? <Check size={18} /> : idx + 1}
            </div>
            {idx < totalSteps - 1 && (
              <div
                className={`mx-1 h-1 w-12 ${
                  idx < currentStep ? 'bg-emerald-500' : 'bg-charcoal-blue-200'
                }`}
              />
            )}
          </div>
        ))}
      </div>
      <span className="text-sm font-semibold text-charcoal-blue-400">
        Step {currentStep + 1} of {totalSteps}
      </span>
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
    <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Code size={20} className="text-majorelle-blue-500" />
        <div>
          <h3 className="text-lg font-bold text-charcoal-blue-950">{label}</h3>
          <p className="text-xs text-charcoal-blue-400">{description}</p>
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-2xl border border-charcoal-blue-200 bg-charcoal-blue-50 px-4 py-3 font-mono text-sm text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500"
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
  const { retailerAccountId } = useAuthStore()
  const routeAccountId = params.retailerAccountId as string

  const [currentStep, setCurrentStep] = useState(0)
  const [runYaml, setRunYaml] = useState('')
  const [promoYaml, setPromoYaml] = useState('')
  const [promoYamlValid, setPromoYamlValid] = useState<boolean | null>(null)
  const [promoYamlLoading, setPromoYamlLoading] = useState(false)
  const [stage, setStage] = useState<RunStage>({ type: 'idle' })
  const [templateLoading, setTemplateLoading] = useState(true)
  const [promoPreview, setPromoPreview] = useState<SimulatePreviewResponse | null>(null)
  const [promoPreviewLoading, setPromoPreviewLoading] = useState(false)

  useEffect(() => {
    getRunYamlTemplate(routeAccountId)
      .then(({ yaml: tpl }) => setRunYaml(tpl))
      .catch(() => {
        setRunYaml(`run:
  simulation_name: "My Simulation"
  start_date: "2024-01-01"
  end_date: "2026-06-30"
  seed: 42
  store_target_wos: 2
  retailer_dc_target_wos: 4
  supplier_dc_initial_wos: 4
`)
      })
      .finally(() => setTemplateLoading(false))
  }, [])

  const isRunning = stage.type === 'generating_demand' || stage.type === 'running_simulation'

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
      const runParams = parseRunParams()
      setCurrentStep(1)
      if (runParams?.start_date && runParams?.end_date) {
        setPromoPreviewLoading(true)
        getSimulatePreview(routeAccountId, runParams.start_date, runParams.end_date)
          .then(setPromoPreview)
          .catch(() => setPromoPreview(null))
          .finally(() => setPromoPreviewLoading(false))
        if (!promoYaml) {
          setPromoYamlLoading(true)
          getPromoYamlTemplate(routeAccountId, runParams.start_date, runParams.end_date)
            .then(({ yaml: tpl }) => setPromoYaml(tpl))
            .catch(() => {})
            .finally(() => setPromoYamlLoading(false))
        }
      }
    } else {
      setCurrentStep(s => s + 1)
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
      const { simulation_id } = await runSimulation(runYaml, promoYaml)
      await pollSimulationUntilDone(simulation_id, 3000, (s) => {
        setStage({ type: 'running_simulation', message: `Simulation: ${s.status}…` })
      })

      router.push(`/retailers/${routeAccountId}/simulation/${simulation_id}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'An error occurred.'
      setStage({ type: 'error', message: msg })
    }
  }

  return (
    <div className="w-full px-8 py-10">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <h1 className="mb-2 text-4xl font-black tracking-tight text-charcoal-blue-950">
            Create New Simulation
          </h1>
          <p className="text-base font-medium text-charcoal-blue-400">
            Configure your simulation parameters and run it
          </p>
        </div>

        <StepIndicator currentStep={currentStep} totalSteps={3} />

        {/* Step 1: Run Config */}
        {currentStep === 0 && (
          <div className="mb-8">
            {templateLoading ? (
              <div className="flex items-center justify-center py-24">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-majorelle-blue-500 border-t-transparent" />
              </div>
            ) : (
              <YamlEditor
                value={runYaml}
                onChange={setRunYaml}
                label="Simulation Configuration"
                description="Defines the run parameters — dates, seed, WOS targets, DC/supplier/store overrides"
              />
            )}
          </div>
        )}

        {/* Step 2: Promo Preview + Overrides */}
        {currentStep === 1 && (
          <div className="mb-8 space-y-6">
            {/* Preview card */}
            <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <TrendingUp size={22} className="text-majorelle-blue-500" />
                <div>
                  <h3 className="text-lg font-bold text-charcoal-blue-950">Promo Preview</h3>
                  <p className="text-xs text-charcoal-blue-400">Promos active during your simulation window</p>
                </div>
              </div>

              {promoPreviewLoading && (
                <div className="flex items-center justify-center py-16">
                  <div className="h-7 w-7 animate-spin rounded-full border-4 border-majorelle-blue-500 border-t-transparent" />
                </div>
              )}

              {!promoPreviewLoading && promoPreview && (
                <>
                  <div className="mb-6 grid grid-cols-3 gap-4">
                    <div className="rounded-xl bg-majorelle-blue-50 p-4 text-center">
                      <p className="text-2xl font-black text-majorelle-blue-600">{promoPreview.active_promos}</p>
                      <p className="mt-1 text-xs font-semibold text-charcoal-blue-400">Active Promos</p>
                    </div>
                    <div className="rounded-xl bg-charcoal-blue-50 p-4 text-center">
                      <p className="text-2xl font-black text-charcoal-blue-950">{promoPreview.total_promo_groups}</p>
                      <p className="mt-1 text-xs font-semibold text-charcoal-blue-400">Promo Groups</p>
                    </div>
                    <div className="rounded-xl bg-charcoal-blue-50 p-4 text-center">
                      <p className="text-2xl font-black text-charcoal-blue-950">{promoPreview.total_promos}</p>
                      <p className="mt-1 text-xs font-semibold text-charcoal-blue-400">Total in Account</p>
                    </div>
                  </div>

                  {promoPreview.active_promos === 0 ? (
                    <div className="rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50 p-8 text-center">
                      <Tag size={32} className="mx-auto mb-3 text-charcoal-blue-300" />
                      <p className="font-semibold text-charcoal-blue-950">No promos active in this date range</p>
                      <p className="mt-1 text-sm text-charcoal-blue-400">Simulation will run on baseline demand only.</p>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-charcoal-blue-200 overflow-hidden">
                      <div className="overflow-y-auto max-h-52">
                        <table className="w-full text-xs">
                          <thead className="bg-charcoal-blue-50 sticky top-0 z-10">
                            <tr>
                              <th className="px-3 py-2 text-left font-bold uppercase tracking-wide text-charcoal-blue-400">Promo Name</th>
                              <th className="px-3 py-2 text-left font-bold uppercase tracking-wide text-charcoal-blue-400">Event Type</th>
                              <th className="px-3 py-2 text-left font-bold uppercase tracking-wide text-charcoal-blue-400">Dates</th>
                              <th className="px-3 py-2 text-center font-bold uppercase tracking-wide text-charcoal-blue-400">Uplift</th>
                              <th className="px-3 py-2 text-center font-bold uppercase tracking-wide text-charcoal-blue-400">Stores</th>
                              <th className="px-3 py-2 text-center font-bold uppercase tracking-wide text-charcoal-blue-400">Items</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-charcoal-blue-100">
                            {promoPreview.promos.map((p) => (
                              <tr key={p.promo_id} className="bg-white hover:bg-charcoal-blue-50 transition-colors">
                                <td className="px-3 py-1.5 font-semibold text-charcoal-blue-950">{p.promo_name}</td>
                                <td className="px-3 py-1.5">
                                  <span className="rounded-md bg-majorelle-blue-50 px-1.5 py-0.5 font-bold text-majorelle-blue-600">
                                    {p.event_type || '—'}
                                  </span>
                                </td>
                                <td className="px-3 py-1.5 text-charcoal-blue-400 whitespace-nowrap">
                                  {p.start_date} → {p.end_date}
                                </td>
                                <td className="px-3 py-1.5 text-center font-bold text-emerald-600">
                                  {p.demand_multiplier}×
                                </td>
                                <td className="px-3 py-1.5 text-center text-charcoal-blue-950">{p.store_count}</td>
                                <td className="px-3 py-1.5 text-center text-charcoal-blue-950">{p.item_count}</td>
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
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  Could not load promo preview. The simulation will still run using promos from the database.
                </div>
              )}
            </div>

            {/* Promo YAML overrides card */}
            <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-2">
                <FileEdit size={20} className="text-majorelle-blue-500" />
                <div>
                  <h3 className="text-lg font-bold text-charcoal-blue-950">Promo Overrides</h3>
                  <p className="text-xs text-charcoal-blue-400">
                    Override start date, end date, or demand multiplier for any promo — for this run only
                  </p>
                </div>
              </div>
              {promoYamlLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="h-7 w-7 animate-spin rounded-full border-4 border-majorelle-blue-500 border-t-transparent" />
                </div>
              ) : (
                <textarea
                  value={promoYaml}
                  onChange={(e) => {
                    setPromoYaml(e.target.value)
                    try { yaml.load(e.target.value); setPromoYamlValid(true) }
                    catch { setPromoYamlValid(false) }
                  }}
                  className="w-full rounded-2xl border border-charcoal-blue-200 bg-charcoal-blue-50 px-4 py-3 font-mono text-sm text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500"
                  rows={14}
                  spellCheck={false}
                />
              )}
              {!promoYamlLoading && promoYaml && promoYamlValid === false && (
                <p className="mt-2 flex items-center gap-1 text-xs text-rose-600">
                  <AlertCircle size={12} /> Invalid YAML — fix syntax errors before continuing
                </p>
              )}
              {!promoYamlLoading && promoYaml && promoYamlValid === true && (
                <p className="mt-2 flex items-center gap-1 text-xs text-emerald-600">
                  <Check size={12} /> Valid YAML
                </p>
              )}
              {!promoYamlLoading && !promoYaml && (
                <p className="mt-2 text-xs text-charcoal-blue-400">
                  Leave empty to use all promos exactly as stored in the database.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step 3: Review & Run */}
        {currentStep === 2 && (
          <div className="mb-8 rounded-2xl border border-charcoal-blue-200 bg-white p-8 shadow-sm">
            <h3 className="mb-6 text-xl font-bold text-charcoal-blue-950">Review & Run</h3>

            <div className="mb-6 space-y-4">
              <div className="rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50 p-4">
                <p className="text-sm font-semibold text-charcoal-blue-950">Simulation Config</p>
                <p className="mt-1 text-xs text-charcoal-blue-400">
                  {runYaml.split('\n').filter(Boolean).length} lines
                </p>
              </div>
              <div className="rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50 p-4">
                <p className="text-sm font-semibold text-charcoal-blue-950">Promos</p>
                <p className="mt-1 text-xs text-majorelle-blue-500">
                  {promoPreview
                    ? `${promoPreview.active_promos} active promo${promoPreview.active_promos !== 1 ? 's' : ''} in simulation window`
                    : 'Loaded from database'}
                </p>
              </div>
              {promoYaml.trim() && (
                <div className="rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50 p-4">
                  <p className="text-sm font-semibold text-charcoal-blue-950">Promo Overrides</p>
                  <p className="mt-1 text-xs text-majorelle-blue-600">
                    {(promoYaml.match(/promo_name:/g) ?? []).length} promo(s) overridden for this run
                  </p>
                </div>
              )}
            </div>

            {stage.type === 'error' && (
              <div className="mb-6 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4">
                <AlertCircle size={20} className="mt-0.5 flex-shrink-0 text-rose-500" />
                <p className="text-sm font-semibold text-rose-950">{stage.message}</p>
              </div>
            )}

            {(stage.type === 'generating_demand' || stage.type === 'running_simulation') && (
              <div className="mb-6 flex items-center gap-3 rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50 p-4">
                <div className="h-5 w-5 flex-shrink-0 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                <p className="text-sm font-semibold text-majorelle-blue-950">{stage.message}</p>
              </div>
            )}

            {stage.type === 'idle' && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-medium text-emerald-950">
                  ✓ Ready to run. Click Run Simulation to start.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Navigation */}
        <div className="mt-8 flex items-center justify-between gap-4">
          <button
            onClick={() => { setCurrentStep(s => s - 1); setStage({ type: 'idle' }) }}
            disabled={currentStep === 0 || isRunning}
            className={`inline-flex items-center gap-2 rounded-2xl px-6 py-3 font-bold transition-all ${
              currentStep === 0 || isRunning
                ? 'cursor-not-allowed bg-charcoal-blue-100 text-charcoal-blue-400'
                : 'border border-charcoal-blue-200 bg-white text-charcoal-blue-950 hover:bg-charcoal-blue-50'
            }`}
          >
            <ChevronLeft size={20} />
            Previous
          </button>

          {currentStep < 2 ? (
            <button
              onClick={handleNext}
              disabled={currentStep === 0 && templateLoading}
              className="inline-flex items-center gap-2 rounded-2xl bg-majorelle-blue-500 px-6 py-3 font-bold text-white transition-all hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300"
            >
              Next
              <ChevronRight size={20} />
            </button>
          ) : (
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="inline-flex items-center gap-2 rounded-2xl bg-emerald-500 px-6 py-3 font-bold text-white transition-all hover:bg-emerald-600 hover:shadow-lg hover:shadow-emerald-500/30 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300"
            >
              {isRunning ? 'Running…' : 'Run Simulation'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
