'use client'

import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/lib/store/authStore'
import {
  saveExtensionPromos, generateExtensionDemand, getDemandStatus, getDemandWeeklyTotals,
  createRollingSession, runRollingChunk, recalculateRollingDemand,
} from '@/lib/api/simulation'
import { getPromoGroups } from '@/lib/api/promos'
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog'
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { Check, AlertCircle, Plus, Trash2, Search, ChevronRight, Loader2 } from 'lucide-react'
import type { PromoGroupResponse, RollingForecastSession, PerformanceInput, RunChunkResponse } from '@/lib/api/types'
import { toIsoWeek } from '@/lib/utils'

// ── Shared primitives (same as extend-modal) ─────────────────────────────────

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

const inputCls = 'w-full rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50/60 px-2.5 py-1.5 text-xs font-medium text-charcoal-blue-900 placeholder:text-charcoal-blue-300 transition-all focus:border-amber-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-100'


function weeksBetween(start: string, end: string): number {
  const s = new Date(start), e = new Date(end)
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / (7 * 24 * 3600 * 1000)))
}

interface ScheduledPromo {
  clientId: string
  promo_id: string
  promo_name: string
  promo_group_name: string
  event_type: string
  store_count: number
  item_count: number
  start_date: string
  end_date: string
  demand_multiplier: number
  disabled: boolean
}

type ModalState =
  | 'setup'
  | 'demand_preview'
  | 'chunk_running'
  | 'performance_input'
  | 'recalc_demand'
  | 'all_complete'

export interface RollingForecastModalProps {
  open: boolean
  onClose: () => void
  baseSimulationId: string
  retailerAccountId: string
  baseSeed: number
  baseEndDate: string   // YYYY-MM-DD
  existingSession: RollingForecastSession | null
  onSessionUpdated: (session: RollingForecastSession | null) => void
  onDemandReady?: (promos: { promo_group_name: string; promo_name: string; start_date: string; end_date: string; demand_multiplier: number }[]) => void
}

