// Shared reactive/adaptive branch-multiplier logic — the SINGLE source of truth for how
// the two branch demand curves are derived from the latest recorded performance. Used by both:
//   • rolling-forecast-modal.tsx  — "Run Both Branches" (manual, with an editable preview)
//   • page.tsx onChunkComplete    — the auto-trigger fired right after the first Run Weeks
// so the two paths can never drift out of sync on the formula.

import type { RollingForecastSession } from '@/lib/api/types'

// Demand multipliers are clamped to a sane band so an extreme historical pct can't produce
// a runaway (or zero/negative) forecast.
export const clampMult = (v: number) => Math.min(15, Math.max(0.5, v))

// The MOST RECENTLY recorded actual-performance pct per promo_group_name, across every
// COMPLETED chunk — main-line AND branch. "Latest week" drives the next forecast: the
// branch multiplier reacts to what most recently happened, not a frozen week-1 value nor
// an average that would let opposite swings (+70 then -50) cancel out.
//
// branch_type is intentionally NOT filtered: the same realized pct is recorded on both the
// reactive and adaptive chunk for a given window (run_rolling_chunk applies one
// body.performance_inputs to both — see ROLLING_FORECAST_BRANCHING.md §7.4), so "latest by
// end_week" yields the same value regardless of which branch's chunk it came from. If
// per-branch realized pcts ever diverge, this needs a branch_type scope argument.
export function collectLatestPct(session: RollingForecastSession): Record<string, number> {
  const best: Record<string, { week: string; pct: number }> = {}
  for (const chunk of session.chunks ?? []) {
    if (chunk.status !== 'completed') continue
    const perf = chunk.performance_inputs
    if (!Array.isArray(perf)) continue
    // start_week/end_week are stored as YYYY-MM-DD strings → lexicographic compare = chronological.
    const week = chunk.end_week || chunk.start_week || ''
    for (const p of perf) {
      if (p.promo_group_name && p.pct !== undefined) {
        const cur = best[p.promo_group_name]
        if (!cur || week > cur.week) best[p.promo_group_name] = { week, pct: Number(p.pct) }
      }
    }
  }
  const out: Record<string, number> = {}
  for (const [group, v] of Object.entries(best)) out[group] = v.pct
  return out
}

export interface BranchOverrideRow {
  schedule_id: string
  promo_group_name: string
  origMult: number      // the original planned multiplier (M0)
  reactiveMult: number  // full response: origMult × (1 + latestPct%)
  reactivePct: number   // latest recorded pct (audit field)
  adaptiveMult: number  // damped response: origMult × (1 + clamp(latestPct%, -10, 10))
  adaptivePct: number   // the damped pct actually applied (audit field)
}

export interface BranchOverride {
  schedule_id: string
  multiplier: number
  pct?: number
  promo_group_name?: string
}

// Compute per-schedule reactive/adaptive rows for the promos scheduled in the next chunk
// window. `fetched` is the getSessionPromoSchedules(...) payload for that window. Each
// promo's multiplier is driven by its LATEST recorded performance pct; a promo with no
// recorded history yet is skipped (nothing to react to → keeps the plan multiplier).
export function computeBranchOverrideRows(
  session: RollingForecastSession,
  fetched: { id: string; promo_group_name: string; demand_multiplier: number; original_multiplier: number | null }[],
): BranchOverrideRow[] {
  const latestPct = collectLatestPct(session)
  const rows: BranchOverrideRow[] = []
  for (const sched of fetched) {
    const origMult = (sched.original_multiplier ?? sched.demand_multiplier) as number
    const pct = latestPct[sched.promo_group_name]
    if (pct === undefined) continue
    const cappedAdj = Math.max(-10, Math.min(10, pct))
    rows.push({
      schedule_id: String(sched.id),
      promo_group_name: sched.promo_group_name,
      origMult,
      reactiveMult: clampMult(origMult * (1 + pct / 100)),
      reactivePct: pct,
      adaptiveMult: clampMult(origMult * (1 + cappedAdj / 100)),
      adaptivePct: cappedAdj,
    })
  }
  return rows
}

// Flatten rows into the { reactive, adaptive } structured-override shape that
// generateBranches(...) expects — used directly by the auto-trigger (no YAML round-trip).
export function branchOverridesFromRows(rows: BranchOverrideRow[]): {
  reactive: BranchOverride[]
  adaptive: BranchOverride[]
} {
  return {
    reactive: rows.map(r => ({
      schedule_id: r.schedule_id,
      multiplier: Number(r.reactiveMult.toFixed(4)),
      pct: Number(r.reactivePct.toFixed(2)),
      promo_group_name: r.promo_group_name,
    })),
    adaptive: rows.map(r => ({
      schedule_id: r.schedule_id,
      multiplier: Number(r.adaptiveMult.toFixed(4)),
      pct: Number(r.adaptivePct.toFixed(2)),
      promo_group_name: r.promo_group_name,
    })),
  }
}
