'use client'

import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '@/lib/store/authStore'
import {
  generateExtensionDemand, getDemandStatus, getDemandWeeklyTotals,
  createRollingSessionYaml, runRollingChunk, recalculateRollingDemand, getSessionPromoSchedules,
  generateBranches,
} from '@/lib/api/simulation'
import yaml from 'js-yaml'
import { getPromoGroups, getPromos } from '@/lib/api/promos'
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog'
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { Check, AlertCircle, Plus, ChevronRight, Loader2, ChevronDown, GitBranch, Lock } from 'lucide-react'
import type { PromoGroupResponse, PromoResponse, RollingForecastSession, PerformanceInput } from '@/lib/api/types'
import { computeBranchOverrideRows } from './branch-overrides'
import { toIsoWeek, formatDateUS, parseToISO, formatDateDisplay } from '@/lib/utils'
import { DatePickerField } from '@/components/ui/date-picker-field'

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
    `#   event       — optional: specific promo event type e.g. BOGO Ad, 2/$6 Ad (display/audit only)`,
    `#   start/end   — MM-DD-YYYY, end must be >= start`,
    `#   multiplier  — 1.0 = baseline, 1.25 = +25% demand boost`,
    ``,
    `total_end_date: "${formatDateUS(totalEndDate)}"`,
    ``,
    `promos: []`,
  ].join('\n')
}

