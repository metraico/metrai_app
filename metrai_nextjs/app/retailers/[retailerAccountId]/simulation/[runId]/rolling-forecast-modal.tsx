'use client'

import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/lib/store/authStore'
import {
  generateExtensionDemand, getDemandStatus, getDemandWeeklyTotals,
  createRollingSessionYaml, runRollingChunk, recalculateRollingDemand, getSessionPromoSchedules,
} from '@/lib/api/simulation'
import { getPromoGroups, getPromos } from '@/lib/api/promos'
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog'
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { Check, AlertCircle, Plus, ChevronRight, Loader2, ChevronDown } from 'lucide-react'
import type { PromoGroupResponse, PromoResponse, RollingForecastSession, PerformanceInput } from '@/lib/api/types'
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

// ── YAML helpers ──────────────────────────────────────────────────────────────

/** Build a skeleton YAML string from scratch. total_end_date is the top-level key. */
function buildRollingSessionYaml(totalEndDate: string): string {
  return [
    `# Rolling Forecast Session`,
    `# total_end_date: the full window you want to forecast (must be after base simulation end date)`,
    `# promos: list of promo groups to schedule — add them with the "Add promo" button below`,
    `#`,
    `# Each promo entry:`,
    `#   name        — must match a promo group name in the catalog (drives item associations)`,
    `#   promo_name  — optional: specific promo type e.g. BOGO_Ad, 2/$6 (display/audit only)`,
    `#   start/end   — YYYY-MM-DD, end must be >= start`,
    `#   multiplier  — 1.0 = baseline, 1.25 = +25% demand boost`,
    ``,
    `total_end_date: "${totalEndDate}"`,
    ``,
    `promos: []`,
  ].join('\n')
}

