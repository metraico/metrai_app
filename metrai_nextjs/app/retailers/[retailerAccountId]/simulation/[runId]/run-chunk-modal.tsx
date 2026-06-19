'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Loader2, AlertCircle } from 'lucide-react'
import { runRollingChunk, getSessionPromoSchedules } from '@/lib/api/simulation'
import type { RollingForecastSession, RunChunkResponse } from '@/lib/api/types'

const CHUNK_WEEKS = 4

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

  // Fixed 4-week chunk end, clamped so it doesn't exceed the session total end date
  const chunkEndDate = clampDate(addWeeks(currentStart, CHUNK_WEEKS), totalEnd)

  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  // Promos active in this fixed chunk window — fetched once on open
  const [activePromos, setActivePromos] = useState<{
    id: string
    promo_group_name: string
    start_date: string
    end_date: string
    demand_multiplier: number
  }[]>([])
  const [loadingPromos, setLoadingPromos] = useState(false)

  // Performance % keyed by row id (not group name) so same group on different weeks is independent
  const [perfPct, setPerfPct] = useState<Record<string, number>>({})

  // Fetch active promo schedule entries for this chunk window
  useEffect(() => {
    if (!open || !currentStart || !chunkEndDate) {
      setActivePromos([])
      return
    }
    setLoadingPromos(true)
    getSessionPromoSchedules(session.session_id, currentStart, chunkEndDate)
      .then(setActivePromos)
      .catch(() => setActivePromos([]))
      .finally(() => setLoadingPromos(false))
  }, [open, session.session_id, currentStart, chunkEndDate])

  // Reset performance inputs when promo list changes
  useEffect(() => {
    setPerfPct(Object.fromEntries(activePromos.map(p => [p.id, 0])))
  }, [activePromos])

  async function handleRun() {
    setError('')
    setRunning(true)
    try {
      const perfInputs = activePromos
        .filter(p => (perfPct[p.id] ?? 0) !== 0)
        .map(p => ({ promo_group_name: p.promo_group_name, pct: perfPct[p.id], schedule_id: p.id }))

      const result = await runRollingChunk(session.session_id, {
        performance_inputs: perfInputs,
      })
      onChunkComplete(result)
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Run failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-md rounded-2xl p-0 shadow-2xl bg-white">
        <div className="border-b border-charcoal-blue-100 px-6 py-4 pr-12">
          <DialogTitle className="text-sm font-bold text-charcoal-blue-900">Run Simulation Chunk</DialogTitle>
          <p className="text-[10px] text-charcoal-blue-400 mt-0.5">
            Review the next 4-week chunk, then enter how your promos actually performed.
          </p>
        </div>

        <div className="px-6 py-5 space-y-5">
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
              <AlertCircle size={13} /> {error}
            </div>
          )}

          {/* Fixed chunk window — read-only label */}
          <div className="rounded-xl border border-charcoal-blue-100 bg-charcoal-blue-50 px-4 py-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400 mb-1">
              Next Chunk
            </p>
            <p className="text-xs font-bold text-charcoal-blue-800">
              {currentStart} → {chunkEndDate}
              <span className="ml-2 font-normal text-charcoal-blue-500">({CHUNK_WEEKS} weeks)</span>
            </p>
          </div>

          {/* Promo performance inputs */}
          {loadingPromos && (
            <div className="flex items-center justify-center gap-2 py-3 text-[10px] text-charcoal-blue-400">
              <Loader2 size={12} className="animate-spin" /> Loading active promos…
            </div>
          )}

          {!loadingPromos && activePromos.length === 0 && (
            <p className="text-center text-[10px] text-charcoal-blue-400 py-2 rounded-xl border border-dashed border-charcoal-blue-200">
              No promo groups scheduled in this period — you can still run the chunk
            </p>
          )}

          {!loadingPromos && activePromos.length > 0 && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400 px-1">
                <span>Promo Group</span>
                <span className="text-center">Performance %</span>
              </div>
              {activePromos.map((p, i) => (
                <div key={p.id || `${p.promo_group_name}-${i}`} className="grid grid-cols-2 items-center gap-2 rounded-xl border border-charcoal-blue-100 bg-charcoal-blue-50/50 px-3 py-2">
                  <div className="min-w-0">
                    <span className="text-[10px] font-semibold text-charcoal-blue-800 truncate block" title={p.promo_group_name}>
                      {p.promo_group_name}
                    </span>
                    <span className="text-[9px] text-charcoal-blue-400">
                      {p.start_date} → {p.end_date} · {p.demand_multiplier}×
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      value={perfPct[p.id] || ''}
                      onChange={e => setPerfPct(prev => ({ ...prev, [p.id]: Number(e.target.value) }))}
                      className="w-full rounded-lg border border-charcoal-blue-200 px-2 py-1 text-xs text-center font-semibold text-black focus:border-majorelle-blue-400 focus:outline-none bg-white"
                      placeholder="0"
                    />
                    <span className="text-[10px] text-charcoal-blue-400 flex-shrink-0">%</span>
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-charcoal-blue-400 px-1">
                +50 = overperformed 50%, -30 = underperformed 30%, 0 = as expected
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
              disabled={running}
              className="flex-1 rounded-xl bg-majorelle-blue-500 py-2.5 text-xs font-bold text-white hover:bg-majorelle-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {running
                ? <><Loader2 size={13} className="animate-spin" /> Running…</>
                : `Run ${CHUNK_WEEKS} Weeks`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