/** Parse total_end_date out of the YAML string. Returns YYYY-MM-DD regardless of input format. */
function extractTotalEndDate(yaml: string): string {
  const m = yaml.match(/^total_end_date:\s*["']?(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})["']?/m)
  return m ? parseToISO(m[1]) : ''
}

/** Replace the total_end_date line in the YAML with a new date (written as MM-DD-YYYY). */
function replaceTotalEndDate(yaml: string, newDate: string): string {
  return yaml.replace(
    /^(total_end_date:\s*)["']?(?:\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})["']?/m,
    `$1"${newDate}"`,
  )
}

/** Append a promo snippet at the end of the YAML (replacing `promos: []` if present). */
function appendPromoSnippet(
  yaml: string,
  promoGroupName: string,
  eventType: string | null,
  startDate: string,
  endDate: string,
  multiplier = 1.0,
): string {
  const nameLines = eventType
    ? `  - name: "${promoGroupName}"\n    event: "${eventType}"\n`
    : `  - name: "${promoGroupName}"\n`
  const snippet = `${nameLines}    start: "${formatDateUS(startDate)}"\n    end: "${formatDateUS(endDate)}"\n    multiplier: ${multiplier}`

  // Replace `promos: []` with a proper list
  if (/promos:\s*\[\]/.test(yaml)) {
    return yaml.replace(/promos:\s*\[\]/, `promos:\n${snippet}`)
  }
  // Already has items — append after the last item
  return yaml.trimEnd() + '\n\n' + snippet
}

/** Lightweight YAML validation — returns null if OK, error message if not.
 *  baseEndDateISO (the base simulation's own end week, YYYY-MM-DD) is required to check
 *  that every promo actually falls inside the forecastable window — a promo dated outside
 *  [baseEndDate, total_end_date] can never affect the simulation (there's no forecast for
 *  it to apply to), so this is a hard error, not a soft nudge like the multi-week linter. */
function validateRollingYaml(yamlText: string, baseEndDateISO: string): string | null {
  const endDate = extractTotalEndDate(yamlText)
  if (!endDate) return 'total_end_date is required (format: MM-DD-YYYY)'
  // extractTotalEndDate normalises to YYYY-MM-DD internally
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return `total_end_date "${endDate}" is not a valid date`

  let parsed: any
  try {
    parsed = yaml.load(yamlText)
  } catch {
    return null // yamlError already surfaces parse failures separately
  }
  const promos = parsed?.promos
  if (Array.isArray(promos)) {
    for (const p of promos) {
      if (!p?.start || !p?.end) continue
      const label = `${p.name ?? 'Promo'}${p.event ? ` · ${p.event}` : ''}`
      const startISO = parseToISO(String(p.start))
      const endISO = parseToISO(String(p.end))
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startISO) || !/^\d{4}-\d{2}-\d{2}$/.test(endISO)) {
        return `${label}: start/end must be a valid date (MM-DD-YYYY)`
      }
      if (endISO < startISO) return `${label}: end date is before its start date`
      if (startISO <= baseEndDateISO) {
        return `${label}: starts ${formatDateDisplay(startISO)}, on or before the base simulation's end date (${formatDateDisplay(baseEndDateISO)}) — it must fall inside the forecast window, not before it`
      }
      if (endISO > endDate) {
        return `${label}: ends ${formatDateDisplay(endISO)}, after the Total Forecast End Date (${formatDateDisplay(endDate)}) — extend the forecast window or shorten the promo`
      }
    }
  }
  return null
}

// ── Multi-week promo linter ───────────────────────────────────────────────────
// The simulation engine buckets demand by ISO week (Mon–Sun) and applies a promo's
// full multiplier to EVERY week any part of [start, end] touches — there's no
// partial-week effect. A promo range that crosses a week boundary silently boosts
// two (or more) weeks instead of one. This is a non-blocking nudge, not a guard —
// see _apply_promo_yaml_overrides in the engine for where that'd need to be enforced.

/** Monday→Sunday bounds (US display format) of the ISO week containing a YYYY-MM-DD date. */
function weekBoundsUS(iso: string): { start: string; end: string } {
  const d = new Date(iso + 'T12:00:00')
  const dow = d.getDay() || 7 // Mon=1 .. Sun=7
  const monday = new Date(d)
  monday.setDate(d.getDate() - (dow - 1))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const asISO = (x: Date) => x.toISOString().slice(0, 10)
  return { start: formatDateDisplay(asISO(monday)), end: formatDateDisplay(asISO(sunday)) }
}

/** Count distinct ISO weeks touched by [startISO, endISO] — mirrors the engine's day-by-day bucketing. */
function countIsoWeeksSpanned(startISO: string, endISO: string): number {
  const seen = new Set<string>()
  const cur = new Date(startISO + 'T12:00:00')
  const end = new Date(endISO + 'T12:00:00')
  while (cur <= end) {
    seen.add(toIsoWeek(cur.toISOString().slice(0, 10)))
    cur.setDate(cur.getDate() + 1)
  }
  return seen.size
}

interface PromoWeekWarning {
  key: string
  name: string
  event?: string
  start: string
  end: string
  weeksSpanned: number
  startWeek: { start: string; end: string }
  endWeek: { start: string; end: string }
}

/** Parse the promo YAML and flag any entry whose [start, end] spans more than one ISO week. */
function findMultiWeekPromoWarnings(yamlText: string): PromoWeekWarning[] {
  let parsed: any
  try {
    parsed = yaml.load(yamlText)
  } catch {
    return [] // yamlError already surfaces parse failures — don't double-report here
  }
  const promos = parsed?.promos
  if (!Array.isArray(promos)) return []

  const warnings: PromoWeekWarning[] = []
  promos.forEach((p: any, idx: number) => {
    if (!p?.start || !p?.end) return
    const startISO = parseToISO(String(p.start))
    const endISO = parseToISO(String(p.end))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startISO) || !/^\d{4}-\d{2}-\d{2}$/.test(endISO)) return

    const weeksSpanned = countIsoWeeksSpanned(startISO, endISO)
    if (weeksSpanned <= 1) return

    warnings.push({
      key: `${p.name ?? 'promo'}-${idx}`,
      name: String(p.name ?? 'Promo'),
      event: p.event ? String(p.event) : undefined,
      start: formatDateDisplay(startISO),
      end: formatDateDisplay(endISO),
      weeksSpanned,
      startWeek: weekBoundsUS(startISO),
      endWeek: weekBoundsUS(endISO),
    })
  })
  return warnings
}