/** Parse total_end_date out of the YAML string without a full parser (simple regex). */
function extractTotalEndDate(yaml: string): string {
  const m = yaml.match(/^total_end_date:\s*["']?(\d{4}-\d{2}-\d{2})["']?/m)
  return m ? m[1] : ''
}

/** Replace the total_end_date line in the YAML with a new date. */
function replaceTotalEndDate(yaml: string, newDate: string): string {
  return yaml.replace(
    /^(total_end_date:\s*)["']?\d{4}-\d{2}-\d{2}["']?/m,
    `$1"${newDate}"`,
  )
}

/** Append a promo snippet at the end of the YAML (replacing `promos: []` if present). */
function appendPromoSnippet(
  yaml: string,
  promoGroupName: string,
  promoName: string | null,
  startDate: string,
  endDate: string,
  multiplier = 1.0,
): string {
  const nameLines = promoName
    ? `  - name: "${promoGroupName}"\n    promo_name: "${promoName}"\n`
    : `  - name: "${promoGroupName}"\n`
  const snippet = `${nameLines}    start: "${startDate}"\n    end: "${endDate}"\n    multiplier: ${multiplier}`

  // Replace `promos: []` with a proper list
  if (/promos:\s*\[\]/.test(yaml)) {
    return yaml.replace(/promos:\s*\[\]/, `promos:\n${snippet}`)
  }
  // Already has items — append after the last item
  return yaml.trimEnd() + '\n\n' + snippet
}

/** Lightweight YAML validation — returns null if OK, error message if not. */
function validateRollingYaml(yaml: string): string | null {
  const endDate = extractTotalEndDate(yaml)
  if (!endDate) return 'total_end_date is required (format: YYYY-MM-DD)'
  // Check it looks like a date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return `total_end_date "${endDate}" is not a valid YYYY-MM-DD date`
  return null
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
  const [modalState, setModalState] = useState<ModalState>('setup')
  const [error, setError] = useState('')

  // ── Setup state ───────────────────────────────────────────────────────────
  // The date picker is a "helper" that keeps total_end_date in sync with the YAML
  const [totalEndDate, setTotalEndDate] = useState('')
  const [yamlContent, setYamlContent] = useState(() => buildRollingSessionYaml(''))
  const [yamlError, setYamlError] = useState<string | null>(null)
  const [promoGroupCatalog, setPromoGroupCatalog] = useState<PromoGroupResponse[]>([])
  const [promosCatalog, setPromosCatalog] = useState<PromoResponse[]>([])
  const [showPromoDropdown, setShowPromoDropdown] = useState(false)
  const [promoSearch, setPromoSearch] = useState('')
  const [savingSetup, setSavingSetup] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
    getPromos(retailerAccountId).then(setPromosCatalog).catch(() => null)
  }, [open, retailerAccountId])

  // ── When opened fresh (no session), reset YAML skeleton ──────────────────
  useEffect(() => {
    if (!open) return
    if (!existingSession) {
      const skeleton = buildRollingSessionYaml(totalEndDate)
      setYamlContent(skeleton)
      setYamlError(null)
    }
  }, [open])

  // ── When opened in edit mode, pre-populate YAML from existing session ────
  useEffect(() => {
    if (!open || !existingSession) return
    setModalState('setup')
    setTotalEndDate(existingSession.total_end_date)
    getSessionPromoSchedules(existingSession.session_id).then(rows => {
      let yaml = buildRollingSessionYaml(existingSession.total_end_date)
      // Rebuild with existing promos
      if (rows.length > 0) {
        const promoLines = rows.map(r => {
          const lines = [`  - name: "${r.promo_group_name}"`]
          if (r.promo_name && r.promo_name !== r.promo_group_name) {
            lines.push(`    promo_name: "${r.promo_name}"`)
          }
          lines.push(`    start: "${r.start_date}"`, `    end: "${r.end_date}"`, `    multiplier: ${r.demand_multiplier}`)
          return lines.join('\n')
        }).join('\n\n')
        yaml = yaml.replace(/promos:\s*\[\]/, `promos:\n${promoLines}`)
      }
      setYamlContent(yaml)
      setYamlError(null)
    }).catch(() => null)
  }, [open, existingSession?.session_id])

  // ── Cleanup poll on unmount ───────────────────────────────────────────────
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current) }, [])

  // ── Keep date picker in sync with YAML ────────────────────────────────────
  function handleYamlChange(val: string) {
    setYamlContent(val)
    const parsed = extractTotalEndDate(val)
    if (parsed) setTotalEndDate(parsed)
    setYamlError(null)
  }

  // ── Date picker changes update the YAML ───────────────────────────────────
  function handleDatePickerChange(newDate: string) {
    setTotalEndDate(newDate)
    setYamlContent(prev => {
      if (extractTotalEndDate(prev)) {
        return replaceTotalEndDate(prev, newDate)
      }
      return buildRollingSessionYaml(newDate)
    })
  }

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
    // Client-side YAML validation
    const validErr = validateRollingYaml(yamlContent)
    if (validErr) { setYamlError(validErr); return }

    const endDate = extractTotalEndDate(yamlContent)
    if (!endDate) { setYamlError('total_end_date is required'); return }
    if (new Date(endDate) <= new Date(baseEndDate)) {
      setYamlError('total_end_date must be after the base simulation end date.'); return
    }
    setError('')
    setYamlError(null)
    setSavingSetup(true)
    try {
      // Create OR update session via YAML POST. Backend is idempotent on session_id
      // — for an existing active session it replaces extension_promo_schedules,
      // updates total_end_date, and invalidates+regenerates post-current demand.
      const sess = await createRollingSessionYaml(baseSimulationId, yamlContent)
      setSession(sess)
      onSessionUpdated(sess)

      // Generate demand — start from day after last completed chunk (or base end date for first run)
      const demandStartDate = sess.current_completed_week
        ? new Date(new Date(sess.current_completed_week + 'T12:00:00').getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10)
        : baseEndDate
      setDemandStatus('generating')
      const job = await generateExtensionDemand({
        session_id: sess.session_id,
        simulation_id: baseSimulationId,
        retailer_account_id: retailerAccountId,
        start_date: demandStartDate,
        end_date: endDate,
        seed: baseSeed,
      })

      pollDemandJob(job.job_id, sess)
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
          onDemandReady?.([])
          onClose()
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
    if (!session) { setError('No active session.'); return }
    const currentStart = session.current_completed_week || baseEndDate
    if (chunkEndDate && new Date(chunkEndDate) <= new Date(currentStart)) {
      setError('Chunk end date must be after the current completed week.'); return
    }
    setError('')
    setModalState('chunk_running')
    try {
      const result = await runRollingChunk(session.session_id, {})
      setLastChunkResult(result)

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

  // ── Add promo snippet via dropdown ────────────────────────────────────────
  function handleAddPromo(promo: PromoResponse) {
    const today = new Date().toISOString().slice(0, 10)
    const weekLater = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    setYamlContent(prev => appendPromoSnippet(
      prev,
      promo.promo_group_name ?? promo.promo_name,
      promo.promo_name,
      today,
      weekLater,
      promo.demand_multiplier,
    ))
    setShowPromoDropdown(false)
    setPromoSearch('')
    // Scroll textarea to bottom so user sees the appended snippet
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.scrollTop = textareaRef.current.scrollHeight
      }
    }, 50)
  }

  // Build a map of group name → individual promos for grouped picker display
  const promosByGroup = promosCatalog.reduce<Record<string, PromoResponse[]>>((acc, p) => {
    const key = p.promo_group_name ?? ''
    if (key) { acc[key] = acc[key] ?? []; acc[key].push(p) }
    return acc
  }, {})

  const filteredGroups = promoGroupCatalog.filter(g =>
    promoSearch === '' ||
    g.promo_group_name.toLowerCase().includes(promoSearch.toLowerCase()) ||
    (g.category ?? '').toLowerCase().includes(promoSearch.toLowerCase()) ||
    (g.brand ?? '').toLowerCase().includes(promoSearch.toLowerCase()) ||
    (promosByGroup[g.promo_group_name] ?? []).some(p =>
      p.promo_name.toLowerCase().includes(promoSearch.toLowerCase())
    )
  )

  // ── Render ────────────────────────────────────────────────────────────────

  const currentStart = session?.current_completed_week || baseEndDate
  const totalEnd = session?.total_end_date || totalEndDate

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

                {/* Date helper — keeps total_end_date in sync with the YAML */}
                <FormField label="Total Forecast End Date" info="Sets total_end_date in the YAML. You can also type it directly in the editor below.">
                  <input
                    type="date"
                    value={totalEndDate}
                    min={baseEndDate}
                    onChange={e => handleDatePickerChange(e.target.value)}
                    className={inputCls}
                  />
                </FormField>

                {/* Add promo dropdown */}
                <div className="relative">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">
                      Promo Schedule YAML
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowPromoDropdown(v => !v)}
                      className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600 hover:text-amber-700"
                    >
                      <Plus size={11} /> Add promo
                      <ChevronDown size={10} className={showPromoDropdown ? 'rotate-180 transition-transform' : 'transition-transform'} />
                    </button>
                  </div>

                  {showPromoDropdown && (
                    <div className="absolute right-0 top-6 z-20 w-72 rounded-xl border border-charcoal-blue-100 bg-white shadow-xl p-3 space-y-2">
                      <input
                        value={promoSearch}
                        onChange={e => setPromoSearch(e.target.value)}
                        placeholder="Search promo groups…"
                        className={inputCls}
                        autoFocus
                      />
                      <div className="max-h-56 overflow-y-auto space-y-1">
                        {filteredGroups.map(g => {
                          const groupPromos = promosByGroup[g.promo_group_name] ?? []
                          return (
                            <div key={g.promo_group_id}>
                              {/* Group header — non-clickable label */}
                              <p className="px-2 pt-1.5 pb-0.5 text-[9px] font-bold uppercase tracking-widest text-charcoal-blue-400">
                                {g.promo_group_name}
                                {(g.category || g.brand) && (
                                  <span className="ml-1.5 font-normal normal-case text-charcoal-blue-300">{[g.category, g.brand].filter(Boolean).join(' · ')}</span>
                                )}
                              </p>
                              {groupPromos.length > 0 ? (
                                groupPromos.map(p => (
                                  <button
                                    key={p.promo_id}
                                    type="button"
                                    onClick={() => handleAddPromo(p)}
                                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[10px] hover:bg-charcoal-blue-50 border border-transparent hover:border-charcoal-blue-100"
                                  >
                                    <Plus size={9} className="flex-shrink-0 text-amber-500" />
                                    <span className="flex-1 font-semibold text-charcoal-blue-800 truncate">{p.promo_name}</span>
                                    <span className="text-charcoal-blue-400 tabular-nums">×{p.demand_multiplier.toFixed(2)}</span>
                                  </button>
                                ))
                              ) : (
                                /* Fallback — no individual promos; click the group itself */
                                <button
                                  type="button"
                                  onClick={() => handleAddPromo({ ...g, promo_id: g.promo_group_id, promo_name: g.promo_group_name, event_type: '', start_date: null, end_date: null, demand_multiplier: 1.0, post_promo_decay_days: 0, post_promo_decay_shape: 'LINEAR', store_ids: [] } as PromoResponse)}
                                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[10px] hover:bg-charcoal-blue-50 border border-transparent hover:border-charcoal-blue-100"
                                >
                                  <Plus size={9} className="flex-shrink-0 text-amber-500" />
                                  <span className="flex-1 font-semibold text-charcoal-blue-800 truncate">{g.promo_group_name}</span>
                                  <span className="text-charcoal-blue-300">×1.00</span>
                                </button>
                              )}
                            </div>
                          )
                        })}
                        {filteredGroups.length === 0 && (
                          <p className="text-center text-[10px] text-charcoal-blue-400 py-2">No promos found</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* YAML editor textarea */}
                <div className="space-y-1">
                  <textarea
                    ref={textareaRef}
                    value={yamlContent}
                    onChange={e => handleYamlChange(e.target.value)}
                    spellCheck={false}
                    rows={14}
                    className={[
                      'w-full rounded-xl border bg-charcoal-blue-50/40 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-charcoal-blue-900',
                      'placeholder:text-charcoal-blue-300 resize-y transition-all focus:outline-none focus:ring-2',
                      yamlError
                        ? 'border-rose-300 focus:border-rose-400 focus:ring-rose-100'
                        : 'border-charcoal-blue-200 focus:border-amber-400 focus:ring-amber-100',
                    ].join(' ')}
                    placeholder={buildRollingSessionYaml('')}
                  />
                  {yamlError && (
                    <p className="flex items-center gap-1.5 text-[10px] font-semibold text-rose-600">
                      <AlertCircle size={11} /> {yamlError}
                    </p>
                  )}
                </div>

                <button
                  onClick={handleSaveAndPreview}
                  disabled={savingSetup || demandStatus === 'generating'}
                  className="w-full rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-white transition-all hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {demandStatus === 'generating'
                    ? <><Loader2 size={13} className="animate-spin" /> Generating demand…</>
                    : savingSetup
                      ? <><Loader2 size={13} className="animate-spin" /> Saving…</>
                      : existingSession ? <>Regenerate Demand <ChevronRight size={13} /></> : <>Generate Demand <ChevronRight size={13} /></>}
                </button>
              </div>
            )}

            {/* ── DEMAND PREVIEW ───────────────────────────────────────────── */}
            {modalState === 'demand_preview' && (
              <div className="space-y-4">
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

                {(() => {
                  const nextChunkEnd = currentStart
                    ? (() => {
                        const d = new Date(currentStart + 'T12:00:00')
                        d.setDate(d.getDate() + 4 * 7)
                        const raw = d.toISOString().slice(0, 10)
                        return raw > totalEnd ? totalEnd : raw
                      })()
                    : ''
                  return (
                    <div className="rounded-xl border border-charcoal-blue-100 bg-charcoal-blue-50 px-4 py-3">
                      <p className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400 mb-1">
                        Next Chunk
                      </p>
                      <p className="text-xs font-bold text-charcoal-blue-800">
                        {currentStart} → {nextChunkEnd}
                        <span className="ml-2 font-normal text-charcoal-blue-500">(4 weeks)</span>
                      </p>
                    </div>
                  )
                })()}

                <button
                  onClick={handleRunChunk}
                  disabled={demandStatus === 'generating'}
                  className="w-full rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-white transition-all hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Run 4 Weeks
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
