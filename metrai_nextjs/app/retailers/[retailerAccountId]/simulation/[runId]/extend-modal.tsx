'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import {
  getRunConfig,
  generateDemand, getDemandStatus, getDemandWeeklyTotals,
  extendSimulation, saveExtensionPromos, generateExtensionDemand,
} from '@/lib/api/simulation'
import { getSimulatePreview, getPromos } from '@/lib/api/promos'
import { useSimulationStore } from '@/lib/store/simulationStore'
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog'
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { Check, AlertCircle, Code, Tag, ArrowRight, ChevronLeft, ChevronRight, Plus, Pencil, Trash2, Search, X } from 'lucide-react'
import yaml from 'js-yaml'
import type { SimulatePreviewResponse, RunConfig, PromoResponse } from '@/lib/api/types'
import { SCENARIOS, type ScenarioId } from '@/lib/scenarios'

// ── Shared UI primitives ──────────────────────────────────────────────────────

function StepIndicator({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {Array.from({ length: totalSteps }).map((_, idx) => (
        <div key={idx} className="flex items-center">
          <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all ${
            idx < currentStep ? 'bg-emerald-500 text-white' : idx === currentStep ? 'bg-majorelle-blue-500 text-white' : 'bg-charcoal-blue-200 text-charcoal-blue-400'
          }`}>
            {idx < currentStep ? <Check size={13} /> : idx + 1}
          </div>
          {idx < totalSteps - 1 && <div className={`mx-1 h-0.5 w-6 ${idx < currentStep ? 'bg-emerald-500' : 'bg-charcoal-blue-200'}`} />}
        </div>
      ))}
      <span className="ml-auto text-[10px] font-semibold text-charcoal-blue-400">Step {currentStep + 1} of {totalSteps}</span>
    </div>
  )
}

function FormField({ label, info, children }: { label: string; info?: string; children: React.ReactNode }) {
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

// ISO week helper: "2024-12-31" → "2024-W53"
function toIsoWeek(dateStr: string): string {
  const d = new Date(dateStr)
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const weekNum = Math.ceil(
    ((d.getTime() - jan4.getTime()) / 86400000 + (jan4.getDay() || 7)) / 7
  )
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
}


interface ScheduledPromo {
  clientId: string
  promo_id: string
  promo_name: string
  promo_group_name: string
  event_type: string
  store_count: number
  item_count: number
  original_start_date: string
  original_end_date: string
  original_multiplier: number
  start_date: string
  end_date: string
  demand_multiplier: number
  disabled: boolean
}

function buildPromoYaml(scheduled: ScheduledPromo[]): string {
  const overrides = scheduled
    .filter(s =>
      s.disabled ||
      s.start_date !== s.original_start_date ||
      s.end_date !== s.original_end_date ||
      s.demand_multiplier !== s.original_multiplier
    )
    .map(s => ({
      promo_name: s.promo_name,
      ...(s.disabled ? { demand_multiplier: 1.0 } : {
        ...(s.start_date !== s.original_start_date && { start_date: s.start_date }),
        ...(s.end_date !== s.original_end_date && { end_date: s.end_date }),
        ...(s.demand_multiplier !== s.original_multiplier && { demand_multiplier: s.demand_multiplier }),
      }),
    }))
  return overrides.length ? yaml.dump({ promos: overrides }) : ''
}

type RunStage = { type: 'idle' } | { type: 'running'; message: string } | { type: 'error'; message: string }
const TOTAL_STEPS = 5

// ── Modal ─────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
  baseSimulationId: string
}

export function ExtendForecastModal({ open, onClose, baseSimulationId }: Props) {
  const params = useParams()
  const router = useRouter()
  const { userId, retailerAccountId } = useAuthStore()
  const routeAccountId = params.retailerAccountId as string
  const { clearCache } = useSimulationStore()

  // ── State ──────────────────────────────────────────────────────────────────
  const [sessionId] = useState<string>(() => crypto.randomUUID())
  const [baseConfig, setBaseConfig] = useState<RunConfig | null>(null)
  const [loadingBase, setLoadingBase] = useState(false)
  const [loadBaseError, setLoadBaseError] = useState('')

  // Step 0
  const [extensionEndDate, setExtensionEndDate] = useState('')
  const [simulationName, setSimulationName] = useState('')
  const [notes, setNotes] = useState('')

  // Step 1
  const [promoPreview, setPromoPreview] = useState<SimulatePreviewResponse | null>(null)
  const [promoPreviewLoading, setPromoPreviewLoading] = useState(false)
  const [scheduledPromos, setScheduledPromos] = useState<ScheduledPromo[]>([])
  const [catalogPromos, setCatalogPromos] = useState<PromoResponse[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [showAddPanel, setShowAddPanel] = useState(false)
  const [promoSearch, setPromoSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('all')
  const [addingPromo, setAddingPromo] = useState<PromoResponse | null>(null)
  const [addForm, setAddForm] = useState({ start_date: '', end_date: '', demand_multiplier: 1.0 })
  const [editingClientId, setEditingClientId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ start_date: '', end_date: '', demand_multiplier: 1.0 })

  // Step 2 — demand generation
  const [demandStatus, setDemandStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const [demandRows, setDemandRows] = useState<number | null>(null)
  const [chartData, setChartData] = useState<{ week: string; base?: number; ext?: number }[]>([])
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Step 3 — scenario
  const [selectedScenario, setSelectedScenario] = useState<ScenarioId>('no_scenario')
  const [scenarioYaml, setScenarioYaml] = useState('')
  const [scenarioYamlError, setScenarioYamlError] = useState<string | null>(null)
  const [promoAdjustments, setPromoAdjustments] = useState<Record<string, number>>({})

  const [currentStep, setCurrentStep] = useState(0)
  const [stage, setStage] = useState<RunStage>({ type: 'idle' })

  // ── Derived ────────────────────────────────────────────────────────────────
  const baseFull = (baseConfig?.full_config as any) ?? {}
  const baseName: string = baseFull?.simulation_name ?? 'Base Simulation'
  // Prefer end_week from simulation_config (updated after each extension) over full_config.end_date (original only)
  const baseEndDate: string = (baseConfig?.end_week ?? baseFull?.end_date ?? '') as string
  const baseSeed: number = baseFull?.seed ?? 42
  const baseEndWeek = baseEndDate ? toIsoWeek(baseEndDate) : ''
  // Minimum valid extension end date: must be strictly after the base simulation's end date
  const minExtensionDate = baseEndDate
    ? (() => {
        const d = new Date(baseEndDate)
        d.setDate(d.getDate() + 1)
        return d.toISOString().slice(0, 10)
      })()
    : undefined
  const hasScenario = selectedScenario !== 'no_scenario'
  const scenarioDef = SCENARIOS.find(s => s.id === selectedScenario)

  // ── Load base config + ending inventory when modal opens ──────────────────
  useEffect(() => {
    if (!open) return
    setLoadingBase(true)
    setLoadBaseError('')
    setCurrentStep(0)
    setStage({ type: 'idle' })
    setDemandStatus('idle')
    setChartData([])
    setScheduledPromos([])
    setCatalogPromos([])
    setShowAddPanel(false)
    setPromoSearch('')
    setGroupFilter('all')
    setAddingPromo(null)
    setEditingClientId(null)
    getRunConfig(baseSimulationId)
      .then(cfg => {
        setBaseConfig(cfg)
        const cfgFull = cfg.full_config as any
        setSimulationName(cfgFull?.simulation_name ?? 'Simulation')
        // Pre-fill extension date to day after base end so calendar opens at the right month
        if (cfgFull?.end_date) {
          const d = new Date(cfgFull.end_date)
          d.setDate(d.getDate() + 1)
          setExtensionEndDate(d.toISOString().slice(0, 10))
        }
        setNotes(cfgFull?.notes ?? '')
        // Always use promo_forecast — the YAML editor in Step 3 is pre-populated from scheduled promos
        setSelectedScenario('promo_forecast')
      })
      .catch(err => setLoadBaseError(err?.response?.data?.detail ?? err?.message ?? 'Failed to load base simulation'))
      .finally(() => setLoadingBase(false))
  }, [open, baseSimulationId])

  // Clear poll timer on unmount / close
  useEffect(() => {
    if (!open && pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [open])

  // ── Scenario YAML auto-generation ─────────────────────────────────────────
  // Initialise adjustments from scheduledPromos (keyed by clientId, preserving existing values)
  useEffect(() => {
    if (selectedScenario !== 'promo_forecast') {
      setPromoAdjustments({})
      setScenarioYaml('')
      return
    }
    setPromoAdjustments(prev => {
      const next: Record<string, number> = {}
      scheduledPromos.filter(s => !s.disabled).forEach(s => {
        next[s.clientId] = prev[s.clientId] ?? 0
      })
      return next
    })
  }, [selectedScenario, scheduledPromos])

  // Build scenario YAML from scheduledPromos using promo_name (as the engine expects)
  useEffect(() => {
    if (selectedScenario !== 'promo_forecast') return
    const activePromos = scheduledPromos.filter(s => !s.disabled)
    if (!activePromos.length) { setScenarioYaml(''); return }
    setScenarioYaml(yaml.dump({
      scenario_type: 'promo_forecast',
      promos: activePromos.map(s => ({
        promo_name: s.promo_name,
        performance_adjustment: promoAdjustments[s.clientId] ?? 0,
      })),
    }))
  }, [promoAdjustments, selectedScenario, scheduledPromos])

  // ── Demand generation (triggered on entering step 2) ──────────────────────
  const startDemandGeneration = async () => {
    if (!baseEndDate || !extensionEndDate) return
    setDemandStatus('generating')
    const accountId = routeAccountId || retailerAccountId || ''
    try {
      // 1. Save scheduled promos to DB for this session
      await saveExtensionPromos(
        baseSimulationId,
        sessionId,
        accountId,
        scheduledPromos.map(sp => ({
          promo_id: sp.promo_id || undefined,
          promo_name: sp.promo_name,
          promo_group_name: sp.promo_group_name,
          event_type: sp.event_type,
          start_date: sp.start_date,
          end_date: sp.end_date,
          demand_multiplier: sp.demand_multiplier,
          is_disabled: sp.disabled,
        })),
      )

      // 2. Trigger demand generation using stored promo schedules
      const { job_id } = await generateExtensionDemand({
        session_id: sessionId,
        simulation_id: baseSimulationId,
        retailer_account_id: accountId,
        start_date: baseEndDate,
        end_date: extensionEndDate,
        seed: baseSeed,
      })

      const poll = async () => {
        try {
          const status = await getDemandStatus(job_id)
          if (status.status === 'COMPLETED') {
            setDemandRows(status.demand_rows ?? null)
            await loadDemandChart(
              status.start_week ?? toIsoWeek(baseEndDate),
              status.end_week ?? toIsoWeek(extensionEndDate),
            )
            setDemandStatus('done')
          } else if (status.status === 'FAILED') {
            setDemandStatus('error')
          } else {
            pollRef.current = setTimeout(poll, 2000)
          }
        } catch {
          setDemandStatus('error')
        }
      }
      poll()
    } catch (err: unknown) {
      setDemandStatus('error')
    }
  }

  const loadDemandChart = async (extStartWeek: string, extEndWeek: string) => {
    const accountId = routeAccountId || retailerAccountId || ''
    // Base sim demand: read last 8 weeks from weekly_demand table (same source as extension)
    const baseSimStartWeek = toIsoWeek(baseFull?.start_date ?? '')
    const baseSimEndWeek   = toIsoWeek(baseEndDate)

    const [baseDemand, extDemand] = await Promise.all([
      baseSimStartWeek
        ? getDemandWeeklyTotals(accountId, baseSimStartWeek, baseSimEndWeek, baseSeed).catch(() => [])
        : Promise.resolve([]),
      getDemandWeeklyTotals(accountId, extStartWeek, extEndWeek, baseSeed).catch(() => []),
    ])

    const rows: { week: string; base?: number; ext?: number }[] = []

    // Last 8 weeks of base sim demand (from weekly_demand table)
    const lastBase = baseDemand.slice(-8)
    for (const r of lastBase) {
      rows.push({ week: r.pos_week, base: r.demand_qty })
    }

    // All extension demand weeks (from weekly_demand table)
    for (const r of extDemand) {
      rows.push({ week: r.pos_week, ext: r.demand_qty })
    }

    setChartData(rows)
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  const handleNext = () => {
    if (currentStep === 0) {
      if (!extensionEndDate) {
        setStage({ type: 'error', message: 'Please set an extension end date.' })
        return
      }
      if (baseEndDate && extensionEndDate <= baseEndDate) {
        setStage({ type: 'error', message: `Extension end date must be after the base simulation's end date (${baseEndDate}).` })
        return
      }
      setStage({ type: 'idle' })
      setCurrentStep(1)
      // Load preview + catalog in parallel
      setPromoPreviewLoading(true)
      getSimulatePreview(routeAccountId, baseEndDate, extensionEndDate)
        .then(preview => {
          setPromoPreview(preview)
          // Auto-populate scheduled promos from active promos in the extension window
          setScheduledPromos(preview.promos.map(p => ({
            clientId: crypto.randomUUID(),
            promo_id: p.promo_id,
            promo_name: p.promo_name,
            promo_group_name: '',
            event_type: p.event_type,
            store_count: p.store_count,
            item_count: p.item_count,
            original_start_date: p.start_date,
            original_end_date: p.end_date,
            original_multiplier: p.demand_multiplier,
            start_date: p.start_date,
            end_date: p.end_date,
            demand_multiplier: p.demand_multiplier,
            disabled: false,
          })))
        })
        .catch(() => {})
        .finally(() => setPromoPreviewLoading(false))
      setCatalogLoading(true)
      getPromos(routeAccountId)
        .then(catalog => {
          setCatalogPromos(catalog)
          // Back-fill promo_group_name into scheduled promos
          setScheduledPromos(prev =>
            prev.map(sp => {
              const found = catalog.find(c => c.promo_id === sp.promo_id)
              return found ? { ...sp, promo_group_name: found.promo_group_name ?? '' } : sp
            })
          )
        })
        .catch(() => {})
        .finally(() => setCatalogLoading(false))
    } else if (currentStep === 1) {
      setCurrentStep(2)
      if (demandStatus === 'idle') startDemandGeneration()
    } else if (currentStep === 2) {
      if (demandStatus !== 'done') {
        setStage({ type: 'error', message: 'Please wait for demand generation to complete before proceeding.' })
        return
      }
      setStage({ type: 'idle' })
      setCurrentStep(3)
    } else if (currentStep === 3) {
      if (hasScenario && scenarioYaml) {
        try { yaml.load(scenarioYaml) }
        catch (e: unknown) {
          setScenarioYamlError(`YAML error: ${(e as Error).message}`)
          return
        }
      }
      setCurrentStep(4)
    } else {
      setCurrentStep(s => s + 1)
    }
  }

  const handlePrev = () => {
    setStage({ type: 'idle' })
    setCurrentStep(s => s - 1)
  }

  // ── Run ────────────────────────────────────────────────────────────────────
  const handleRun = async () => {
    try {
      setStage({ type: 'running', message: 'Running extended simulation…' })
      const result = await extendSimulation(baseSimulationId, {
        extension_end_date: extensionEndDate,
        simulation_name: simulationName || undefined,
        notes: notes || undefined,
        session_id: sessionId,
        scenario_yaml: (hasScenario && scenarioYaml) ? scenarioYaml : undefined,
      })
      // Clear stale cache and hard-navigate to the same URL.
      // router.refresh() keeps client state alive (extensions stays []), so the
      // extension color highlights never appear without a manual refresh.
      // router.push() remounts the component, resetting all state so extensions
      // are fetched fresh and Cell colors apply immediately.
      clearCache()
      onClose()
      router.push(`/retailers/${routeAccountId}/simulation/${baseSimulationId}`)
    } catch (err: unknown) {
      const detail = (err as any)?.response?.data?.detail
      setStage({ type: 'error', message: detail ?? (err instanceof Error ? err.message : 'An error occurred.') })
    }
  }

  const isRunning = stage.type === 'running'

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isRunning) onClose() }}>
      <DialogContent className="max-w-3xl w-full max-h-[90vh] overflow-y-auto p-0 gap-0">
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-charcoal-blue-100 bg-white px-6 pt-5 pb-3 rounded-t-xl">
          <DialogTitle className="text-xl font-black tracking-tight text-charcoal-blue-950">Extend Forecast</DialogTitle>
          <p className="mt-0.5 text-xs text-charcoal-blue-400">Continue this simulation forward in time</p>
          {baseConfig && (
            <div className="mt-1.5 inline-flex items-center gap-2 rounded-full border border-charcoal-blue-200 bg-charcoal-blue-50 px-3 py-1">
              <span className="text-[9px] font-bold uppercase tracking-widest text-charcoal-blue-400">Base</span>
              <span className="text-xs font-bold text-charcoal-blue-700">{baseName}</span>
              {baseEndWeek && <><span className="text-charcoal-blue-300">·</span><span className="font-mono text-[10px] text-charcoal-blue-500">ends {baseEndWeek}</span></>}
            </div>
          )}
          <div className="mt-3">
            <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 bg-white">

          {/* Loading base */}
          {loadingBase && (
            <div className="flex items-center justify-center py-20">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
            </div>
          )}

          {loadBaseError && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
              <AlertCircle size={14} /> {loadBaseError}
            </div>
          )}

          {!loadingBase && !loadBaseError && (
            <>
              {/* ── Step 0: Extension Details ──────────────────────────── */}
              {currentStep === 0 && (
                <div className="space-y-3">
                  {baseConfig && (
                    <div className="rounded-xl border border-charcoal-blue-100 bg-charcoal-blue-50 p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="h-3 w-0.5 rounded-full bg-charcoal-blue-400" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-charcoal-blue-500">Base Simulation</span>
                      </div>
                      <div className="grid grid-cols-3 gap-3 text-xs">
                        <div>
                          <p className="text-[9px] font-semibold uppercase text-charcoal-blue-400">Name</p>
                          <p className="font-bold text-charcoal-blue-950">{baseName}</p>
                        </div>
                        <div>
                          <p className="text-[9px] font-semibold uppercase text-charcoal-blue-400">Period</p>
                          <p className="font-mono font-bold text-charcoal-blue-950">{baseFull?.start_date ?? '?'} → {baseFull?.end_date ?? '?'}</p>
                        </div>
                        <div>
                          <p className="text-[9px] font-semibold uppercase text-charcoal-blue-400">Ending Inventory</p>
                          <p className="font-bold text-emerald-600">✓ Loaded from server</p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="overflow-hidden rounded-xl border border-charcoal-blue-100 bg-white shadow-sm">
                    <div className="px-4 pt-4 pb-3">
                      <div className="mb-2.5 flex items-center gap-2">
                        <span className="h-3 w-0.5 rounded-full bg-majorelle-blue-500" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-majorelle-blue-500">Extension Details</span>
                      </div>
                      <div className="grid grid-cols-[1fr_1.5fr_1.5fr] gap-3 items-start">
  <FormField label="Extension End Date">
    <input
      type="date"
      value={extensionEndDate}
      min={minExtensionDate}
      onChange={e => setExtensionEndDate(e.target.value)}
      className={inputCls}
    />
  </FormField>

  <FormField label="Name">
    <input
      type="text"
      value={simulationName}
      onChange={e => setSimulationName(e.target.value)}
      className={inputCls}
      placeholder="Simulation name"
    />
  </FormField>

  <FormField label="Notes">
    <input
      type="text"
      value={notes}
      onChange={e => setNotes(e.target.value)}
      className={inputCls}
      placeholder="Optional"
    />
  </FormField>
</div>
                    </div>
                    {baseEndDate && extensionEndDate && (
                      <div className="mx-4 mb-4 flex items-center gap-2 rounded-lg border border-majorelle-blue-100 bg-majorelle-blue-50 px-3 py-2">
                        <span className="font-mono text-xs font-bold text-majorelle-blue-700">{baseEndDate}</span>
                        <ArrowRight size={12} className="text-majorelle-blue-400" />
                        <span className="font-mono text-xs font-bold text-majorelle-blue-700">{extensionEndDate}</span>
                        <span className="ml-1 text-[10px] text-majorelle-blue-500">extension period</span>
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-[10px] text-emerald-800">
                    <strong>Inventory seeded from base:</strong> All stores, retailer DCs, and supplier DCs will start with the actual ending quantities from <em>{baseName}</em> — not estimated WOS targets.
                  </div>
                </div>
              )}

              {/* ── Step 1: Promotion Schedule ──────────────────────────── */}
              {currentStep === 1 && (
                <div className="space-y-3">
                  {promoPreviewLoading && (
                    <div className="flex items-center justify-center py-6">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                    </div>
                  )}

                  {/* ── Scheduled Promotions ─────────────────────────── */}
                  <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-charcoal-blue-950">Scheduled Promotions</h3>
                        <p className="text-[10px] text-charcoal-blue-400">
                          {scheduledPromos.length > 0
                            ? `${scheduledPromos.filter(s => !s.disabled).length} active · ${scheduledPromos.filter(s => s.disabled).length} disabled`
                            : 'No promotions scheduled for this extension period'}
                        </p>
                      </div>
                      <button
                        onClick={() => { setShowAddPanel(v => !v); setAddingPromo(null); setPromoSearch(''); setGroupFilter('all') }}
                        className="inline-flex items-center gap-1 rounded-full bg-majorelle-blue-500 px-3 py-1.5 text-[11px] font-bold text-white transition-all hover:bg-majorelle-blue-600"
                      >
                        <Plus size={12} /> Add Promotion
                      </button>
                    </div>

                    {/* Scheduled list */}
                    {scheduledPromos.length === 0 && !promoPreviewLoading && (
                      <div className="rounded-lg border border-dashed border-charcoal-blue-200 bg-charcoal-blue-50 p-4 text-center">
                        <Tag size={18} className="mx-auto mb-1.5 text-charcoal-blue-300" />
                        <p className="text-xs text-charcoal-blue-400">No promotions are currently scheduled. Add one from the catalog.</p>
                      </div>
                    )}

                    <div className="space-y-2">
                      {scheduledPromos.map(sp => {
                        const isEditing = editingClientId === sp.clientId
                        const isModified = !sp.disabled && (
                          sp.start_date !== sp.original_start_date ||
                          sp.end_date !== sp.original_end_date ||
                          sp.demand_multiplier !== sp.original_multiplier
                        )
                        return (
                          <div key={sp.clientId} className={`rounded-lg border px-3 py-2.5 transition-all ${sp.disabled ? 'border-charcoal-blue-100 bg-charcoal-blue-50 opacity-60' : 'border-charcoal-blue-200 bg-white'}`}>
                            {!isEditing ? (
                              <div className="flex items-start gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5 mb-0.5">
                                    <span className={`text-xs font-bold ${sp.disabled ? 'line-through text-charcoal-blue-400' : 'text-charcoal-blue-950'}`}>{sp.promo_name}</span>
                                    {sp.event_type && <span className="rounded bg-majorelle-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-majorelle-blue-600">{sp.event_type}</span>}
                                    {sp.disabled && <span className="rounded-full bg-charcoal-blue-200 px-1.5 py-0.5 text-[9px] font-bold text-charcoal-blue-500">Disabled</span>}
                                    {isModified && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700">Modified</span>}
                                  </div>
                                  <p className="text-[10px] text-charcoal-blue-400">
                                    {sp.promo_group_name && <span className="mr-2 font-medium text-charcoal-blue-600">{sp.promo_group_name}</span>}
                                    <span className="font-mono">{sp.start_date} → {sp.end_date}</span>
                                    <span className="ml-2 font-bold text-emerald-600">{sp.demand_multiplier}×</span>
                                    {sp.store_count > 0 && <span className="ml-2">{sp.store_count} stores</span>}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    onClick={() => { setEditingClientId(sp.clientId); setEditForm({ start_date: sp.start_date, end_date: sp.end_date, demand_multiplier: sp.demand_multiplier }) }}
                                    className="rounded p-1 text-charcoal-blue-400 hover:bg-charcoal-blue-100 hover:text-charcoal-blue-700"
                                    title="Edit"
                                  ><Pencil size={13} /></button>
                                  <button
                                    onClick={() => setScheduledPromos(prev => prev.map(p => p.clientId === sp.clientId ? { ...p, disabled: !p.disabled } : p))}
                                    className={`rounded p-1 text-[10px] font-semibold transition-colors ${sp.disabled ? 'text-emerald-600 hover:bg-emerald-50' : 'text-charcoal-blue-400 hover:bg-charcoal-blue-100'}`}
                                    title={sp.disabled ? 'Enable' : 'Disable'}
                                  >{sp.disabled ? 'Enable' : 'Disable'}</button>
                                  <button
                                    onClick={() => setScheduledPromos(prev => prev.filter(p => p.clientId !== sp.clientId))}
                                    className="rounded p-1 text-charcoal-blue-300 hover:bg-rose-50 hover:text-rose-500"
                                    title="Remove"
                                  ><Trash2 size={13} /></button>
                                </div>
                              </div>
                            ) : (
                              /* Edit form */
                              <div>
                                <p className="mb-2 text-[11px] font-bold text-charcoal-blue-700">{sp.promo_name}</p>
                                <div className="grid grid-cols-3 gap-2 mb-2">
                                  <FormField label="Start Date">
                                    <input type="date" value={editForm.start_date}
                                      min={minExtensionDate} max={extensionEndDate || undefined}
                                      onChange={e => setEditForm(f => ({ ...f, start_date: e.target.value }))} className={inputCls} />
                                  </FormField>
                                  <FormField label="End Date">
                                    <input type="date" value={editForm.end_date}
                                      min={editForm.start_date || minExtensionDate} max={extensionEndDate || undefined}
                                      onChange={e => setEditForm(f => ({ ...f, end_date: e.target.value }))} className={inputCls} />
                                  </FormField>
                                  <FormField label="Multiplier">
                                    <input type="number" value={editForm.demand_multiplier} min={0.1} max={10} step={0.1}
                                      onChange={e => setEditForm(f => ({ ...f, demand_multiplier: Number(e.target.value) }))} className={inputCls} />
                                  </FormField>
                                </div>
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => {
                                      setScheduledPromos(prev => prev.map(p => p.clientId === sp.clientId ? { ...p, ...editForm } : p))
                                      setEditingClientId(null)
                                    }}
                                    className="rounded-full bg-majorelle-blue-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-majorelle-blue-600"
                                  >Save</button>
                                  <button onClick={() => setEditingClientId(null)} className="rounded-full border border-charcoal-blue-200 px-3 py-1 text-[11px] font-semibold text-charcoal-blue-600 hover:bg-charcoal-blue-50">Cancel</button>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>

                  </div>

                  {/* ── Add from Catalog — separate section below scheduled list ── */}
                  {showAddPanel && (
                      <div className="rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50/40 p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-bold text-charcoal-blue-950">Add from Catalog</p>
                          <button onClick={() => { setShowAddPanel(false); setAddingPromo(null) }} className="text-charcoal-blue-400 hover:text-charcoal-blue-700"><X size={14} /></button>
                        </div>
                        <div className="mb-2 flex gap-2">
                          <div className="relative flex-1">
                            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-charcoal-blue-300" />
                            <input
                              type="text" value={promoSearch} onChange={e => setPromoSearch(e.target.value)}
                              placeholder="Search promos…"
                              className="w-full rounded-lg border border-charcoal-blue-200 bg-white py-1.5 pl-7 pr-2.5 text-xs focus:border-majorelle-blue-400 focus:outline-none"
                            />
                          </div>
                          <select
                            value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
                            className="rounded-lg border border-charcoal-blue-200 bg-white px-2 py-1.5 text-xs text-charcoal-blue-700 focus:border-majorelle-blue-400 focus:outline-none"
                          >
                            <option value="all">All Groups</option>
                            {Array.from(new Set(catalogPromos.map(p => p.promo_group_name).filter(Boolean))).map(g => (
                              <option key={g!} value={g!}>{g}</option>
                            ))}
                          </select>
                        </div>

                        {catalogLoading && <div className="flex justify-center py-4"><div className="h-4 w-4 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" /></div>}

                        {!catalogLoading && (() => {
                          // Deduplicate by (promo_group_name, event_type) — show one entry per promo type
                          const seenTypes = new Map<string, typeof catalogPromos[0]>()
                          for (const p of catalogPromos) {
                            const key = `${p.promo_group_name ?? ''}__${p.event_type}`
                            if (!seenTypes.has(key)) seenTypes.set(key, p)
                          }
                          const deduped = Array.from(seenTypes.values())

                          // Track which types are already in the scheduled list
                          const scheduledTypeKeys = new Set(
                            scheduledPromos.map(s => `${s.promo_group_name}__${s.event_type}`)
                          )

                          const filtered = deduped.filter(p => {
                            const typeKey = `${p.promo_group_name ?? ''}__${p.event_type}`
                            const label = `${p.promo_group_name ?? ''} ${p.event_type}`.toLowerCase()
                            return (
                              (groupFilter === 'all' || p.promo_group_name === groupFilter) &&
                              (!promoSearch || label.includes(promoSearch.toLowerCase()))
                            )
                          })

                          return (
                            <div className="max-h-44 space-y-1 overflow-y-auto">
                              {filtered.length === 0 && <p className="py-3 text-center text-[11px] text-charcoal-blue-400">No promos match your search</p>}
                              {filtered.map(p => {
                                const typeKey = `${p.promo_group_name ?? ''}__${p.event_type}`
                                const alreadyAdded = scheduledTypeKeys.has(typeKey)
                                const isSelecting = addingPromo?.promo_id === p.promo_id
                                return (
                                  <div key={typeKey} className={`rounded-lg border px-3 py-2 ${alreadyAdded ? 'border-charcoal-blue-100 bg-white opacity-40' : 'border-charcoal-blue-200 bg-white'}`}>
                                    <div className="flex items-center gap-2">
                                      <div className="flex-1 min-w-0">
                                        <p className={`text-[11px] font-bold ${alreadyAdded ? 'text-charcoal-blue-400' : 'text-charcoal-blue-950'}`}>
                                          {p.promo_group_name} {p.event_type}
                                        </p>
                                        <p className="text-[10px] text-charcoal-blue-400">
                                          {p.promo_group_name && <span className="mr-1.5">{p.promo_group_name}</span>}
                                          {p.event_type && <span className="mr-1.5 rounded bg-majorelle-blue-50 px-1 text-majorelle-blue-600">{p.event_type}</span>}
                                          <span className="font-bold text-emerald-600">{p.demand_multiplier}×</span>
                                        </p>
                                      </div>
                                      {!alreadyAdded && (
                                        <button
                                          onClick={() => {
                                            setAddingPromo(p)
                                            setAddForm({
                                              start_date: '',
                                              end_date: '',
                                              demand_multiplier: p.demand_multiplier,
                                            })
                                          }}
                                          className="shrink-0 rounded-full bg-majorelle-blue-50 px-2 py-0.5 text-[10px] font-bold text-majorelle-blue-600 hover:bg-majorelle-blue-100"
                                        >Select</button>
                                      )}
                                      {alreadyAdded && <span className="shrink-0 text-[10px] text-charcoal-blue-400">Added</span>}
                                    </div>
                                    {isSelecting && (
                                      <div className="mt-2 border-t border-charcoal-blue-100 pt-2">
                                        <div className="grid grid-cols-3 gap-2 mb-2">
                                          <FormField label="Start Date">
                                            <input type="date" value={addForm.start_date}
                                              min={minExtensionDate} max={extensionEndDate || undefined}
                                              onChange={e => setAddForm(f => ({ ...f, start_date: e.target.value }))} className={inputCls} />
                                          </FormField>
                                          <FormField label="End Date">
                                            <input type="date" value={addForm.end_date}
                                              min={addForm.start_date || minExtensionDate} max={extensionEndDate || undefined}
                                              onChange={e => setAddForm(f => ({ ...f, end_date: e.target.value }))} className={inputCls} />
                                          </FormField>
                                          <FormField label="Multiplier">
                                            <input type="number" value={addForm.demand_multiplier} min={0.1} max={10} step={0.1}
                                              onChange={e => setAddForm(f => ({ ...f, demand_multiplier: Number(e.target.value) }))} className={inputCls} />
                                          </FormField>
                                        </div>
                                        <div className="flex gap-2">
                                          <button
                                            onClick={() => {
                                              setScheduledPromos(prev => [...prev, {
                                                clientId: crypto.randomUUID(),
                                                promo_id: p.promo_id,
                                                // Display name is group + event_type; promo_name (the original dated one) is used in YAML override
                                                promo_name: p.promo_name,
                                                promo_group_name: p.promo_group_name ?? '',
                                                event_type: p.event_type,
                                                store_count: p.store_ids.length,
                                                item_count: 0,
                                                original_start_date: addForm.start_date,
                                                original_end_date: addForm.end_date,
                                                original_multiplier: p.demand_multiplier,
                                                start_date: addForm.start_date,
                                                end_date: addForm.end_date,
                                                demand_multiplier: addForm.demand_multiplier,
                                                disabled: false,
                                              }])
                                              setAddingPromo(null)
                                            }}
                                            className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-bold text-white hover:bg-emerald-600"
                                          >Add to Schedule</button>
                                          <button onClick={() => setAddingPromo(null)} className="rounded-full border border-charcoal-blue-200 px-3 py-1 text-[11px] font-semibold text-charcoal-blue-600 hover:bg-charcoal-blue-50">Cancel</button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )
                        })()}
                      </div>
                    )}
                </div>
              )}

              {/* ── Step 2: Generate Demand + Chart ────────────────────── */}
              {currentStep === 2 && (
                <div className="space-y-4">
                  {/* Status */}
                  {demandStatus === 'generating' && (
                    <div className="flex items-center gap-3 rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50 p-4">
                      <div className="h-5 w-5 flex-shrink-0 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                      <div>
                        <p className="text-sm font-bold text-majorelle-blue-950">Generating demand…</p>
                        <p className="text-[10px] text-majorelle-blue-500">Building weekly demand forecast for the extension period</p>
                      </div>
                    </div>
                  )}
                  {demandStatus === 'done' && (
                    <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                      <Check size={14} className="text-emerald-600" />
                      <p className="text-xs font-semibold text-emerald-900">
                        Demand generated{demandRows != null ? ` — ${demandRows.toLocaleString()} rows` : ''}
                      </p>
                    </div>
                  )}
                  {demandStatus === 'error' && (
                    <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3">
                      <AlertCircle size={14} className="text-rose-600" />
                      <p className="text-xs font-semibold text-rose-900">Demand generation failed. Check ClickHouse connectivity.</p>
                    </div>
                  )}

                  {/* Chart */}
                  {chartData.length > 0 && (
                    <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
                      <div className="mb-3 flex items-center gap-2">
                        <Code size={14} className="text-majorelle-blue-500" />
                        <div>
                          <h3 className="text-sm font-bold text-charcoal-blue-950">Demand Continuation</h3>
                          <p className="text-[10px] text-charcoal-blue-400">Last 8 weeks of base simulation + extension forecast</p>
                        </div>
                      </div>
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e8eaed" />
                          <XAxis dataKey="week" tick={{ fontSize: 9 }} tickLine={false} />
                          <YAxis tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                          <Tooltip
                            contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid #e8eaed' }}
                            formatter={(v, name) => [Number(v).toLocaleString(), String(name)]}
                          />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          {/* Base sim weeks — gray */}
                          <Bar dataKey="base" name="Base (actual)" fill="#94a3b8" radius={[3, 3, 0, 0]} maxBarSize={24} />
                          {/* Extension weeks — majorelle blue */}
                          <Bar dataKey="ext" name="Extension (forecast)" fill="#5b5fcf" radius={[3, 3, 0, 0]} maxBarSize={24} />
                          {/* Boundary line */}
                          {chartData.find(d => d.ext !== undefined) && (
                            <ReferenceLine
                              x={chartData.find(d => d.ext !== undefined)?.week}
                              stroke="#5b5fcf"
                              strokeDasharray="4 2"
                              label={{ value: 'Extension starts', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }}
                            />
                          )}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {demandStatus === 'generating' && chartData.length === 0 && (
                    <div className="h-52 rounded-xl border border-charcoal-blue-100 bg-charcoal-blue-50 flex items-center justify-center">
                      <p className="text-xs text-charcoal-blue-400">Chart will appear once demand is generated…</p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Step 3: Promo Performance Adjustments ──────────────── */}
              {currentStep === 3 && (
                <div className="space-y-3">
                  <div>
                    <h3 className="mb-1 text-sm font-bold text-charcoal-blue-950">Promo Performance Adjustments</h3>
                    <p className="text-[10px] text-charcoal-blue-400">
                      Set <code className="rounded bg-charcoal-blue-100 px-1">performance_adjustment</code> per promo (0–200%). 0 = no change · 50 = 50% better than forecast · 200 = double the expected uplift.
                    </p>
                  </div>

                  {scheduledPromos.filter(s => !s.disabled).length === 0 ? (
                    <div className="rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50 p-5 text-center">
                      <p className="text-xs font-semibold text-charcoal-blue-700">No active scheduled promotions.</p>
                      <p className="mt-1 text-[10px] text-charcoal-blue-400">Go back to Step 1 and enable or add promotions to configure their performance.</p>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
                      <div className="mb-3 flex items-center gap-2">
                        <Code size={15} className="text-majorelle-blue-500" />
                        <div>
                          <h3 className="text-sm font-bold text-charcoal-blue-950">Promo Performance Scenario</h3>
                          <p className="text-[10px] text-charcoal-blue-400">Edit <code className="rounded bg-charcoal-blue-100 px-1">performance_adjustment</code> per promo (0–200%). 0 = no change · 50 = 50% better · −20 = underperforms.</p>
                        </div>
                      </div>
                      <textarea
                        value={scenarioYaml}
                        onChange={e => { setScenarioYaml(e.target.value); setScenarioYamlError(null) }}
                        rows={Math.max(10, scenarioYaml.split('\n').length + 2)}
                        className="w-full rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 px-3 py-2 font-mono text-xs text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500"
                        spellCheck={false}
                      />
                    </div>
                  )}

                  {scenarioYamlError && <p className="flex items-center gap-1 text-[10px] text-rose-600"><AlertCircle size={11}/> {scenarioYamlError}</p>}
                </div>
              )}

              {/* ── Step 4: Review & Run ─────────────────────────────────── */}
              {currentStep === 4 && (
                <div className="space-y-3">
                  <h3 className="text-base font-bold text-charcoal-blue-950">Review & Run</h3>
                  <div className="space-y-2">
                    {[
                      { label: 'Base Simulation', value: `${baseName} · ends ${baseEndWeek}` },
                      { label: 'Extension', value: `${simulationName} · ${baseEndDate} → ${extensionEndDate}` },
                      { label: 'Inventory Seed', value: `Seeded from ${baseName} — fetched server-side (stores, retailer DCs, supplier DCs)`, color: 'text-emerald-600' },
                      { label: 'Demand', value: demandRows != null ? `${demandRows.toLocaleString()} demand rows generated` : 'Generated', color: 'text-emerald-600' },
                      { label: 'Promos', value: scheduledPromos.length > 0 ? `${scheduledPromos.filter(s => !s.disabled).length} scheduled · ${scheduledPromos.filter(s => s.disabled).length} disabled` : 'No overrides — using promos as stored' },
                      { label: 'Scenario', value: selectedScenario === 'no_scenario' ? 'None — baseline demand' : (scenarioDef?.title ?? selectedScenario) },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50 px-3 py-2">
                        <p className="text-[10px] font-bold text-charcoal-blue-500">{label}</p>
                        <p className={`text-xs font-semibold ${color ?? 'text-charcoal-blue-950'}`}>{value}</p>
                      </div>
                    ))}
                  </div>
                  {stage.type === 'error' && (
                    <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
                      <AlertCircle size={14} className="mt-0.5 text-rose-500" />
                      <p className="text-xs font-semibold text-rose-950">{stage.message}</p>
                    </div>
                  )}
                  {stage.type === 'running' && (
                    <div className="flex items-center gap-2 rounded-lg border border-majorelle-blue-200 bg-majorelle-blue-50 p-3">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                      <p className="text-xs font-semibold text-majorelle-blue-950">{stage.message}</p>
                    </div>
                  )}
                  {stage.type === 'idle' && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-xs font-medium text-emerald-950">✓ Ready to run. Click Run Extended Simulation to start.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Error banner (non-review steps) */}
              {stage.type === 'error' && currentStep !== 4 && (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
                  <AlertCircle size={14} className="mt-0.5 text-rose-500" />
                  <p className="text-xs font-semibold text-rose-950">{stage.message}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer nav */}
        {!loadingBase && !loadBaseError && (
          <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-charcoal-blue-100 bg-white px-6 py-3 rounded-b-xl">
            <button onClick={currentStep === 0 ? onClose : handlePrev} disabled={isRunning}
              className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold transition-all ${isRunning ? 'cursor-not-allowed bg-charcoal-blue-100 text-charcoal-blue-400' : 'border border-charcoal-blue-200 bg-white text-charcoal-blue-950 hover:bg-charcoal-blue-50'}`}>
              <ChevronLeft size={15} /> {currentStep === 0 ? 'Cancel' : 'Previous'}
            </button>

            {currentStep < TOTAL_STEPS - 1 ? (
              <button onClick={handleNext}
                disabled={isRunning || (currentStep === 2 && demandStatus === 'generating')}
                className="inline-flex items-center gap-1.5 rounded-full bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300">
                {currentStep === 1 ? <>Generate Demand <ChevronRight size={15} /></> : <>Next <ChevronRight size={15} /></>}
              </button>
            ) : (
              <button onClick={handleRun} disabled={isRunning}
                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-charcoal-blue-300">
                {isRunning ? 'Running…' : 'Run Extended Simulation'}
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
