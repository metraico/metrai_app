'use client'

import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { getRunYamlTemplate, runSimulation } from '@/lib/api/simulation'
import { getSimulatePreview, getPromoYamlTemplate } from '@/lib/api/promos'
import { useSimulationStore } from '@/lib/store/simulationStore'
import { ChevronRight, ChevronLeft, Check, AlertCircle, Code, TrendingUp, Tag } from 'lucide-react'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import yaml from 'js-yaml'
import type { SimulatePreviewResponse } from '@/lib/api/types'
import { SCENARIOS, NO_SCENARIO, type ScenarioId } from '@/lib/scenarios'
import { cn } from '@/lib/utils'

interface RunFormValues {
  simulation_name: string
  notes: string
  start_date: string
  end_date: string
  seed: number
  store_target_wos: number
  store_initial_wos: number
  retailer_dc_target_wos: number
  retailer_dc_initial_wos: number
  supplier_dc_initial_wos: number
  supplier_dc_to_retailer_dc_lead_weeks: number
  retailer_dc_to_store_lead_weeks: number
  supplier_otd_rate: number
  supplier_in_full_rate: number
  dc_otd_rate: number
  dc_in_full_rate: number
  disable_promo_decay: boolean
}

const DEFAULT_FORM: RunFormValues = {
  simulation_name: 'New Simulation Run',
  notes: '',
  start_date: '2024-01-01',
  end_date: '2024-12-31',
  seed: 42,
  store_target_wos: 2,
  store_initial_wos: 2,
  retailer_dc_target_wos: 4,
  retailer_dc_initial_wos: 4,
  supplier_dc_initial_wos: 4,
  supplier_dc_to_retailer_dc_lead_weeks: 1,
  retailer_dc_to_store_lead_weeks: 1,
  supplier_otd_rate: 0.95,
  supplier_in_full_rate: 0.95,
  dc_otd_rate: 0.95,
  dc_in_full_rate: 0.95,
  disable_promo_decay: false,
}

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
  rows = 20,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  description: string
  rows?: number
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
        rows={rows}
        spellCheck={false}
      />
    </div>
  )
}

