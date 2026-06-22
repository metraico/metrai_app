'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Loader2, AlertCircle, Plus } from 'lucide-react'
import { getSessionPromoSchedules, runRollingChunkYaml, buildRunChunkYaml } from '@/lib/api/simulation'
import { getPromoGroups } from '@/lib/api/promos'
import type { RollingForecastSession, RunChunkResponse, PromoGroupResponse } from '@/lib/api/types'
import yaml from 'js-yaml'

const SIM_CHUNK_WEEKS = 4
const FORECAST_CHUNK_WEEKS = 12
const DEFAULT_SEQUENCE = ['SIM', 'FORECAST', 'SIM', 'FORECAST', 'SIM']

/** Add `weeks` weeks to a YYYY-MM-DD date string. */
function addWeeks(dateStr: string, weeks: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + weeks * 7)
  return d.toISOString().slice(0, 10)
}

/** Clamp a date to not exceed a ceiling. */
function clampDate(dateStr: string, ceiling: string): string {
  return dateStr > ceiling ? ceiling : dateStr
}

export interface RunChunkModalProps {
  open: boolean
  onClose: () => void
  session: RollingForecastSession
  baseEndDate: string
  onChunkComplete: (result: RunChunkResponse) => void
}

export function RunChunkModal({
  open, onClose, session, baseEndDate, onChunkComplete,
}: RunChunkModalProps) {
  const currentStart = session.current_completed_week || baseEndDate
  const totalEnd = session.total_end_date

  // Determine next chunk_type from the session sequence (1-based chunk_number).
  const sequence = session.chunk_type_sequence && session.chunk_type_sequence.length > 0
    ? session.chunk_type_sequence
    : DEFAULT_SEQUENCE
  const nextChunkNumber = (session.chunks?.length ?? 0) + 1
  const nextChunkType = (sequence[nextChunkNumber - 1] ?? 'SIM') as 'SIM' | 'FORECAST'
  const isForecast = nextChunkType === 'FORECAST'
  const chunkWeeks = isForecast ? FORECAST_CHUNK_WEEKS : SIM_CHUNK_WEEKS

  // Fixed chunk end, clamped so it doesn't exceed the session total end date
  const chunkEndDate = clampDate(addWeeks(currentStart, chunkWeeks), totalEnd)

  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [yamlText, setYamlText] = useState('')
  const [loadingPromos, setLoadingPromos] = useState(false)

  // Promo groups for the "Add promo" picker
  const [promoGroups, setPromoGroups] = useState<PromoGroupResponse[]>([])
  const [showPicker, setShowPicker] = useState(false)

  // Fetch active promo schedule entries for this chunk window and promo groups on open.
  // For FORECAST chunks no promo performance is needed — submit an empty performance list.
  useEffect(() => {
    if (!open || !currentStart || !chunkEndDate) {
      setYamlText('')
      return
    }
    setError('')
    setShowPicker(false)

    if (isForecast) {
      setLoadingPromos(false)
      setYamlText('performance: []\n')
      return
    }

    setLoadingPromos(true)
    Promise.all([
      getSessionPromoSchedules(session.session_id, currentStart, chunkEndDate),
      getPromoGroups(session.retailer_account_id),
    ])
      .then(([schedules, groups]) => {
        setPromoGroups(groups)
        setYamlText(buildRunChunkYaml(schedules, currentStart, chunkEndDate, session.session_id))
      })
      .catch(() => {
        setYamlText(buildRunChunkYaml([], currentStart, chunkEndDate, session.session_id))
      })
      .finally(() => setLoadingPromos(false))
  }, [open, session.session_id, session.retailer_account_id, currentStart, chunkEndDate, isForecast])

  /** Names already present in the YAML textarea (to filter picker). */
  function namesInYaml(): Set<string> {
    const found = new Set<string>()
    const lines = yamlText.split('\n')
    for (const line of lines) {
      const m = line.match(/promo_group_name:\s*["']?([^"'\n]+)["']?/)
      if (m) found.add(m[1].trim())
    }
    return found
  }

  function appendPromoBlock(groupName: string) {
    const block = [
      '',
      `  - schedule_id: ""`,
      `    promo_group_name: ${groupName}`,
      `    pct: 0`,
    ].join('\n')

    // If the textarea ends with the empty-list form, replace it with a proper sequence
    let base = yamlText
    if (base.trim().endsWith('performance: []')) {
      base = base.replace('performance: []', 'performance:')
    }
    // Remove trailing newline then append
    setYamlText(base.replace(/\n+$/, '') + '\n' + block + '\n')
    setShowPicker(false)
  }

  async function handleRun() {
    setError('')

    // Client-side YAML parse check
    try {
      yaml.load(yamlText)
    } catch (e: any) {
      setError('Invalid YAML: ' + (e?.message ?? 'parse error'))
      return
    }

    setRunning(true)
    try {
      const result = await runRollingChunkYaml(session.session_id, yamlText)
      onChunkComplete(result)
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  const unavailableNames = namesInYaml()
  const pickerGroups = promoGroups.filter(g => !unavailableNames.has(g.promo_group_name))

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg rounded-2xl p-0 shadow-2xl bg-white">
        <div className="border-b border-charcoal-blue-100 px-6 py-4 pr-12">
          <DialogTitle className="text-sm font-bold text-charcoal-blue-900">
            {isForecast ? 'Run FORECAST Chunk' : 'Run Simulation Chunk'}
          </DialogTitle>
          <p className="text-[10px] text-charcoal-blue-400 mt-0.5">
            {isForecast
              ? `Next chunk: FORECAST (${chunkWeeks} weeks, ${currentStart} → ${chunkEndDate}). This chunk runs automatically with no promo performance input. Click 'Run FORECAST' to dispatch.`
              : `Review the next ${chunkWeeks}-week chunk, then enter how your promos actually performed.`}
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
              <span className="whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}

          {/* Fixed chunk window — read-only label */}
          <div className="rounded-xl border border-charcoal-blue-100 bg-charcoal-blue-50 px-4 py-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400 mb-1">
              Next Chunk {isForecast ? '— FORECAST' : '— SIM'}
            </p>
            <p className="text-xs font-bold text-charcoal-blue-800">
              {currentStart} → {chunkEndDate}
              <span className="ml-2 font-normal text-charcoal-blue-500">({chunkWeeks} weeks)</span>
            </p>
          </div>

          {/* FORECAST: read-only notice, no editor */}
          {isForecast ? (
            <div className="rounded-xl border border-majorelle-blue-100 bg-majorelle-blue-50/40 px-4 py-3 text-[11px] text-charcoal-blue-700 leading-relaxed">
              FORECAST chunks run automatically with no promo performance input.
              The engine will project demand using the carry-forward multipliers
              from previous SIM chunks. Click <strong>Run FORECAST</strong> to dispatch.
            </div>
          ) : /* YAML editor */
          loadingPromos ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-charcoal-blue-400">
              <Loader2 size={12} className="animate-spin" /> Loading promo schedules…
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">
                  Performance YAML
                </label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowPicker(v => !v)}
                    className="flex items-center gap-1 rounded-lg border border-charcoal-blue-200 px-2 py-1 text-[10px] font-semibold text-charcoal-blue-600 hover:bg-charcoal-blue-50"
                  >
                    <Plus size={10} /> Add promo
                  </button>
                  {showPicker && pickerGroups.length > 0 && (
                    <div className="absolute right-0 top-full mt-1 z-10 w-52 rounded-xl border border-charcoal-blue-200 bg-white shadow-lg overflow-hidden">
                      <div className="max-h-48 overflow-y-auto">
                        {pickerGroups.map(g => (
                          <button
                            key={g.promo_group_id}
                            type="button"
                            onClick={() => appendPromoBlock(g.promo_group_name)}
                            className="w-full text-left px-3 py-2 text-[10px] text-charcoal-blue-800 hover:bg-charcoal-blue-50 truncate"
                          >
                            {g.promo_group_name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {showPicker && pickerGroups.length === 0 && (
                    <div className="absolute right-0 top-full mt-1 z-10 w-52 rounded-xl border border-charcoal-blue-200 bg-white shadow-lg px-3 py-2 text-[10px] text-charcoal-blue-400">
                      All promo groups already added
                    </div>
                  )}
                </div>
              </div>

              <textarea
                value={yamlText}
                onChange={e => setYamlText(e.target.value)}
                rows={12}
                spellCheck={false}
                className="w-full rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50/30 px-3 py-3 font-mono text-[11px] text-charcoal-blue-800 focus:border-majorelle-blue-400 focus:outline-none resize-y leading-relaxed"
              />
              <p className="text-[10px] text-charcoal-blue-400">
                Leave <code className="text-[10px] bg-charcoal-blue-100 px-1 rounded">pct: 0</code> for promos that ran as planned. Use a blank <code className="text-[10px] bg-charcoal-blue-100 px-1 rounded">performance: []</code> to run with no overrides.
              </p>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              disabled={running}
              className="flex-1 rounded-xl border border-charcoal-blue-200 py-2.5 text-xs font-bold text-charcoal-blue-600 hover:bg-charcoal-blue-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleRun}
              disabled={running || loadingPromos}
              className="flex-1 rounded-xl bg-majorelle-blue-500 py-2.5 text-xs font-bold text-white hover:bg-majorelle-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {running
                ? <><Loader2 size={13} className="animate-spin" /> Running…</>
                : isForecast
                  ? `Run FORECAST (${chunkWeeks} weeks)`
                  : `Run ${chunkWeeks} Weeks`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