// ── Locked (already-simulated) promo rows ─────────────────────────────────────
// A promo row is "locked" once its window has already been covered by a completed
// chunk (row.end_date <= session.current_completed_week) — editing it wouldn't
// change what already ran, so it's excluded from the editable YAML textarea and
// shown read-only instead. It still must be re-submitted on save, since the
// backend wholesale-replaces extension_promo_schedules for the session
// (DELETE + re-INSERT from the posted `promos` list — see create_rolling_session).

interface PromoScheduleRow {
  id: string
  promo_name: string
  promo_group_name: string
  start_date: string
  end_date: string
  demand_multiplier: number
  performance_pct: number | null
  original_multiplier: number | null
}

function isPromoRowLocked(row: PromoScheduleRow, currentCompletedWeek: string): boolean {
  return !!currentCompletedWeek && row.end_date <= currentCompletedWeek
}

/** Render one promo row as a YAML list-item block (used both for editable rows and
 *  when re-appending locked rows to the submitted YAML). */
function promoRowToYamlBlock(row: PromoScheduleRow): string {
  const lines = [`  - name: "${row.promo_group_name}"`]
  if (row.promo_name && row.promo_name !== row.promo_group_name) {
    lines.push(`    event: "${row.promo_name}"`)
  }
  lines.push(
    `    start: "${formatDateUS(row.start_date)}"`,
    `    end: "${formatDateUS(row.end_date)}"`,
    `    multiplier: ${row.demand_multiplier}`,
  )
  return lines.join('\n')
}

/** Re-append locked promo rows to the (editable) YAML right before submission —
 *  they're hidden from the textarea but must still reach the backend, or the
 *  wholesale replace in create_rolling_session would delete them. */
function appendLockedPromosToYaml(yamlText: string, lockedRows: PromoScheduleRow[]): string {
  if (lockedRows.length === 0) return yamlText
  const blocks = lockedRows.map(promoRowToYamlBlock).join('\n\n')
  if (/promos:\s*\[\]/.test(yamlText)) {
    return yamlText.replace(/promos:\s*\[\]/, `promos:\n${blocks}`)
  }
  return yamlText.trimEnd() + '\n\n' + blocks + '\n'
}

// ── Branch helpers ────────────────────────────────────────────────────────────

function addWeeks(dateStr: string, weeks: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + weeks * 7)
  return d.toISOString().slice(0, 10)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function clampDate(dateStr: string, ceiling: string): string {
  return dateStr > ceiling ? ceiling : dateStr
}

type ModalState =
  | 'setup'
  | 'demand_preview'
  | 'chunk_running'
  | 'performance_input'
  | 'recalc_demand'
  | 'all_complete'
  | 'branch_preview'

export interface RollingForecastModalProps {
  open: boolean
  onClose: () => void
  baseSimulationId: string
  retailerAccountId: string
  baseSeed: number
  baseEndDate: string   // YYYY-MM-DD
  // True when baseSimulationId is a scoped extension — its own weekly_demand pool
  // (demand_pool_id) lives under its own simulation_id, not the account-wide shared pool.
  isScopedExtension?: boolean
  // The scoped extension's own item scope (its full_config.scope_item_ids) — used to filter
  // the "Add promo" picker down to promo groups that actually touch this scope, instead of
  // every promo group in the account (e.g. a Coke 2L extension shouldn't offer DORITOS promos).
  scopeItemIds?: string[]
  existingSession: RollingForecastSession | null
  onSessionUpdated: (session: RollingForecastSession | null) => void
  onDemandReady?: (promos: { promo_group_name: string; promo_name: string; start_date: string; end_date: string; demand_multiplier: number }[]) => void
}