function FormField({
  label,
  info,
  children,
}: {
  label: string
  info?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">{label}</label>
        {info && (
          <div className="group relative">
            <span className="cursor-default select-none text-[9px] text-charcoal-blue-300 hover:text-majorelle-blue-400">ⓘ</span>
            <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-52 -translate-x-1/2 rounded-lg bg-charcoal-blue-900 px-3 py-2 text-[10px] leading-relaxed text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">
              {info}
              <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-charcoal-blue-900" />
            </div>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

const inputCls = 'w-full rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50/60 px-2.5 py-1.5 text-xs font-medium text-charcoal-blue-900 placeholder:text-charcoal-blue-300 transition-all focus:border-majorelle-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-majorelle-blue-100'

type RunStage =
  | { type: 'idle' }
  | { type: 'generating_demand'; message: string }
  | { type: 'running_simulation'; message: string }
  | { type: 'error'; message: string }

export default function NewSimulationPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { userId, retailerAccountId } = useAuthStore()
  const routeAccountId = params.retailerAccountId as string

  // isScenarioPreset: wizard was launched from a specific scenario context (URL ?scenario=...)
  const urlScenario = (searchParams.get('scenario') as ScenarioId) ?? 'no_scenario'
  const isScenarioPreset = urlScenario !== 'no_scenario'

  const { setCache } = useSimulationStore()
  const [currentStep, setCurrentStep] = useState(0)
  const [formValues, setFormValues] = useState<RunFormValues>(DEFAULT_FORM)
  const [entityYaml, setEntityYaml] = useState('')
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId>(urlScenario)
  const [scenarioYaml, setScenarioYaml] = useState('')
  const [scenarioYamlError, setScenarioYamlError] = useState<string | null>(null)
  const [promoAdjustments, setPromoAdjustments] = useState<Record<string, number>>({})
  const [stage, setStage] = useState<RunStage>({ type: 'idle' })
  const [templateLoading, setTemplateLoading] = useState(true)

  const [promoPreview, setPromoPreview] = useState<SimulatePreviewResponse | null>(null)
  const [promoPreviewLoading, setPromoPreviewLoading] = useState(false)
  const [promoYaml, setPromoYaml] = useState('')
  const [promoYamlLoading, setPromoYamlLoading] = useState(false)
  const [promoYamlValid, setPromoYamlValid] = useState<boolean | null>(null)
  const [promoFilter, setPromoFilter] = useState<'active' | 'excluded' | 'all'>('active')

  const setField = <K extends keyof RunFormValues>(key: K, value: RunFormValues[K]) =>
    setFormValues(prev => ({ ...prev, [key]: value }))

  useEffect(() => {
    getRunYamlTemplate(routeAccountId)
      .then(({ yaml: tpl }) => {
        try {
          const parsed = yaml.load(tpl) as { run?: Record<string, unknown> }
          const run = parsed?.run ?? {}
          setFormValues({
            simulation_name: String(run.simulation_name ?? DEFAULT_FORM.simulation_name),
            notes: String(run.notes ?? ''),
            start_date: String(run.start_date ?? DEFAULT_FORM.start_date),
            end_date: String(run.end_date ?? DEFAULT_FORM.end_date),
            seed: Number(run.seed ?? DEFAULT_FORM.seed),
            store_target_wos: Number(run.store_target_wos ?? DEFAULT_FORM.store_target_wos),
            store_initial_wos: Number(run.store_initial_wos ?? DEFAULT_FORM.store_initial_wos),
            retailer_dc_target_wos: Number(run.retailer_dc_target_wos ?? DEFAULT_FORM.retailer_dc_target_wos),
            retailer_dc_initial_wos: Number(run.retailer_dc_initial_wos ?? DEFAULT_FORM.retailer_dc_initial_wos),
            supplier_dc_initial_wos: Number(run.supplier_dc_initial_wos ?? DEFAULT_FORM.supplier_dc_initial_wos),
            supplier_dc_to_retailer_dc_lead_weeks: Number(run.supplier_dc_to_retailer_dc_lead_weeks ?? DEFAULT_FORM.supplier_dc_to_retailer_dc_lead_weeks),
            retailer_dc_to_store_lead_weeks: Number(run.retailer_dc_to_store_lead_weeks ?? DEFAULT_FORM.retailer_dc_to_store_lead_weeks),
            supplier_otd_rate: Number(run.supplier_otd_rate ?? DEFAULT_FORM.supplier_otd_rate),
            supplier_in_full_rate: Number(run.supplier_in_full_rate ?? DEFAULT_FORM.supplier_in_full_rate),
            dc_otd_rate: Number(run.dc_otd_rate ?? DEFAULT_FORM.dc_otd_rate),
            dc_in_full_rate: Number(run.dc_in_full_rate ?? DEFAULT_FORM.dc_in_full_rate),
            disable_promo_decay: Boolean(run.disable_promo_decay ?? DEFAULT_FORM.disable_promo_decay),
          })
          const entityObj: Record<string, unknown> = {}
          if (run.dcs) entityObj.dcs = run.dcs
          if (run.suppliers) entityObj.suppliers = run.suppliers
          if (run.stores) entityObj.stores = run.stores
          if (Object.keys(entityObj).length > 0) setEntityYaml(yaml.dump(entityObj))
        } catch {
          // template parse failed — keep defaults
        }
      })
      .catch((err) => setStage({ type: 'error', message: `Failed to load template: ${err?.message ?? err}` }))
      .finally(() => setTemplateLoading(false))
  }, [])

  // Mode A: auto-generate scenario YAML template when scenario or promoPreview changes
  useEffect(() => {
    if (!isScenarioPreset) return
    const scenarioDef = SCENARIOS.find(s => s.id === selectedScenario)
    if (!scenarioDef) return

    if (selectedScenario === 'promo_forecast' && promoPreview?.promos?.length) {
      // Dynamic template: populate with actual promos from preview
      const lines = ['scenario_type: promo_forecast', 'promos:']
      for (const p of promoPreview.promos) {
        lines.push(`  - promo_name: ${p.promo_name}    # ${p.start_date} → ${p.end_date} | base: ${p.demand_multiplier}x`)
        lines.push(`    performance_adjustment: 0    # 0 to 200 (%)`)
        lines.push('')
      }
      setScenarioYaml(lines.join('\n'))
    } else {
      // Static template for all other scenarios (or promo_forecast fallback before preview loads)
      setScenarioYaml(scenarioDef.yamlTemplate)
    }
  }, [isScenarioPreset, selectedScenario, promoPreview])

  // Mode B: initialise per-promo adjustments state from promoPreview
  useEffect(() => {
    if (isScenarioPreset || selectedScenario !== 'promo_forecast') {
      setPromoAdjustments({})
      if (!isScenarioPreset) setScenarioYaml('')
      return
    }
    const initial: Record<string, number> = {}
    promoPreview?.promos?.forEach(p => { initial[p.promo_id] = 0 })
    setPromoAdjustments(initial)
  }, [isScenarioPreset, selectedScenario, promoPreview])

  // Mode B: rebuild scenarioYaml from promoAdjustments
  useEffect(() => {
    if (isScenarioPreset || selectedScenario !== 'promo_forecast') return
    const overrides = Object.entries(promoAdjustments).map(
      ([promo_id, performance_adjustment]) => ({ promo_id, performance_adjustment })
    )
    if (overrides.length === 0) { setScenarioYaml(''); return }
    setScenarioYaml(yaml.dump({ scenario_type: 'promo_forecast', promos: overrides }))
  }, [isScenarioPreset, promoAdjustments, selectedScenario])

  // Mode A: auto-generate scenario YAML template when scenario or promoPreview changes
  useEffect(() => {
    if (!isScenarioPreset) return
    const scenarioDef = SCENARIOS.find(s => s.id === selectedScenario)
    if (!scenarioDef) return

    if (selectedScenario === 'promo_forecast' && promoPreview?.promos?.length) {
      const lines = ['scenario_type: promo_forecast', 'promos:']
      for (const p of promoPreview.promos) {
        lines.push(`  - promo_name: ${p.promo_name}    # ${p.start_date} → ${p.end_date} | base: ${p.demand_multiplier}x`)
        lines.push(`    performance_adjustment: 0    # 0 to 200 (%)`)
        lines.push('')
      }
      setScenarioYaml(lines.join('\n'))
    } else {
      setScenarioYaml(scenarioDef.yamlTemplate)
    }
  }, [isScenarioPreset, selectedScenario, promoPreview])

  // Mode B: initialise per-promo adjustments state from promoPreview
  useEffect(() => {
    if (isScenarioPreset || selectedScenario !== 'promo_forecast') {
      setPromoAdjustments({})
      if (!isScenarioPreset) setScenarioYaml('')
      return
    }
    const initial: Record<string, number> = {}
    promoPreview?.promos?.forEach(p => { initial[p.promo_id] = 0 })
    setPromoAdjustments(initial)
  }, [isScenarioPreset, selectedScenario, promoPreview])

  // Mode B: rebuild scenarioYaml from promoAdjustments
  useEffect(() => {
    if (isScenarioPreset || selectedScenario !== 'promo_forecast') return
    const overrides = Object.entries(promoAdjustments).map(
      ([promo_id, performance_adjustment]) => ({ promo_id, performance_adjustment })
    )
    if (overrides.length === 0) { setScenarioYaml(''); return }
    setScenarioYaml(yaml.dump({ scenario_type: 'promo_forecast', promos: overrides }))
  }, [isScenarioPreset, promoAdjustments, selectedScenario])

  const hasScenario = selectedScenario !== 'no_scenario'
  const isRunning = stage.type === 'generating_demand' || stage.type === 'running_simulation'

  const totalVisualSteps = isScenarioPreset ? 4 : (hasScenario ? 5 : 4)
  const visualStep = isScenarioPreset ? currentStep : ((hasScenario || currentStep < 3) ? currentStep : currentStep - 1)

  const parseRunParams = () => ({
    start_date: formValues.start_date,
    end_date: formValues.end_date,
    seed: formValues.seed,
  })

  const buildFullYaml = (): string => {
    const accountId = routeAccountId || retailerAccountId
    const runBlock: Record<string, unknown> = {
      retailer_account_id: accountId,
      ...(userId ? { user_id: userId } : {}),
      ...formValues,
    }
    try {
      const entity = yaml.load(entityYaml) as Record<string, unknown>
      if (entity?.dcs) runBlock.dcs = entity.dcs
      if (entity?.suppliers) runBlock.suppliers = entity.suppliers
      if (entity?.stores) runBlock.stores = entity.stores
    } catch { /* invalid entity YAML — skip entity blocks */ }
    return yaml.dump({ run: runBlock })
  }

  const _loadPromoPreview = (start_date: string, end_date: string) => {
    setPromoPreviewLoading(true)
    getSimulatePreview(routeAccountId, start_date, end_date)
      .then(setPromoPreview).catch(() => {}).finally(() => setPromoPreviewLoading(false))
    if (!promoYaml) {
      setPromoYamlLoading(true)
      getPromoYamlTemplate(routeAccountId, start_date, end_date)
        .then(({ yaml: tpl }) => setPromoYaml(tpl)).catch(() => {}).finally(() => setPromoYamlLoading(false))
    }
  }

  const handleNext = () => {
    // Mode A: preset scenario — Config(0) → Promo(1) → Scenario YAML(2) → Review(3)
    if (isScenarioPreset) {
      if (currentStep === 0) {
        const { start_date, end_date } = parseRunParams()
        setCurrentStep(1)
        if (start_date && end_date) _loadPromoPreview(start_date, end_date)
      } else if (currentStep === 2) {
        try { yaml.load(scenarioYaml) }
        catch (e: unknown) {
          setScenarioYamlError(`YAML error: ${(e as Error).message}`)
          return
        }
        setCurrentStep(3)
      } else {
        setCurrentStep(s => s + 1)
      }
      return
    }
    // Mode B: no preset scenario — existing flow
    if (currentStep === 0) {
      const { start_date, end_date } = parseRunParams()
      setCurrentStep(1)
      if (start_date && end_date) _loadPromoPreview(start_date, end_date)
    } else if (currentStep === 2) {
      setCurrentStep(hasScenario ? 3 : 4)
    } else {
      setCurrentStep(s => s + 1)
    }
  }

  const handlePrev = () => {
    setStage({ type: 'idle' })
    if (isScenarioPreset) {
      setCurrentStep(s => s - 1)
      return
    }
    // Mode B
    if (currentStep === 4 && !hasScenario) {
      setCurrentStep(2)
    } else {
      setCurrentStep(s => s - 1)
    }
  }

  const handleRun = async () => {
    const { start_date, end_date } = parseRunParams()
    if (!start_date || !end_date) {
      setStage({ type: 'error', message: 'Start date and end date are required.' })
      return
    }
    const accountId = routeAccountId || retailerAccountId
    if (!accountId) {
      setStage({ type: 'error', message: 'No retailer account selected.' })
      return
    }

    // Flush any rawValues that are still pending (e.g. field was edited but form not re-rendered)
    const flushedValues = { ...formValues }
    for (const [k, raw] of Object.entries(rawValues)) {
      const n = parseFloat(raw as string)
      if (!isNaN(n)) (flushedValues as any)[k] = n
    }

    const finalYaml = buildFullYaml(flushedValues)

    try {
      setStage({ type: 'running_simulation', message: 'Running simulation…' })
      setElapsedSeconds(0)
      setSimProgress(null)
      timerRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000)

      // Generate sim ID upfront so we can open the SSE stream before the POST resolves
      const simId = crypto.randomUUID()
      const es = new EventSource(`${engineBaseUrl}/simulate-progress/${simId}`)
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data)
          if (d.done) { es.close(); return }
          if (d.total > 0) setSimProgress({ week: d.week, total: d.total, label: d.label ?? '' })
        } catch { /* ignore malformed */ }
      }
      es.onerror = () => es.close()

      const result = await runSimulation(finalYaml, promoYaml, hasScenario ? scenarioYaml : '', simId)
      es.close()
      setSimProgress(null)

      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      const { simulation_id, summary } = result
      const simName = formValues.simulation_name || 'Simulation Results'
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
          <div className="mt-2 inline-flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-50" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-charcoal-blue-400">Account</span>
            <span className="font-mono text-xs font-bold text-charcoal-blue-700">{routeAccountId || retailerAccountId}</span>
          </div>
        </div>

        <StepIndicator currentStep={visualStep} totalSteps={totalVisualSteps} />

        {/* Step 0 — Simulation Configuration form */}
        {currentStep === 0 && (
          <div className="mb-5">
            {templateLoading
              ? <div className="flex items-center justify-center py-16"><div className="h-6 w-6 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" /></div>
              : (
                <div className="space-y-3">

                  {/* Main card */}
                  <div className="overflow-hidden rounded-xl border border-charcoal-blue-100 bg-white shadow-sm">

                    {/* Simulation */}
                    <div className="px-4 py-3">
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="h-3 w-0.5 rounded-full bg-majorelle-blue-500" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-majorelle-blue-500">Simulation</span>
                      </div>
                      <div className="grid grid-cols-5 gap-2">
                        <FormField label="Name">
                          <input type="text" value={formValues.simulation_name}
                            onChange={e => setField('simulation_name', e.target.value)}
                            className={inputCls} placeholder="New Simulation Run" />
                        </FormField>
                        <FormField label="Notes">
                          <input type="text" value={formValues.notes}
                            onChange={e => setField('notes', e.target.value)}
                            className={inputCls} placeholder="Optional" />
                        </FormField>
                        <FormField label="Start Date">
                          <input type="date" value={formValues.start_date}
                            onChange={e => setField('start_date', e.target.value)}
                            className={inputCls} />
                        </FormField>
                        <FormField label="End Date">
                          <input type="date" value={formValues.end_date}
                            onChange={e => setField('end_date', e.target.value)}
                            className={inputCls} />
                        </FormField>
                        <FormField label="Seed">
                          <input type="number" value={formValues.seed}
                            onChange={e => setField('seed', Number(e.target.value))}
                            className={inputCls} />
                        </FormField>
                      </div>
                    </div>

                    <div className="mx-4 border-t border-charcoal-blue-100" />

                    {/* Supplier DC */}
                    <div className="px-4 py-3">
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="h-3 w-0.5 rounded-full bg-majorelle-blue-400" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-majorelle-blue-500">Supplier DC</span>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        <FormField label="Initial WOS" info="Opening weeks of supply for all Supplier DCs. Range: 1 – 12">
                          <input type="number" value={formValues.supplier_dc_initial_wos}
                            onChange={e => setField('supplier_dc_initial_wos', Number(e.target.value))}
                            className={inputCls} min={1} max={12} step={1} />
                        </FormField>
                        <FormField label="Lead → Retail DC" info="Transit time in weeks from Supplier DC to Retailer DC. Used to schedule inbound PO receipts.">
                          <input type="number" value={formValues.supplier_dc_to_retailer_dc_lead_weeks}
                            onChange={e => setField('supplier_dc_to_retailer_dc_lead_weeks', Number(e.target.value))}
                            className={inputCls} min={1} max={12} step={1} />
                        </FormField>
                        <FormField label="OTD Rate" info="On-Time Delivery rate — probability a supplier shipment arrives by the expected delivery date. Range: 0.0 – 1.0">
                          <input type="number" value={formValues.supplier_otd_rate}
                            onChange={e => setField('supplier_otd_rate', Number(e.target.value))}
                            className={inputCls} min={0} max={1} step={0.01} />
                        </FormField>
                        <FormField label="In-Full Rate" info="In-Full rate — probability the supplier delivers the complete ordered quantity. Range: 0.5 – 1.0">
                          <input type="number" value={formValues.supplier_in_full_rate}
                            onChange={e => setField('supplier_in_full_rate', Number(e.target.value))}
                            className={inputCls} min={0.5} max={1} step={0.01} />
                        </FormField>
                      </div>
                    </div>

                    <div className="mx-4 border-t border-charcoal-blue-100" />

                    {/* Retail DC */}
                    <div className="px-4 py-3">
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="h-3 w-0.5 rounded-full bg-emerald-500" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-600">Retail DC</span>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        <FormField label="Target WOS" info="Target weeks of supply for all Retailer DCs. Range: 1 – 12">
                          <input type="number" value={formValues.retailer_dc_target_wos}
                            onChange={e => setField('retailer_dc_target_wos', Number(e.target.value))}
                            className={inputCls} min={1} max={12} step={1} />
                        </FormField>
                        <FormField label="Initial WOS" info="Opening weeks of supply for all Retail DCs at simulation start. Range: 1 – 12">
                          <input type="number" value={formValues.retailer_dc_initial_wos}
                            onChange={e => setField('retailer_dc_initial_wos', Number(e.target.value))}
                            className={inputCls} min={1} max={12} step={1} />
                        </FormField>
                        <FormField label="Lead → Store" info="Transit time in weeks from Retailer DC to store. Used to schedule store replenishment receipts.">
                          <input type="number" value={formValues.retailer_dc_to_store_lead_weeks}
                            onChange={e => setField('retailer_dc_to_store_lead_weeks', Number(e.target.value))}
                            className={inputCls} min={1} max={12} step={1} />
                        </FormField>
                        <FormField label="OTD Rate" info="On-Time Delivery rate — probability a DC shipment arrives at the store by the expected date. Range: 0.0 – 1.0">
                          <input type="number" value={formValues.dc_otd_rate}
                            onChange={e => setField('dc_otd_rate', Number(e.target.value))}
                            className={inputCls} min={0} max={1} step={0.01} />
                        </FormField>
                        <FormField label="In-Full Rate" info="In-Full rate — probability a DC delivers the complete ordered quantity to stores. Range: 0.7 – 1.0">
                          <input type="number" value={formValues.dc_in_full_rate}
                            onChange={e => setField('dc_in_full_rate', Number(e.target.value))}
                            className={inputCls} min={0.7} max={1} step={0.01} />
                        </FormField>
                      </div>
                    </div>

                    <div className="mx-4 border-t border-charcoal-blue-100" />

                    {/* Store */}
                    <div className="px-4 py-3">
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="h-3 w-0.5 rounded-full bg-amber-400" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-amber-600">Store</span>
                      </div>
                      <div className="grid grid-cols-4 gap-2">
                        <FormField label="Target WOS" info="Store replenishment target in weeks of supply. Stores order when inventory falls below this level. Range: 1 – 8">
                          <input type="number" value={formValues.store_target_wos}
                            onChange={e => setField('store_target_wos', Number(e.target.value))}
                            className={inputCls} min={1} max={8} step={1} />
                        </FormField>
                        <FormField label="Initial WOS" info="Opening weeks of supply for all stores at simulation start. Range: 1 – 8">
                          <input type="number" value={formValues.store_initial_wos}
                            onChange={e => setField('store_initial_wos', Number(e.target.value))}
                            className={inputCls} min={1} max={8} step={1} />
                        </FormField>
                      </div>
                    </div>
                  </div>

                  {/* Entity overrides */}
                  <div className="overflow-hidden rounded-xl border border-charcoal-blue-100 bg-white shadow-sm">
                    <div className="flex items-center gap-2 border-b border-charcoal-blue-100 bg-charcoal-blue-50 px-4 py-2">
                      <Code size={12} className="text-charcoal-blue-400" />
                      <span className="text-[10px] font-bold uppercase tracking-widest text-charcoal-blue-500">Entity Overrides</span>
                      <span className="ml-auto text-[9px] text-charcoal-blue-400">dcs · suppliers · stores</span>
                    </div>
                    <textarea
                      value={entityYaml}
                      onChange={e => setEntityYaml(e.target.value)}
                      className="w-full bg-white px-4 py-3 font-mono text-xs text-charcoal-blue-950 focus:outline-none"
                      rows={12}
                      spellCheck={false}
                      placeholder="# dcs:\n#   DC_EAST:\n#     otd_rate: 0.95"
                    />
                  </div>
                </div>
              )
            }
          </div>
        )}

        {/* Step 1 — Promo Preview + Promo Overrides */}
        {currentStep === 1 && (
          <div className="mb-5 space-y-3">
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
                    {([
                      { value: 'active' as const,   count: promoPreview.active_promos,          label: 'Active Promos' },
                      { value: 'excluded' as const, count: promoPreview.excluded_promos.length, label: 'Excluded' },
                      { value: 'all' as const,      count: promoPreview.total_promos,           label: 'Total in Account' },
                    ]).map(({ value, count, label }) => (
                      <button
                        key={value}
                        onClick={() => setPromoFilter(value)}
                        className={cn(
                          'rounded-lg p-2 text-center transition-colors',
                          promoFilter === value
                            ? 'bg-majorelle-blue-50 ring-1 ring-majorelle-blue-300'
                            : 'bg-charcoal-blue-50 hover:bg-charcoal-blue-100'
                        )}
                      >
                        <p className={cn('text-lg font-black', promoFilter === value ? 'text-majorelle-blue-600' : 'text-charcoal-blue-950')}>{count}</p>
                        <p className="text-[9px] font-semibold text-charcoal-blue-400">{label}</p>
                      </button>
                    ))}
                  </div>
                  <Tabs value={promoFilter} onValueChange={(v) => setPromoFilter(v as typeof promoFilter)}>
                    {([
                      { value: 'active', promos: promoPreview.promos, emptyLabel: 'No promos active in this date range' },
                      { value: 'excluded', promos: promoPreview.excluded_promos, emptyLabel: 'No promos excluded — all promos fall within this window' },
                      { value: 'all', promos: [...promoPreview.promos, ...promoPreview.excluded_promos].sort((a, b) => a.start_date.localeCompare(b.start_date)), emptyLabel: 'No promos found in account' },
                    ] as const).map(({ value, promos, emptyLabel }) => (
                      <TabsContent key={value} value={value} className="mt-0">
                        {promos.length === 0 ? (
                          <div className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 p-4 text-center">
                            <Tag size={20} className="mx-auto mb-1.5 text-charcoal-blue-300" />
                            <p className="text-xs font-semibold text-charcoal-blue-950">{emptyLabel}</p>
                          </div>
                        ) : (
                          <div className="overflow-hidden rounded-lg border border-charcoal-blue-200">
                            <div className="max-h-48 overflow-y-auto">
                              <table className="w-full text-xs">
                                <thead className="sticky top-0 bg-charcoal-blue-50">
                                  <tr>
                                    {['Promo Name', 'Event Type', 'Dates', 'Uplift'].map(h => (
                                      <th key={h} className="px-2 py-1.5 text-left font-bold uppercase tracking-wide text-charcoal-blue-400 text-[9px]">{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-charcoal-blue-100">
                                  {promos.map(p => (
                                    <tr key={p.promo_id} className="bg-white hover:bg-charcoal-blue-50">
                                      <td className="px-2 py-1 font-semibold text-charcoal-blue-950">{p.promo_name}</td>
                                      <td className="px-2 py-1">
                                        <span className="rounded bg-majorelle-blue-50 px-1 py-0.5 font-bold text-majorelle-blue-600">{p.event_type || '—'}</span>
                                      </td>
                                      <td className="px-2 py-1 whitespace-nowrap text-charcoal-blue-400">{p.start_date} → {p.end_date}</td>
                                      <td className="px-2 py-1 text-center font-bold text-emerald-600">{p.demand_multiplier}×</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </TabsContent>
                    ))}
                  </Tabs>
                </>
              )}
              {!promoPreviewLoading && !promoPreview && (
                <p className="text-[10px] text-amber-700">Could not load preview — simulation will use promos from database.</p>
              )}
            </div>

            <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
              <div className="mb-3">
                <h3 className="text-sm font-bold text-charcoal-blue-950">Promo Overrides</h3>
                <p className="text-[10px] text-charcoal-blue-400">Optionally override start date, end date, or demand multiplier for any baseline promo — this run only. Leave empty to use promos as stored.</p>
              </div>
              <label className="mb-3 flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={formValues.disable_promo_decay}
                  onChange={e => setField('disable_promo_decay', e.target.checked)}
                  className="h-4 w-4 rounded border-charcoal-blue-300 accent-majorelle-blue-500"
                />
                <span className="text-xs font-medium text-charcoal-blue-800">Disable post-promo demand decay</span>
                <div className="group relative">
                  <span className="cursor-default select-none text-[9px] text-charcoal-blue-300 hover:text-majorelle-blue-400">ⓘ</span>
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-lg bg-charcoal-blue-900 px-3 py-2 text-[10px] leading-relaxed text-white opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100">
                    After a promo ends, demand gradually tapers back to baseline over the next <strong>28 days (4 weeks)</strong> by default — simulating the real-world effect where shoppers stock up during a promo and buy less immediately after. Checking this box removes that tail and demand returns to normal instantly at the end of the promo window.
                    <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-charcoal-blue-900" />
                  </div>
                </div>
              </label>
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

        {/* Mode A — Step 2: Scenario YAML editor (any preset scenario from URL) */}
        {isScenarioPreset && currentStep === 2 && (() => {
          const scenarioDef = SCENARIOS.find(s => s.id === selectedScenario)
          const isPromoLoading = selectedScenario === 'promo_forecast' && promoPreviewLoading
          return (
            <div className="mb-5 space-y-3">
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <h3 className="text-sm font-bold text-charcoal-blue-950">Scenario YAML</h3>
                  {scenarioDef && (
                    <span className="rounded-full border border-majorelle-blue-200 px-2 py-0.5 text-[9px] font-semibold text-majorelle-blue-500">
                      {scenarioDef.title}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-charcoal-blue-400">
                  {scenarioDef?.yamlEditorDescription ?? 'Configure the scenario parameters below.'}
                </p>
              </div>
              {isPromoLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                </div>
              ) : (
                <YamlEditor
                  value={scenarioYaml}
                  onChange={v => { setScenarioYaml(v); setScenarioYamlError(null) }}
                  label={scenarioDef?.yamlEditorLabel ?? 'Scenario YAML'}
                  description={scenarioDef?.yamlEditorDescription ?? ''}
                  rows={Math.max(12, scenarioYaml.split('\n').length + 2)}
                />
              )}
              {scenarioYamlError && (
                <p className="mt-1.5 flex items-center gap-1 text-[10px] text-rose-600">
                  <AlertCircle size={11} /> {scenarioYamlError}
                </p>
              )}
            </div>
          )
        })()}

        {/* Mode B — Step 2: Scenario selection (no preset scenario) */}
        {!isScenarioPreset && currentStep === 2 && (
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
                    {!isNoScenario && s.id !== 'promo_forecast' && (
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

        {/* Mode B — Step 3: Promo performance adjustments (slider UI, non-preset path only) */}
        {!isScenarioPreset && currentStep === 3 && selectedScenario === 'promo_forecast' && (
          <div className="mb-5 space-y-4">
            <div>
              <h3 className="mb-1 text-sm font-bold text-charcoal-blue-950">Promo Performance Adjustments</h3>
              <p className="text-[10px] text-charcoal-blue-400">
                Set how each active promotion will over- or under-perform relative to its forecast.
                0% = no change. Positive = better than expected; negative = worse than expected.
              </p>
            </div>

            {promoPreviewLoading ? (
              <div className="flex items-center justify-center py-10">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
              </div>
            ) : promoPreview?.promos?.length ? (
              <div className="space-y-2">
                {promoPreview.promos.map(p => {
                  const adj = promoAdjustments[p.promo_id] ?? 0
                  const factor = 1 + adj / 100
                  const effectiveMultiplier = (p.demand_multiplier * factor).toFixed(2)
                  return (
                    <div key={p.promo_id} className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-bold text-charcoal-blue-950">{p.promo_name}</p>
                          <p className="text-[10px] text-charcoal-blue-400">
                            {p.start_date} → {p.end_date} · {p.store_count} stores · {p.item_count} items
                          </p>
                        </div>
                        <span className="rounded-full border border-majorelle-blue-200 px-2 py-0.5 text-[9px] font-semibold text-majorelle-blue-500 whitespace-nowrap">
                          {p.event_type || 'Promo'}
                        </span>
                      </div>

                      <div className="mb-3 flex items-center gap-3 text-[10px] text-charcoal-blue-500">
                        <span>Base uplift: <strong className="text-charcoal-blue-800">{p.demand_multiplier}×</strong></span>
                        <span className="text-charcoal-blue-300">→</span>
                        <span>Effective: <strong className={adj > 0 ? 'text-emerald-600' : adj < 0 ? 'text-rose-600' : 'text-charcoal-blue-800'}>
                          {effectiveMultiplier}×
                        </strong></span>
                        {adj !== 0 && (
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${adj > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                            {adj > 0 ? `+${adj}%` : `${adj}%`}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <input
                          type="range" min={-100} max={200} step={5}
                          value={adj}
                          onChange={e => setPromoAdjustments(prev => ({ ...prev, [p.promo_id]: Number(e.target.value) }))}
                          className="flex-1 accent-majorelle-blue-500"
                        />
                        <div className="flex items-center gap-1">
                          <input
                            type="number" min={-100} max={200} step={1}
                            value={adj}
                            onChange={e => setPromoAdjustments(prev => ({ ...prev, [p.promo_id]: Number(e.target.value) }))}
                            className="w-16 rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 px-2 py-1 text-center text-xs font-bold text-charcoal-blue-900 focus:border-majorelle-blue-400 focus:outline-none"
                          />
                          <span className="text-xs text-charcoal-blue-400">%</span>
                        </div>
                        {adj !== 0 && (
                          <button
                            onClick={() => setPromoAdjustments(prev => ({ ...prev, [p.promo_id]: 0 }))}
                            className="text-[10px] font-semibold text-charcoal-blue-400 hover:text-charcoal-blue-700"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50 p-6 text-center">
                <TrendingUp size={20} className="mx-auto mb-2 text-charcoal-blue-300" />
                <p className="text-xs font-semibold text-charcoal-blue-700">No active promos in this date range</p>
                <p className="mt-1 text-[10px] text-charcoal-blue-400">
                  Go back to step 1 and adjust the simulation dates to include promotional periods.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Step 4 (Mode B) / Step 3 (Mode A) — Review & Run */}
        {(currentStep === 4 || (isScenarioPreset && currentStep === 3)) && (
          <div className="mb-5 rounded-xl border border-charcoal-blue-200 bg-white p-5 shadow-sm">
            <h3 className="mb-4 text-base font-bold text-charcoal-blue-950">Review & Run</h3>
            <div className="mb-4 space-y-2">
              <div className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 p-3">
                <p className="text-xs font-semibold text-charcoal-blue-950">Simulation</p>
                <p className="mt-0.5 text-[10px] text-charcoal-blue-400">
                  {formValues.simulation_name} · {formValues.start_date} → {formValues.end_date} · seed {formValues.seed}
                </p>
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
          {(isScenarioPreset ? currentStep < 3 : currentStep < 4)
            ? <button
                onClick={handleNext}
                className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold transition-all bg-majorelle-blue-500 text-white hover:bg-majorelle-blue-600"
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