export function RollingForecastModal({
  open, onClose, baseSimulationId, retailerAccountId, baseSeed,
  baseEndDate, existingSession, onSessionUpdated, onDemandReady,
}: RollingForecastModalProps) {
  useAuthStore()

  // ── Session state ─────────────────────────────────────────────────────────
  const [session, setSession] = useState<RollingForecastSession | null>(existingSession)
  useEffect(() => { setSession(existingSession) }, [existingSession])

  // ── Modal state machine ───────────────────────────────────────────────────
  const [modalState, setModalState] = useState<ModalState>(() =>
    existingSession?.status === 'active' && existingSession.current_completed_week
      ? 'performance_input'
      : existingSession?.status === 'active'
        ? 'demand_preview'
        : 'setup'
  )
  const [error, setError] = useState('')

  // ── Setup state ───────────────────────────────────────────────────────────
  const [totalEndDate, setTotalEndDate] = useState('')
  const [scheduledPromos, setScheduledPromos] = useState<ScheduledPromo[]>([])
  const [promoGroupCatalog, setPromoGroupCatalog] = useState<PromoGroupResponse[]>([])
  const [promoSearch, setPromoSearch] = useState('')
  const [showAddPanel, setShowAddPanel] = useState(false)
  const [savingSetup, setSavingSetup] = useState(false)
  // State for configuring a group before adding it
  const [pendingGroup, setPendingGroup] = useState<PromoGroupResponse | null>(null)
  const [pendingStartDate, setPendingStartDate] = useState('')
  const [pendingEndDate, setPendingEndDate] = useState('')
  const [pendingMultiplier, setPendingMultiplier] = useState(2.0)

  // ── Demand preview state ──────────────────────────────────────────────────
  const [chartData, setChartData] = useState<{ week: string; demand_qty?: number }[]>([])
  const [chunkEndDate, setChunkEndDate] = useState('')
  const [demandStatus, setDemandStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle')
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Chunk running / result state ──────────────────────────────────────────
  const [lastChunkResult, setLastChunkResult] = useState<any>(null)

  // ── Performance input state ───────────────────────────────────────────────
  const [promoGroups, setPromoGroups] = useState<string[]>([])
  const [perfInputs, setPerfInputs] = useState<Record<string, number>>({})

  // ── Load promo groups catalog ─────────────────────────────────────────────
  useEffect(() => {
    if (!open || !retailerAccountId) return
    getPromoGroups(retailerAccountId).then(setPromoGroupCatalog).catch(() => null)
  }, [open, retailerAccountId])

  // ── If resuming an existing session, load its demand chart ───────────────
  useEffect(() => {
    if (!open || !existingSession) return
    if (existingSession.status === 'active' && !existingSession.current_completed_week) {
      loadDemandChart(existingSession)
    }
  }, [open, existingSession])

  // ── Cleanup poll on unmount ───────────────────────────────────────────────
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current) }, [])

  // ── Demand chart loader ───────────────────────────────────────────────────
  async function loadDemandChart(sess: RollingForecastSession) {
    const startWeek = sess.current_completed_week
      ? toIsoWeek(sess.current_completed_week)
      : baseEndDate ? toIsoWeek(baseEndDate) : ''
    const endWeek = toIsoWeek(sess.total_end_date)
    if (!startWeek || !endWeek) return
    try {
      const rows = await getDemandWeeklyTotals(retailerAccountId, startWeek, endWeek, baseSeed)
      setChartData(rows.map(r => ({ week: r.pos_week, demand_qty: r.demand_qty })))
    } catch {
      setChartData([])
    }
  }

  // ── Step: Save setup and generate demand ─────────────────────────────────
  async function handleSaveAndPreview() {
    if (!totalEndDate) { setError('Please set a total end date.'); return }
    if (new Date(totalEndDate) <= new Date(baseEndDate)) {
      setError('Total end date must be after the base simulation end date.'); return
    }
    setError('')
    setSavingSetup(true)
    try {
      // Create session if not already existing
      let sess = session
      if (!sess) {
        sess = await createRollingSession(baseSimulationId, retailerAccountId, totalEndDate)
        setSession(sess)
        onSessionUpdated(sess)
      }

      // Save promos
      if (scheduledPromos.length > 0) {
        await saveExtensionPromos(
          baseSimulationId,
          sess.session_id,
          retailerAccountId,
          scheduledPromos.map(p => ({
            promo_id: p.promo_id,
            promo_name: p.promo_name,
            promo_group_name: p.promo_group_name,
            event_type: p.event_type,
            start_date: p.start_date,
            end_date: p.end_date,
            demand_multiplier: p.demand_multiplier,
            is_disabled: p.disabled,
          })),
        )
      }

      // Generate demand
      setDemandStatus('generating')
      const job = await generateExtensionDemand({
        session_id: sess.session_id,
        simulation_id: baseSimulationId,
        retailer_account_id: retailerAccountId,
        start_date: baseEndDate,
        end_date: totalEndDate,
        seed: baseSeed,
      })

      pollDemandJob(job.job_id, sess)
      // Stay on setup but show generating state — modal closes when done
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save setup')
    } finally {
      setSavingSetup(false)
    }
  }

  function pollDemandJob(jobId: string, sess: RollingForecastSession) {
    pollRef.current = setTimeout(async () => {
      try {
        const status = await getDemandStatus(jobId)
        if (status.status === 'COMPLETED') {
          setDemandStatus('done')
          onDemandReady?.(scheduledPromos.map(p => ({
            promo_group_name: p.promo_group_name,
            promo_name: p.promo_name,
            start_date: p.start_date,
            end_date: p.end_date,
            demand_multiplier: p.demand_multiplier,
          })))
          onClose()           // close this modal — user works from main page now
        } else if (status.status === 'FAILED') {
          setDemandStatus('error')
          setError('Demand generation failed.')
        } else {
          pollDemandJob(jobId, sess)
        }
      } catch {
        setDemandStatus('error')
      }
    }, 2000)
  }

  // ── Step: Run chunk ───────────────────────────────────────────────────────
  async function handleRunChunk() {
    if (!chunkEndDate) { setError('Please select how many weeks to run.'); return }
    if (!session) { setError('No active session.'); return }
    const currentStart = session.current_completed_week || baseEndDate
    if (new Date(chunkEndDate) <= new Date(currentStart)) {
      setError('Chunk end date must be after the current completed week.'); return
    }
    setError('')
    setModalState('chunk_running')
    try {
      const result = await runRollingChunk(session.session_id, {
        chunk_end_date: chunkEndDate,
      })
      setLastChunkResult(result)

      // Extract promo groups that had promos in this chunk
      const chunkStart = currentStart
      const calendar: any[] = result.promo_calendar ?? []
      const groups = [...new Set(
        calendar
          .filter(p => p.start_date <= chunkEndDate && p.end_date >= chunkStart)
          .map(p => p.promo_group_name ?? p.promo_name)
          .filter(Boolean)
      )]
      setPromoGroups(groups)
      setPerfInputs(Object.fromEntries(groups.map(g => [g, 0])))

      // Update session state
      const updatedSession: RollingForecastSession = {
        ...session,
        current_completed_week: result.rolling_session?.current_completed_week ?? chunkEndDate,
        status: result.rolling_session?.session_status as any ?? 'active',
      }
      setSession(updatedSession)
      onSessionUpdated(updatedSession)

      if (result.rolling_session?.session_status === 'completed') {
        setModalState('all_complete')
      } else {
        setModalState('performance_input')
      }
    } catch (e: any) {
      setError(e?.message ?? 'Chunk run failed')
      setModalState('demand_preview')
    }
  }

  // ── Step: Recalculate demand ──────────────────────────────────────────────
  async function handleRecalculate() {
    if (!session) return
    setError('')
    setModalState('recalc_demand')
    const inputs: PerformanceInput[] = Object.entries(perfInputs)
      .filter(([, pct]) => pct !== 0)
      .map(([promo_group_name, pct]) => ({ promo_group_name, pct }))

    try {
      const job = await recalculateRollingDemand(session.session_id, { performance_inputs: inputs })
      pollRecalcJob(job.job_id, session)
    } catch (e: any) {
      setError(e?.message ?? 'Recalculation failed')
      setModalState('demand_preview')
    }
  }

  function pollRecalcJob(jobId: string, sess: RollingForecastSession) {
    pollRef.current = setTimeout(async () => {
      try {
        const status = await getDemandStatus(jobId)
        if (status.status === 'COMPLETED') {
          await loadDemandChart(sess)
          setModalState('demand_preview')
        } else if (status.status === 'FAILED') {
          setError('Demand recalculation failed.')
          setModalState('demand_preview')
        } else {
          pollRecalcJob(jobId, sess)
        }
      } catch {
        setError('Polling failed.')
        setModalState('demand_preview')
      }
    }, 2000)
  }

  // ── Add promo group to schedule ───────────────────────────────────────────
  function confirmAddGroup() {
    if (!pendingGroup || !pendingStartDate || !pendingEndDate) return
    setScheduledPromos(prev => [...prev, {
      clientId: crypto.randomUUID(),
      promo_id: '',                              // NULL — group-based entry
      promo_name: pendingGroup.promo_group_name, // used as identifier in backend
      promo_group_name: pendingGroup.promo_group_name,
      event_type: '',
      store_count: 0,
      item_count: pendingGroup.item_ids?.length ?? 0,
      start_date: pendingStartDate,
      end_date: pendingEndDate,
      demand_multiplier: pendingMultiplier,
      disabled: false,
    }])
    setPendingGroup(null)
    setPendingStartDate('')
    setPendingEndDate('')
    setPendingMultiplier(2.0)
  }

  const filteredGroups = promoGroupCatalog.filter(g =>
    promoSearch === '' ||
    g.promo_group_name.toLowerCase().includes(promoSearch.toLowerCase()) ||
    (g.category ?? '').toLowerCase().includes(promoSearch.toLowerCase()) ||
    (g.brand ?? '').toLowerCase().includes(promoSearch.toLowerCase())
  )

  // ── Render ────────────────────────────────────────────────────────────────

  const currentStart = session?.current_completed_week || baseEndDate
  const totalEnd = session?.total_end_date || totalEndDate
  const weeksToRun = chunkEndDate && currentStart ? weeksBetween(currentStart, chunkEndDate) : 0

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto rounded-2xl p-0 shadow-2xl bg-white">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-charcoal-blue-100 px-6 py-4 pr-12">
            <div>
              <DialogTitle className="text-sm font-bold text-charcoal-blue-900">Rolling Forecast</DialogTitle>
              <p className="text-[10px] text-charcoal-blue-400 mt-0.5">
                {{
                  setup: 'Set up your rolling forecast window and schedule promos',
                  demand_preview: 'Review forecast demand and select next chunk to run',
                  chunk_running: 'Running simulation chunk…',
                  performance_input: 'How did your promos perform?',
                  recalc_demand: 'Recalculating demand with updated multipliers…',
                  all_complete: 'Rolling forecast complete',
                }[modalState]}
              </p>
            </div>
          </div>

          <div className="px-6 py-5 space-y-5">

            {error && (
              <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                <AlertCircle size={13} />
                {error}
              </div>
            )}

            {/* ── SETUP ────────────────────────────────────────────────────── */}
            {modalState === 'setup' && (
              <div className="space-y-4">
                <FormField label="Total Forecast End Date" info="The full window you want to forecast — you'll run it in chunks.">
                  <input
                    type="date"
                    value={totalEndDate}
                    min={baseEndDate}
                    onChange={e => setTotalEndDate(e.target.value)}
                    className={inputCls}
                  />
                </FormField>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">
                      Schedule Promo Groups
                    </label>
                    <button
                      onClick={() => setShowAddPanel(v => !v)}
                      className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600 hover:text-amber-700"
                    >
                      <Plus size={11} /> Add promo group
                    </button>
                  </div>

                  {/* Promo group catalog panel */}
                  {showAddPanel && (
                    <div className="rounded-xl border border-charcoal-blue-100 bg-charcoal-blue-50 p-3 space-y-3">
                      <div className="relative">
                        <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-charcoal-blue-300" />
                        <input
                          value={promoSearch}
                          onChange={e => { setPromoSearch(e.target.value); setPendingGroup(null) }}
                          placeholder="Search promo groups…"
                          className={`${inputCls} pl-7`}
                        />
                      </div>

                      {/* Group list */}
                      {!pendingGroup && (
                        <div className="max-h-40 overflow-y-auto space-y-1">
                          {filteredGroups.map(g => (
                            <button
                              key={g.promo_group_id}
                              onClick={() => { setPendingGroup(g); setPendingStartDate(''); setPendingEndDate(''); setPendingMultiplier(2.0) }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[10px] hover:bg-white border border-transparent hover:border-charcoal-blue-100"
                            >
                              <Plus size={10} className="flex-shrink-0 text-amber-500" />
                              <div className="flex-1 min-w-0">
                                <span className="font-semibold text-charcoal-blue-800">{g.promo_group_name}</span>
                                {(g.category || g.brand) && (
                                  <span className="ml-1.5 text-charcoal-blue-400">{[g.category, g.brand].filter(Boolean).join(' · ')}</span>
                                )}
                              </div>
                              <span className="text-charcoal-blue-400 flex-shrink-0">{g.item_ids?.length ?? 0} items</span>
                            </button>
                          ))}
                          {filteredGroups.length === 0 && (
                            <p className="text-center text-[10px] text-charcoal-blue-400 py-2">No promo groups found</p>
                          )}
                        </div>
                      )}

                      {/* Configure selected group */}
                      {pendingGroup && (
                        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-bold text-amber-800">{pendingGroup.promo_group_name}</p>
                            <button onClick={() => setPendingGroup(null)} className="text-[10px] text-charcoal-blue-400 hover:text-charcoal-blue-700">← Back</button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col gap-0.5">
                              <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">Start Date</label>
                              <input type="date" value={pendingStartDate} min={baseEndDate} max={totalEndDate || undefined}
                                onChange={e => setPendingStartDate(e.target.value)} className={inputCls} />
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">End Date</label>
                              <input type="date" value={pendingEndDate} min={pendingStartDate || baseEndDate} max={totalEndDate || undefined}
                                onChange={e => setPendingEndDate(e.target.value)} className={inputCls} />
                            </div>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">Demand Multiplier</label>
                            <input type="number" step="0.1" min="0.1" value={pendingMultiplier}
                              onChange={e => setPendingMultiplier(Number(e.target.value))} className={inputCls} />
                          </div>
                          <button
                            onClick={confirmAddGroup}
                            disabled={!pendingStartDate || !pendingEndDate}
                            className="w-full rounded-lg bg-amber-500 py-1.5 text-[10px] font-bold text-white hover:bg-amber-600 disabled:opacity-50"
                          >
                            Add to Schedule
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Scheduled list */}
                  {scheduledPromos.length > 0 ? (
                    <div className="space-y-1.5">
                      {scheduledPromos.map(p => (
                        <div key={p.clientId} className="flex items-center gap-2 rounded-xl border border-charcoal-blue-100 bg-white px-3 py-2 text-xs">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-charcoal-blue-800 truncate">{p.promo_group_name || p.promo_name}</p>
                            <p className="text-[10px] text-charcoal-blue-400">{p.start_date} → {p.end_date} · {p.demand_multiplier}×</p>
                          </div>
                          <button
                            onClick={() => setScheduledPromos(prev => prev.filter(s => s.clientId !== p.clientId))}
                            className="text-charcoal-blue-300 hover:text-rose-500"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-center text-[10px] text-charcoal-blue-400 py-3 rounded-xl border border-dashed border-charcoal-blue-200">
                      No promos scheduled — rolling forecast will use baseline demand
                    </p>
                  )}
                </div>

                <button
                  onClick={handleSaveAndPreview}
                  disabled={savingSetup || demandStatus === 'generating' || !totalEndDate}
                  className="w-full rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-white transition-all hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {demandStatus === 'generating'
                    ? <><Loader2 size={13} className="animate-spin" /> Generating demand…</>
                    : savingSetup
                      ? <><Loader2 size={13} className="animate-spin" /> Saving…</>
                      : <>Generate Demand <ChevronRight size={13} /></>}
                </button>
              </div>
            )}

            {/* ── DEMAND PREVIEW ───────────────────────────────────────────── */}
            {modalState === 'demand_preview' && (
              <div className="space-y-4">
                {/* Demand chart */}
                <div>
                  <p className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400 mb-2">
                    Forecast Demand {demandStatus === 'generating' && <span className="text-amber-500 normal-case">· Generating…</span>}
                    {demandStatus === 'done' && <span className="text-emerald-500 normal-case">· Ready</span>}
                  </p>
                  {demandStatus === 'generating' ? (
                    <div className="flex h-32 items-center justify-center gap-2 rounded-xl border border-dashed border-amber-200 bg-amber-50 text-xs text-amber-600">
                      <Loader2 size={14} className="animate-spin" /> Generating demand…
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={160}>
                      <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 8 }} barCategoryGap="4%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="week" tick={{ fontSize: 8 }} interval="preserveStartEnd" />
                        <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 8 }} />
                        <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                        <Bar dataKey="demand_qty" fill="#f59e0b" fillOpacity={0.8} name="Forecast Demand" barSize={8} />
                        {currentStart && <ReferenceLine x={toIsoWeek(currentStart)} stroke="#6b7280" strokeDasharray="4 2" label={{ value: 'Now', fontSize: 8, fill: '#6b7280' }} />}
                      </ComposedChart>
                    </ResponsiveContainer>
                  )}
                </div>

                {/* Chunk date picker */}
                <FormField label="Run until" info="Pick the end date for this chunk. You can run the rest later.">
                  <input
                    type="date"
                    value={chunkEndDate}
                    min={currentStart}
                    max={totalEnd}
                    onChange={e => setChunkEndDate(e.target.value)}
                    className={inputCls}
                  />
                  {chunkEndDate && (
                    <p className="text-[10px] text-charcoal-blue-400 mt-1">
                      This will run <span className="font-bold text-amber-600">{weeksToRun} week{weeksToRun !== 1 ? 's' : ''}</span> of simulation.
                    </p>
                  )}
                </FormField>

                <button
                  onClick={handleRunChunk}
                  disabled={!chunkEndDate || demandStatus === 'generating'}
                  className="w-full rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-white transition-all hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Run {weeksToRun > 0 ? `${weeksToRun} Week${weeksToRun !== 1 ? 's' : ''}` : 'Chunk'}
                </button>
              </div>
            )}

            {/* ── CHUNK RUNNING ────────────────────────────────────────────── */}
            {modalState === 'chunk_running' && (
              <div className="flex flex-col items-center justify-center gap-4 py-12">
                <Loader2 size={32} className="animate-spin text-amber-500" />
                <div className="text-center">
                  <p className="text-sm font-bold text-charcoal-blue-800">Running simulation chunk…</p>
                  <p className="text-xs text-charcoal-blue-400 mt-1">
                    {currentStart} → {chunkEndDate}
                  </p>
                </div>
              </div>
            )}

            {/* ── PERFORMANCE INPUT ────────────────────────────────────────── */}
            {modalState === 'performance_input' && (
              <div className="space-y-4">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <p className="text-xs font-bold text-emerald-800">
                    <Check size={12} className="inline mr-1" />
                    Chunk complete — {session?.current_completed_week}
                  </p>
                  <p className="text-[10px] text-emerald-700 mt-0.5">
                    How did your promos actually perform vs. the forecast?
                  </p>
                </div>

                {promoGroups.length > 0 ? (
                  <div className="space-y-2">
                    <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">
                      Performance vs. Forecast (%)
                    </label>
                    {promoGroups.map(group => (
                      <div key={group} className="flex items-center gap-3 rounded-xl border border-charcoal-blue-100 bg-white px-3 py-2.5">
                        <span className="flex-1 text-xs font-semibold text-charcoal-blue-800 truncate">{group}</span>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            value={perfInputs[group] ?? 0}
                            onChange={e => setPerfInputs(prev => ({ ...prev, [group]: Number(e.target.value) }))}
                            className="w-20 rounded-lg border border-charcoal-blue-200 px-2 py-1 text-xs text-center font-semibold focus:border-amber-400 focus:outline-none"
                            placeholder="0"
                          />
                          <span className="text-xs text-charcoal-blue-400">%</span>
                        </div>
                      </div>
                    ))}
                    <p className="text-[10px] text-charcoal-blue-400">
                      Positive = overperformed, negative = underperformed. 0 = as expected.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-charcoal-blue-400 text-center py-4">
                    No promos were active in this chunk.
                  </p>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => { setModalState('demand_preview'); setChunkEndDate('') }}
                    className="flex-1 rounded-xl border border-charcoal-blue-200 py-2.5 text-xs font-bold text-charcoal-blue-600 hover:bg-charcoal-blue-50"
                  >
                    Skip — keep forecast as-is
                  </button>
                  <button
                    onClick={handleRecalculate}
                    disabled={promoGroups.length === 0}
                    className="flex-1 rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-white hover:bg-amber-600 disabled:opacity-50"
                  >
                    Update Forecast
                  </button>
                </div>
              </div>
            )}

            {/* ── RECALC DEMAND ────────────────────────────────────────────── */}
            {modalState === 'recalc_demand' && (
              <div className="flex flex-col items-center justify-center gap-4 py-12">
                <Loader2 size={32} className="animate-spin text-amber-500" />
                <div className="text-center">
                  <p className="text-sm font-bold text-charcoal-blue-800">Recalculating demand…</p>
                  <p className="text-xs text-charcoal-blue-400 mt-1">Applying performance adjustments to future promo weeks</p>
                </div>
              </div>
            )}

            {/* ── ALL COMPLETE ─────────────────────────────────────────────── */}
            {modalState === 'all_complete' && (
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
                  <Check size={24} className="text-emerald-600" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-bold text-charcoal-blue-800">Rolling forecast complete!</p>
                  <p className="text-xs text-charcoal-blue-500 mt-1">
                    All chunks have been committed.
                    Your simulation now covers through {session?.total_end_date ?? totalEnd}.
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className="rounded-xl bg-amber-500 px-6 py-2.5 text-xs font-bold text-white hover:bg-amber-600"
                >
                  Close
                </button>
              </div>
            )}

          </div>
      </DialogContent>
    </Dialog>
  )
}
