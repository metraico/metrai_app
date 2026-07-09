'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Loader2, AlertCircle, Plus } from 'lucide-react'
import { getSessionPromoSchedules, runRollingChunkYaml, buildRunChunkYaml } from '@/lib/api/simulation'
import { formatDateUS } from '@/lib/utils'
import { getPromoGroups, getPromos } from '@/lib/api/promos'
import type { RollingForecastSession, RunChunkResponse, PromoGroupResponse, PromoResponse } from '@/lib/api/types'
import yaml from 'js-yaml'

const CHUNK_WEEKS = 4

function addWeeks(dateStr: string, weeks: number): string {
  const d = new Date(dateStr + 'T12:00:00')
  d.setDate(d.getDate() + weeks * 7)
  return d.toISOString().slice(0, 10)
}

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

  const chunkWeeks = CHUNK_WEEKS
  const chunkEndDate = clampDate(addWeeks(currentStart, chunkWeeks), totalEnd)

  const msPerWeek = 7 * 24 * 3600 * 1000
  const weeksRemaining = Math.max(0, Math.round(
    (new Date(totalEnd + 'T12:00:00').getTime() - new Date(chunkEndDate + 'T12:00:00').getTime()) / msPerWeek
  ))

  // ── State ────────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [yamlText, setYamlText] = useState('')
  const [loadingPromos, setLoadingPromos] = useState(false)

  // Promo groups for the "Add promo" picker
  const [promoGroups, setPromoGroups] = useState<PromoGroupResponse[]>([])
  const [promosCatalog, setPromosCatalog] = useState<PromoResponse[]>([])
  const [showPicker, setShowPicker] = useState(false)

  useEffect(() => {
    if (!open || !currentStart || !chunkEndDate) {
      setYamlText('')
      return
    }
    setError('')
    setShowPicker(false)
    setLoadingPromos(true)

    getSessionPromoSchedules(session.session_id, currentStart, chunkEndDate)
      .then(fetched => {
        setYamlText(buildRunChunkYaml(fetched, currentStart, chunkEndDate, session.session_id))
      })
      .catch(err => {
        console.error('Failed to load session promo schedules', err)
        setYamlText(buildRunChunkYaml([], currentStart, chunkEndDate, session.session_id))
      })
      .finally(() => setLoadingPromos(false))

    getPromoGroups(session.retailer_account_id)
      .then(setPromoGroups)
      .catch(err => console.error('Failed to load promo groups', err))
    getPromos(session.retailer_account_id)
      .then(setPromosCatalog)
      .catch(err => console.error('Failed to load promos catalog', err))
  }, [open, session.session_id, session.retailer_account_id, currentStart, chunkEndDate])

  function namesInYaml(): Set<string> {
    const found = new Set<string>()
    for (const line of yamlText.split('\n')) {
      const m = line.match(/(?:promo_group_name|promo_name):\s*["']?([^"'\n]+)["']?/)
      if (m) found.add(m[1].trim())
    }
    return found
  }

  function appendPromoBlock(promo: PromoResponse) {
    const block = [
      '',
      `  - schedule_id: ""`,
      `    promo_group_name: ${promo.promo_group_name ?? promo.promo_name}`,
      `    promo_name: ${promo.promo_name}`,
      `    pct: 0`,
    ].join('\n')
    let base = yamlText
    if (base.trim().endsWith('performance: []')) base = base.replace('performance: []', 'performance:')
    setYamlText(base.replace(/\n+$/, '') + '\n' + block + '\n')
    setShowPicker(false)
  }

  // ── Run handler ─────────────────────────────────────────────────────────
  async function handleRun() {
    setError('')
    try { yaml.load(yamlText) } catch (e: any) {
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
  const promosByGroup = promosCatalog.reduce<Record<string, PromoResponse[]>>((acc, p) => {
    const key = p.promo_group_name ?? ''
    if (key) { acc[key] = acc[key] ?? []; acc[key].push(p) }
    return acc
  }, {})
  const pickerGroups = promoGroups.filter(g => !unavailableNames.has(g.promo_group_name))
  const pickerPromos = promosCatalog.filter(p =>
    !unavailableNames.has(p.promo_group_name ?? '') && !unavailableNames.has(p.promo_name)
  )

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg rounded-2xl p-0 shadow-2xl bg-white">
        <div className="border-b border-charcoal-blue-100 px-6 py-4 pr-12">
          <DialogTitle className="text-sm font-bold text-charcoal-blue-900">
            Run Simulation Chunk
          </DialogTitle>
          <p className="text-[10px] text-charcoal-blue-400 mt-0.5">
            Review the next {chunkWeeks}-week chunk, then enter how your promos actually performed.
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
              <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
              <span className="whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}

          {/* Chunk window label */}
          <div className="rounded-xl border border-charcoal-blue-100 bg-charcoal-blue-50 px-4 py-3">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-charcoal-blue-400 mb-1">Next Chunk</p>
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs font-bold text-charcoal-blue-800">
                {formatDateUS(currentStart)} → {formatDateUS(chunkEndDate)}
                <span className="ml-2 font-normal text-charcoal-blue-500">({chunkWeeks} weeks)</span>
              </p>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${weeksRemaining === 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                {weeksRemaining === 0 ? 'Last chunk' : `${weeksRemaining}w remaining after`}
              </span>
            </div>
          </div>

          {/* ── Performance input ──────────────────────────────────────── */}
          {loadingPromos ? (
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
                    {showPicker && (pickerPromos.length > 0 || pickerGroups.length > 0) && (
                      <div className="absolute right-0 top-full mt-1 z-10 w-64 rounded-xl border border-charcoal-blue-200 bg-white shadow-lg overflow-hidden">
                        <div className="max-h-56 overflow-y-auto">
                          {pickerGroups.map(g => {
                            const groupPromos = (promosByGroup[g.promo_group_name] ?? []).filter(
                              p => !unavailableNames.has(p.promo_name)
                            )
                            if (groupPromos.length === 0 && unavailableNames.has(g.promo_group_name)) return null
                            return (
                              <div key={g.promo_group_id}>
                                <p className="px-3 pt-2 pb-0.5 text-[9px] font-bold uppercase tracking-widest text-charcoal-blue-400">
                                  {g.promo_group_name}
                                </p>
                                {groupPromos.length > 0 ? (
                                  groupPromos.map(p => (
                                    <button key={p.promo_id} type="button" onClick={() => appendPromoBlock(p)}
                                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[10px] text-charcoal-blue-800 hover:bg-charcoal-blue-50">
                                      <Plus size={9} className="flex-shrink-0 text-amber-500" />
                                      <span className="flex-1 truncate font-semibold">{p.promo_name}</span>
                                      <span className="text-charcoal-blue-400 tabular-nums">×{p.demand_multiplier.toFixed(2)}</span>
                                    </button>
                                  ))
                                ) : (
                                  <button type="button"
                                    onClick={() => appendPromoBlock({ ...g, promo_id: g.promo_group_id, promo_name: g.promo_group_name, event_type: '', start_date: null, end_date: null, demand_multiplier: 1.0, post_promo_decay_days: 0, post_promo_decay_shape: 'LINEAR', store_ids: [] } as PromoResponse)}
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-[10px] text-charcoal-blue-800 hover:bg-charcoal-blue-50">
                                    <Plus size={9} className="flex-shrink-0 text-amber-500" />
                                    <span className="flex-1 truncate font-semibold">{g.promo_group_name}</span>
                                    <span className="text-charcoal-blue-400">×1.00</span>
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                    {showPicker && pickerPromos.length === 0 && pickerGroups.length === 0 && (
                      <div className="absolute right-0 top-full mt-1 z-10 w-52 rounded-xl border border-charcoal-blue-200 bg-white shadow-lg px-3 py-2 text-[10px] text-charcoal-blue-400">
                        All promos already added
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
                  Leave <code className="text-[10px] bg-charcoal-blue-100 px-1 rounded">pct: 0</code> for promos that ran as planned.
                </p>
              </div>
          )}

          {/* ── Action buttons ────────────────────────────────────────── */}
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} disabled={running || loadingPromos}
              className="flex-1 rounded-xl border border-charcoal-blue-200 py-2.5 text-xs font-bold text-charcoal-blue-600 hover:bg-charcoal-blue-50 disabled:opacity-50">
              Cancel
            </button>
            <button onClick={handleRun} disabled={running || loadingPromos}
              className="flex-[2] rounded-xl bg-majorelle-blue-500 py-2.5 text-xs font-bold text-white hover:bg-majorelle-blue-600 disabled:opacity-50 flex items-center justify-center gap-2">
              {running ? <><Loader2 size={13} className="animate-spin" /> Running…</> : `Run ${chunkWeeks} Weeks`}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
