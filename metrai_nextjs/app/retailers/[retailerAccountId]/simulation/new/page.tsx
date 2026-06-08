'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { getRunYamlTemplate, runSimulation, pollSimulationUntilDone } from '@/lib/api/simulation'
import { generateDemand, pollDemandUntilDone } from '@/lib/api/demand'
import { ChevronRight, ChevronLeft, Check, AlertCircle, Code, TrendingUp } from 'lucide-react'
import yaml from 'js-yaml'

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
  const { userId, retailerAccountId } = useAuthStore()
  const routeAccountId = params.retailerAccountId as string

  const [currentStep, setCurrentStep] = useState(0)
  const [runYaml, setRunYaml] = useState('')
  const [addScenario, setAddScenario] = useState(false)
  const [scenarioYaml, setScenarioYaml] = useState(PROMO_SCENARIO_TEMPLATE)
  const [stage, setStage] = useState<RunStage>({ type: 'idle' })
  const [templateLoading, setTemplateLoading] = useState(true)

  useEffect(() => {
    getRunYamlTemplate()
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

    const combinedYaml = addScenario ? `${runYaml.trimEnd()}\n\n${scenarioYaml}` : runYaml

    try {
      // Step 1: generate demand
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

      // Step 2: run simulation
      setStage({ type: 'running_simulation', message: 'Starting simulation…' })
      const { simulation_id } = await runSimulation(combinedYaml)
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

        {/* Step 2: Optional Scenario */}
        {currentStep === 1 && (
          <div className="mb-8 space-y-6">
            <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
              <h3 className="mb-4 text-lg font-bold text-charcoal-blue-950">Add a Scenario? (Optional)</h3>
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
                <button
                  onClick={() => setAddScenario(false)}
                  className={`rounded-2xl border-2 p-5 text-left transition-all ${
                    !addScenario
                      ? 'border-majorelle-blue-500 bg-majorelle-blue-50'
                      : 'border-charcoal-blue-200 hover:border-majorelle-blue-300'
                  }`}
                >
                  <div className="mb-2 flex items-center gap-3">
                    <div className={`rounded-xl p-2 ${!addScenario ? 'bg-majorelle-blue-500' : 'bg-charcoal-blue-100'}`}>
                      <Check size={20} className={!addScenario ? 'text-white' : 'text-charcoal-blue-400'} />
                    </div>
                    <span className="font-bold text-charcoal-blue-950">No Scenario</span>
                  </div>
                  <p className="text-sm text-charcoal-blue-400">Run with baseline demand only</p>
                </button>

                <button
                  onClick={() => setAddScenario(true)}
                  className={`rounded-2xl border-2 p-5 text-left transition-all ${
                    addScenario
                      ? 'border-majorelle-blue-500 bg-majorelle-blue-50'
                      : 'border-charcoal-blue-200 hover:border-majorelle-blue-300'
                  }`}
                >
                  <div className="mb-2 flex items-center gap-3">
                    <div className={`rounded-xl p-2 ${addScenario ? 'bg-majorelle-blue-500' : 'bg-charcoal-blue-100'}`}>
                      <TrendingUp size={20} className={addScenario ? 'text-white' : 'text-charcoal-blue-400'} />
                    </div>
                    <span className="font-bold text-charcoal-blue-950">Promo Forecast</span>
                  </div>
                  <p className="text-sm text-charcoal-blue-400">Inject promotional demand uplift</p>
                </button>
              </div>
            </div>

            {addScenario && (
              <YamlEditor
                value={scenarioYaml}
                onChange={setScenarioYaml}
                label="Scenario Configuration"
                description="Customize the promo uplift dates and factor"
              />
            )}
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
                <p className="text-sm font-semibold text-charcoal-blue-950">Scenario</p>
                <p className="mt-1 text-xs text-majorelle-blue-500">
                  {addScenario ? 'Promo Forecast' : 'None — baseline demand'}
                </p>
              </div>
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
              onClick={() => setCurrentStep(s => s + 1)}
              className="inline-flex items-center gap-2 rounded-2xl bg-majorelle-blue-500 px-6 py-3 font-bold text-white transition-all hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30"
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
