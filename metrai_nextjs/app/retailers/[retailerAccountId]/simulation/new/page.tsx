'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { getRunYamlTemplate, runSimulation } from '@/lib/api/simulation'
import { useSimulationStore } from '@/lib/store/simulationStore'
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
  const [addScenario, setAddScenario] = useState(false)
  const [scenarioYaml, setScenarioYaml] = useState(PROMO_SCENARIO_TEMPLATE)
  const [stage, setStage] = useState<RunStage>({ type: 'idle' })
  const [templateLoading, setTemplateLoading] = useState(true)

  useEffect(() => {
    getRunYamlTemplate()
      .then(({ yaml: tpl }) => setRunYaml(tpl))
      .catch((err) => setStage({ type: 'error', message: `Failed to load template: ${err?.message ?? err}` }))
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

    const combinedYaml = addScenario ? `${finalYaml.trimEnd()}\n\n${scenarioYaml}` : finalYaml

    try {
      // /simulate handles demand generation + simulation inline — no separate steps needed
      setStage({ type: 'running_simulation', message: 'Running simulation…' })
      const result = await runSimulation(combinedYaml)
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

        <StepIndicator currentStep={currentStep} totalSteps={3} />

        {currentStep === 0 && (
          <div className="mb-5">
            {templateLoading
              ? <div className="flex items-center justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" /></div>
              : <YamlEditor value={runYaml} onChange={setRunYaml} label="Simulation Configuration" description="Dates, seed, WOS targets, DC/supplier/store overrides" />}
          </div>
        )}

        {currentStep === 1 && (
          <div className="mb-5 space-y-3">
            <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-bold text-charcoal-blue-950">Add a Scenario? (Optional)</h3>
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                <button onClick={() => setAddScenario(false)}
                  className={`rounded-xl border-2 p-3 text-left transition-all ${!addScenario ? 'border-majorelle-blue-500 bg-majorelle-blue-50' : 'border-charcoal-blue-200 hover:border-majorelle-blue-300'}`}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <div className={`rounded-xl p-1.5 ${!addScenario ? 'bg-majorelle-blue-500' : 'bg-charcoal-blue-100'}`}>
                      <Check size={14} className={!addScenario ? 'text-white' : 'text-charcoal-blue-400'} />
                    </div>
                    <span className="text-xs font-bold text-charcoal-blue-950">No Scenario</span>
                  </div>
                  <p className="text-[10px] text-charcoal-blue-400">Run with baseline demand only</p>
                </button>
                <button onClick={() => setAddScenario(true)}
                  className={`rounded-xl border-2 p-3 text-left transition-all ${addScenario ? 'border-majorelle-blue-500 bg-majorelle-blue-50' : 'border-charcoal-blue-200 hover:border-majorelle-blue-300'}`}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <div className={`rounded-xl p-1.5 ${addScenario ? 'bg-majorelle-blue-500' : 'bg-charcoal-blue-100'}`}>
                      <TrendingUp size={14} className={addScenario ? 'text-white' : 'text-charcoal-blue-400'} />
                    </div>
                    <span className="text-xs font-bold text-charcoal-blue-950">Promo Forecast</span>
                  </div>
                  <p className="text-[10px] text-charcoal-blue-400">Inject promotional demand uplift</p>
                </button>
              </div>
            </div>
            {addScenario && <YamlEditor value={scenarioYaml} onChange={setScenarioYaml} label="Scenario Configuration" description="Customize promo uplift dates and factor" />}
          </div>
        )}

        {currentStep === 2 && (
          <div className="mb-5 rounded-xl border border-charcoal-blue-200 bg-white p-5 shadow-sm">
            <h3 className="mb-4 text-base font-bold text-charcoal-blue-950">Review & Run</h3>
            <div className="mb-4 space-y-2">
              <div className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 p-3">
                <p className="text-xs font-semibold text-charcoal-blue-950">Simulation Config</p>
                <p className="mt-0.5 text-[10px] text-charcoal-blue-400">{runYaml.split('\n').filter(Boolean).length} lines</p>
              </div>
              <div className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 p-3">
                <p className="text-xs font-semibold text-charcoal-blue-950">Scenario</p>
                <p className="mt-0.5 text-[10px] text-majorelle-blue-500">{addScenario ? 'Promo Forecast' : 'None — baseline demand'}</p>
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
            onClick={() => { setCurrentStep(s => s - 1); setStage({ type: 'idle' }) }}
            disabled={currentStep === 0 || isRunning}
            className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
              currentStep === 0 || isRunning
                ? 'cursor-not-allowed bg-charcoal-blue-100 text-charcoal-blue-400'
                : 'border border-charcoal-blue-200 bg-white text-charcoal-blue-950 hover:bg-charcoal-blue-50'
            }`}
          >
            <ChevronLeft size={15} /> Previous
          </button>
          {currentStep < 2
            ? <button onClick={() => setCurrentStep(s => s + 1)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600">
                Next <ChevronRight size={15} />
              </button>
            : <button onClick={handleRun} disabled={isRunning}
                className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300">
                {isRunning ? 'Running…' : 'Run Simulation'}
              </button>
          }
        </div>
      </div>
    </div>
  )
}
