'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Loader2, AlertCircle } from 'lucide-react'
import { runRollingChunk, getSessionPromoSchedules } from '@/lib/api/simulation'
import type { RollingForecastSession, RunChunkResponse } from '@/lib/api/types'

const inputCls = 'w-full rounded-lg border border-charcoal-blue-200 bg-charcoal-blue-50/60 px-2.5 py-1.5 text-xs font-medium text-charcoal-blue-900 placeholder:text-charcoal-blue-300 transition-all focus:border-majorelle-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-majorelle-blue-100'

function weeksBetween(start: string, end: string): number {
  const s = new Date(start), e = new Date(end)
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / (7 * 24 * 3600 * 1000)))
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

  const [chunkEndDate, setChunkEndDate] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  // Promos active in the selected chunk window — fetched dynamically, one row per scheduled entry
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

  // Fetch active promo schedule entries whenever the chunk end date changes
  useEffect(() => {
    if (!chunkEndDate || !currentStart) {
      setActivePromos([])
      return
    }
    setLoadingPromos(true)
    getSessionPromoSchedules(session.session_id, currentStart, chunkEndDate)
      .then(setActivePromos)
      .catch(() => setActivePromos([]))
      .finally(() => setLoadingPromos(false))
  }, [chunkEndDate, session.session_id, currentStart])

  // Reset performance inputs (keyed by id) when promo list changes
  useEffect(() => {
    setPerfPct(Object.fromEntries(activePromos.map(p => [p.id, 0])))
  }, [activePromos])

  const weeksToRun = chunkEndDate ? weeksBetween(currentStart, chunkEndDate) : 0

  async function handleRun() {
    if (!chunkEndDate) { setError('Select a run-until date.'); return }
    if (new Date(chunkEndDate) <= new Date(currentStart)) {
      setError('End date must be after the current completed week.'); return
    }
    setError('')
    setRunning(true)
    try {
      const perfInputs = activePromos
        .filter(p => (perfPct[p.id] ?? 0) !== 0)
        .map(p => ({ promo_group_name: p.promo_group_name, pct: perfPct[p.id], schedule_id: p.id }))

      const result = await runRollingChunk(session.session_id, {
        chunk_end_date: chunkEndDate,
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
            Choose how far to run, then enter how your promos actually performed.
          </p>
        </div>

        <div className="px-6 py-5 space-y-5">
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
              <AlertCircle size={13} /> {error}
            </div>
          )}

          {/* Run until date */}
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400">
              Run Until
            </label>
            <input
              type="date"
              value={chunkEndDate}
              min={currentStart}
              max={totalEnd}
              onChange={e => setChunkEndDate(e.target.value)}
              className={inputCls}
            />
            {weeksToRun > 0 && (
              <p className="text-[10px] text-charcoal-blue-400">
                Runs <span className="font-bold text-charcoal-blue-700">{weeksToRun} week{weeksToRun !== 1 ? 's' : ''}</span>
                {' '}from {currentStart} → {chunkEndDate}
              </p>
            )}
          </div>

          {/* Promo performance inputs — shown only after a date is entered */}
          {!chunkEndDate && (
            <p className="text-center text-[10px] text-charcoal-blue-400 py-2">
              Select a date above to see active promo groups
            </p>
          )}

          {chunkEndDate && loadingPromos && (
            <div className="flex items-center justify-center gap-2 py-3 text-[10px] text-charcoal-blue-400">
              <Loader2 size={12} className="animate-spin" /> Loading active promos…
            </div>
          )}

          {chunkEndDate && !loadingPromos && activePromos.length === 0 && (
            <p className="text-center text-[10px] text-charcoal-blue-400 py-2 rounded-xl border border-dashed border-charcoal-blue-200">
              No promo groups scheduled in this period — you can still run the chunk
            </p>
          )}

          {chunkEndDate && !loadingPromos && activePromos.length > 0 && (
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
                      className="w-full rounded-lg border border-charcoal-blue-200 px-2 py-1 text-xs text-center font-semibold focus:border-majorelle-blue-400 focus:outline-none bg-white"
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
              disabled={running || !chunkEndDate}
              className="flex-1 rounded-xl bg-majorelle-blue-500 py-2.5 text-xs font-bold text-white hover:bg-majorelle-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {running
                ? <><Loader2 size={13} className="animate-spin" /> Running…</>
                : `Run ${weeksToRun > 0 ? `${weeksToRun} Week${weeksToRun !== 1 ? 's' : ''}` : 'Chunk'}`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