export function RollingForecastModal({
  open, onClose, baseSimulationId, retailerAccountId, baseSeed,
  baseEndDate, isScopedExtension, scopeItemIds, existingSession, onSessionUpdated, onDemandReady,
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
  // Promo rows already covered by a completed chunk — shown read-only, re-appended
  // to the YAML on save (see appendLockedPromosToYaml).
  const [lockedPromoRows, setLockedPromoRows] = useState<PromoScheduleRow[]>([])
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

  // ── Branch forecast state ─────────────────────────────────────────────────
  const [branchYamlReactive, setBranchYamlReactive] = useState('')
  const [branchYamlAdaptive, setBranchYamlAdaptive] = useState('')
  const [branchRunning, setBranchRunning] = useState(false)
  const [branchError, setBranchError] = useState('')
  const [loadingBranches, setLoadingBranches] = useState(false)

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
      setLockedPromoRows([])
    }
  }, [open])

  // ── When opened in edit mode, pre-populate YAML from existing session ────
  // Promo rows already covered by a completed chunk are locked — kept out of the
  // editable YAML (and shown read-only instead), since editing what already ran
  // wouldn't change the historical result.
  useEffect(() => {
    if (!open || !existingSession) return
    setModalState('setup')
    setTotalEndDate(existingSession.total_end_date)
    const currentCompletedWeek = existingSession.current_completed_week || ''
    getSessionPromoSchedules(existingSession.session_id).then(rows => {
      const locked = rows.filter(r => isPromoRowLocked(r, currentCompletedWeek))
      const editable = rows.filter(r => !isPromoRowLocked(r, currentCompletedWeek))
      setLockedPromoRows(locked)

      let yaml = buildRollingSessionYaml(existingSession.total_end_date)
      if (editable.length > 0) {
        yaml = yaml.replace(/promos:\s*\[\]/, `promos:\n${editable.map(promoRowToYamlBlock).join('\n\n')}`)
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
    // HTML date input returns YYYY-MM-DD; store internally as YYYY-MM-DD but write MM-DD-YYYY to YAML
    setTotalEndDate(newDate)
    setYamlContent(prev => {
      if (extractTotalEndDate(prev)) {
        return replaceTotalEndDate(prev, formatDateUS(newDate))
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
      const rows = await getDemandWeeklyTotals(
        retailerAccountId, startWeek, endWeek, baseSeed,
        undefined, isScopedExtension ? baseSimulationId : undefined,
      )
      setChartData(rows.map(r => ({ week: r.pos_week, demand_qty: r.demand_qty })))
    } catch {
      setChartData([])
    }
  }

  // ── Step: Save setup and generate demand ─────────────────────────────────
  async function handleSaveAndPreview() {
    // Client-side YAML validation
    const validErr = validateRollingYaml(yamlContent, baseEndDate)
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
      // Locked (already-simulated) promo rows aren't in the editable YAML — re-append
      // them here so the backend's wholesale replace doesn't drop them.
      const submittedYaml = appendLockedPromosToYaml(yamlContent, lockedPromoRows)
      const sess = await createRollingSessionYaml(baseSimulationId, submittedYaml)
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
          // Full-session fetch (no date range) — these are the promos the USER scheduled
          // via this session's own YAML (extension_promo_schedules), used by the dashboard
          // to highlight upcoming promo weeks in orange before any chunk has actually run.
          try {
            const schedules = await getSessionPromoSchedules(sess.session_id)
            onDemandReady?.(schedules.map(s => ({
              promo_group_name: s.promo_group_name, promo_name: s.promo_name,
              start_date: s.start_date, end_date: s.end_date, demand_multiplier: s.demand_multiplier,
            })))
          } catch {
            onDemandReady?.([])
          }
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
    // Default into the still-open forecast window — the day after the last completed
    // chunk (or the base sim's own end date, before any chunk has run yet) through one
    // week later, clamped to the chosen Total Forecast End Date. Previously this used
    // today's real wall-clock date, which lands wildly outside the window whenever "today"
    // isn't inside [baseEndDate, total_end_date] — e.g. a 2024 forecast window gets a promo
    // dated in 2026, which the engine can never apply (see validateRollingYaml).
    const windowFloor = session?.current_completed_week || baseEndDate
    const windowCeil = extractTotalEndDate(yamlContent) || totalEndDate || windowFloor
    const start = addDays(windowFloor, 1)
    const end = windowCeil && windowCeil < addDays(start, 6) ? windowCeil : addDays(start, 6)
    setYamlContent(prev => appendPromoSnippet(
      prev,
      promo.promo_group_name ?? promo.promo_name,
      promo.event_type || null,
      start,
      end,
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

  // ── Branch forecast handlers ──────────────────────────────────────────────
  async function handleOpenBranchPreview() {
    if (!session) return
    setLoadingBranches(true)
    setBranchError('')
    try {
      const nextEnd = clampDate(addWeeks(currentStart, 4), totalEnd)
      const fetched = await getSessionPromoSchedules(session.session_id, currentStart, nextEnd)
      const header = `# Chunk window: ${formatDateUS(currentStart)} → ${formatDateUS(nextEnd)}  (4 weeks)\n`
      // Single source of truth for the reactive/adaptive formula — shared with the
      // auto-trigger in page.tsx (see ./branch-overrides).
      const rows = computeBranchOverrideRows(session, fetched)
      // pct/promo_group_name are real fields (not just a comment) so they survive
      // editing and round-trip to the backend as the branch_params audit trail —
      // "what did the user see / what was the formula based on" vs. the computed multiplier.
      const reactiveEntries = rows.map(r =>
        `  - schedule_id: "${r.schedule_id}"\n    multiplier: ${r.reactiveMult.toFixed(4)}\n    pct: ${r.reactivePct.toFixed(2)}                # audit only — does not affect the forecast\n    promo_group_name: "${r.promo_group_name}"    # audit only (was ×${r.origMult.toFixed(3)})`
      )
      const adaptiveEntries = rows.map(r =>
        `  - schedule_id: "${r.schedule_id}"\n    multiplier: ${r.adaptiveMult.toFixed(4)}\n    pct: ${r.adaptivePct.toFixed(2)}                # audit only — does not affect the forecast\n    promo_group_name: "${r.promo_group_name}"    # audit only (was ×${r.origMult.toFixed(3)})`
      )

      const buildBranchYaml = (type: string, entries: string[]) =>
        entries.length > 0
          ? header + `branch_type: ${type}\npromo_overrides:\n` + entries.join('\n\n') + '\n'
          : header + `branch_type: ${type}\npromo_overrides: []\n`

      setBranchYamlReactive(buildBranchYaml('reactive', reactiveEntries))
      setBranchYamlAdaptive(buildBranchYaml('adaptive', adaptiveEntries))
      setModalState('branch_preview')
    } catch (e: any) {
      setBranchError(e?.message ?? 'Failed to load branch preview')
    } finally {
      setLoadingBranches(false)
    }
  }

  // Parse the editable branch YAML back into structured overrides. pct/promo_group_name
  // are optional (only present if the user didn't strip them while editing) and are stored
  // server-side purely as an audit trail alongside the computed multiplier.
  function parseBranchOverrides(y: string): { schedule_id: string; multiplier: number; pct?: number; promo_group_name?: string }[] {
    let doc: any = {}
    try { doc = yaml.load(y) || {} } catch { return [] }
    const arr = Array.isArray(doc.promo_overrides) ? doc.promo_overrides : []
    return arr
      .filter((o: any) => o && o.schedule_id != null && o.multiplier != null)
      .map((o: any) => ({
        schedule_id: String(o.schedule_id),
        multiplier: Number(o.multiplier),
        ...(o.pct != null ? { pct: Number(o.pct) } : {}),
        ...(o.promo_group_name != null ? { promo_group_name: String(o.promo_group_name) } : {}),
      }))
  }

  async function handleRunBothBranches() {
    if (!session) return
    setBranchRunning(true)
    setBranchError('')
    try {
      // Demand-only: generates the two forecasted demand curves (no supply-chain sim yet).
      const updated = await generateBranches(session.session_id, {
        seed: baseSeed,
        reactive: parseBranchOverrides(branchYamlReactive),
        adaptive: parseBranchOverrides(branchYamlAdaptive),
      })
      onSessionUpdated(updated)
      onClose()
    } catch (e: any) {
      setBranchError(e?.response?.data?.detail ?? e?.message ?? 'Branch generation failed')
    } finally {
      setBranchRunning(false)
    }
  }

  // Non-blocking nudge — recomputed on every YAML keystroke, see findMultiWeekPromoWarnings above.
  const promoWeekWarnings = findMultiWeekPromoWarnings(yamlContent)

  // Build a map of group name → individual promos for grouped picker display
  const promosByGroup = promosCatalog.reduce<Record<string, PromoResponse[]>>((acc, p) => {
    const key = p.promo_group_name ?? ''
    if (key) { acc[key] = acc[key] ?? []; acc[key].push(p) }
    return acc
  }, {})

  // Scoped extensions only ever simulate scopeItemIds — offering a promo group with none of
  // its items in that set would let the user "add" a promo that can never affect this sim.
  const scopeItemIdSet = scopeItemIds ? new Set(scopeItemIds) : null
  const scopedGroupCatalog = scopeItemIdSet
    ? promoGroupCatalog.filter(g => g.item_ids.some(id => scopeItemIdSet.has(id)))
    : promoGroupCatalog

  const filteredGroups = scopedGroupCatalog.filter(g =>
    promoSearch === '' ||
    g.promo_group_name.toLowerCase().includes(promoSearch.toLowerCase()) ||
    (g.category ?? '').toLowerCase().includes(promoSearch.toLowerCase()) ||
    (g.brand ?? '').toLowerCase().includes(promoSearch.toLowerCase()) ||
    (promosByGroup[g.promo_group_name] ?? []).some(p =>
      p.event_type.toLowerCase().includes(promoSearch.toLowerCase())
    )
  )

  // ── Render ────────────────────────────────────────────────────────────────

  const currentStart = session?.current_completed_week || baseEndDate
  const totalEnd = session?.total_end_date || totalEndDate
  const completedMainChunks = (session?.chunks ?? []).filter(c => c.status === 'completed' && !c.branch_type)

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className={`max-h-[90vh] ${modalState === 'branch_preview' ? 'max-w-3xl' : 'max-w-2xl'} overflow-y-auto rounded-2xl p-0 shadow-2xl bg-white transition-all`}>
          {/* Header */}
          <div className="flex items-center justify-between border-b border-charcoal-blue-100 px-6 py-4 pr-12">
            <div>
              <DialogTitle className="text-sm font-bold text-charcoal-blue-900 flex items-center gap-2">
                {modalState === 'branch_preview' && <GitBranch size={14} className="text-majorelle-blue-500" />}
                Rolling Forecast
              </DialogTitle>
              <p className="text-[10px] text-charcoal-blue-400 mt-0.5">
                {{
                  setup: 'Set up your rolling forecast window and schedule promos',
                  demand_preview: 'Review forecast demand and select next chunk to run',
                  chunk_running: 'Running simulation chunk…',
                  performance_input: 'How did your promos perform?',
                  recalc_demand: 'Recalculating demand with updated multipliers…',
                  all_complete: 'Rolling forecast complete',
                  branch_preview: 'Compare Reactive and Adaptive demand forecasts — edit multipliers if needed, then run both.',
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
                  <DatePickerField
                    value={totalEndDate}
                    onChange={handleDatePickerChange}
                    minDateISO={baseEndDate}
                    inputClassName={inputCls}
                  />
                </FormField>

                {/* Add promo dropdown */}
                <div className="relative">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">
                      Promo Schedule YAML
                    </label>
                    {/* Add promo is only offered during first-time setup — once a session
                        exists (edit setup / regenerate), the schedule is edited via the YAML. */}
                    {!existingSession && (
                      <button
                        type="button"
                        onClick={() => setShowPromoDropdown(v => !v)}
                        className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-600 hover:text-amber-700"
                      >
                        <Plus size={11} /> Add promo
                        <ChevronDown size={10} className={showPromoDropdown ? 'rotate-180 transition-transform' : 'transition-transform'} />
                      </button>
                    )}
                  </div>

                  {!existingSession && showPromoDropdown && (
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
                          const allGroupPromos = promosByGroup[g.promo_group_name] ?? []
                          // Collapse to unique (event_type, multiplier) combos — the specific
                          // dates repeat across the year but get rewritten in the YAML, so only
                          // the event + multiplier distinguish one pickable option from another.
                          const seenPromoKeys = new Set<string>()
                          const groupPromos = allGroupPromos.filter(p => {
                            const key = `${p.event_type ?? ''}|${p.demand_multiplier}`
                            if (seenPromoKeys.has(key)) return false
                            seenPromoKeys.add(key)
                            return true
                          })
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
                                    <span className="flex-1 font-semibold text-charcoal-blue-800 truncate">{[g.promo_group_name, p.event_type].filter(Boolean).join(' · ')}</span>
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

                {/* Already-simulated promos — read-only. These rows fall within a chunk that
                    already ran, so editing them here wouldn't change the historical result;
                    they're re-appended to the YAML on save (see appendLockedPromosToYaml). */}
                {lockedPromoRows.length > 0 && (
                  <div className="space-y-1">
                    <p className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">
                      <Lock size={10} /> Already Simulated — locked
                    </p>
                    <div className="space-y-1 rounded-lg border border-charcoal-blue-100 bg-charcoal-blue-50/60 px-2.5 py-2">
                      {lockedPromoRows.map(row => (
                        <div key={row.id} className="flex items-center gap-2 text-[10px] text-charcoal-blue-500">
                          <Lock size={9} className="flex-shrink-0 text-charcoal-blue-300" />
                          <span className="flex-1 truncate font-semibold text-charcoal-blue-700">
                            {[row.promo_group_name, row.promo_name !== row.promo_group_name ? row.promo_name : null].filter(Boolean).join(' · ')}
                          </span>
                          <span className="text-charcoal-blue-400">{formatDateDisplay(row.start_date)} → {formatDateDisplay(row.end_date)}</span>
                          <span className="tabular-nums text-charcoal-blue-400">×{row.demand_multiplier.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

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
                  {/* Non-blocking nudge: the engine applies a promo's full multiplier to every
                      ISO week its [start, end] touches — a range crossing a week boundary
                      silently boosts 2+ weeks instead of 1. This doesn't stop Generate Demand;
                      it just shows the actual week split so a fat-fingered date is obvious. */}
                  {promoWeekWarnings.length > 0 && (
                    <div className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50/70 px-2.5 py-2">
                      {promoWeekWarnings.map(w => (
                        <p key={w.key} className="flex items-start gap-1.5 text-[10px] font-medium leading-relaxed text-amber-700">
                          <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
                          <span>
                            <span className="font-bold">{w.name}{w.event ? ` · ${w.event}` : ''}</span>
                            {' '}— {w.start} → {w.end} spans {w.weeksSpanned} weeks.{' '}
                            Week of start: <span className="font-semibold">{w.startWeek.start} → {w.startWeek.end}</span>.{' '}
                            Week of end: <span className="font-semibold">{w.endWeek.start} → {w.endWeek.end}</span>.
                          </span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleSaveAndPreview}
                    disabled={savingSetup || demandStatus === 'generating'}
                    className="flex-[2] rounded-xl bg-amber-500 py-2.5 text-xs font-bold text-white transition-all hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {demandStatus === 'generating'
                      ? <><Loader2 size={13} className="animate-spin" /> Generating demand…</>
                      : savingSetup
                        ? <><Loader2 size={13} className="animate-spin" /> Saving…</>
                        : existingSession ? <>Regenerate Demand <ChevronRight size={13} /></> : <>Generate Demand <ChevronRight size={13} /></>}
                  </button>
                  {completedMainChunks.length >= 1 && currentStart < totalEnd && (
                    <button
                      onClick={handleOpenBranchPreview}
                      disabled={loadingBranches || savingSetup}
                      className="flex-1 rounded-xl border border-majorelle-blue-300 py-2.5 text-xs font-bold text-majorelle-blue-600 hover:bg-majorelle-blue-50 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {loadingBranches
                        ? <><Loader2 size={12} className="animate-spin" /> Loading…</>
                        : <><GitBranch size={12} /> Compare Forecasts</>}
                    </button>
                  )}
                </div>
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
                        {formatDateDisplay(currentStart)} → {formatDateDisplay(nextChunkEnd)}
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
                    {formatDateDisplay(currentStart)} → {formatDateDisplay(chunkEndDate)}
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

            {/* ── BRANCH PREVIEW ───────────────────────────────────────────── */}
            {modalState === 'branch_preview' && (
              <div className="space-y-4">
                {branchError && (
                  <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                    <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
                    <span>{branchError}</span>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {/* Reactive panel */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-rose-500" />
                      <span className="text-[9px] font-bold uppercase tracking-widest text-rose-600">Reactive</span>
                    </div>
                    <textarea
                      value={branchYamlReactive}
                      onChange={e => setBranchYamlReactive(e.target.value)}
                      rows={12}
                      spellCheck={false}
                      className="w-full rounded-xl border-2 border-rose-300 bg-rose-50/20 px-3 py-2 font-mono text-[10px] text-charcoal-blue-800 focus:border-rose-400 focus:outline-none resize-none leading-relaxed"
                    />
                    <p className="text-[9px] text-charcoal-blue-400">Full correction — proportional to all past chunks</p>
                  </div>
                  {/* Adaptive panel */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" />
                      <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-600">Adaptive</span>
                    </div>
                    <textarea
                      value={branchYamlAdaptive}
                      onChange={e => setBranchYamlAdaptive(e.target.value)}
                      rows={12}
                      spellCheck={false}
                      className="w-full rounded-xl border-2 border-emerald-300 bg-emerald-50/20 px-3 py-2 font-mono text-[10px] text-charcoal-blue-800 focus:border-emerald-400 focus:outline-none resize-none leading-relaxed"
                    />
                    <p className="text-[9px] text-charcoal-blue-400">Dampened — max ±10% drift from original plan</p>
                  </div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => { setModalState('setup'); setBranchError('') }}
                    disabled={branchRunning}
                    className="flex-1 rounded-xl border border-charcoal-blue-200 py-2.5 text-xs font-bold text-charcoal-blue-600 hover:bg-charcoal-blue-50 disabled:opacity-50"
                  >
                    ← Back
                  </button>
                  <button
                    onClick={handleRunBothBranches}
                    disabled={branchRunning}
                    className="flex-[2] rounded-xl bg-majorelle-blue-500 py-2.5 text-xs font-bold text-white hover:bg-majorelle-blue-600 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {branchRunning
                      ? <><Loader2 size={13} className="animate-spin" /> Running both branches…</>
                      : <><GitBranch size={12} /> Run Both Branches →</>}
                  </button>
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
                    Your simulation now covers through {formatDateDisplay(session?.total_end_date ?? totalEnd)}.
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
