'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Download, Package, Truck, ShoppingCart, AlertCircle, Loader2, ChevronLeft, ChevronRight, FileCode, Lock } from 'lucide-react'
import * as yaml from 'js-yaml'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea, Cell,
} from 'recharts'
import {
  getAnalyticsMeta,
  getStoreSales, getStoreInventory, getSupplierSales, getDCInventory,
  getSummaryStoreSales, getSummaryStoreInventory, getSummarySupplyChainSales, getSummaryUpstreamInventory,
  getHiddenLostSales,
} from '@/lib/api/analytics'
import type { HiddenLostSalesResponse } from '@/lib/api/analytics'
import { getRunConfig, getAnalyticsStatus, getSimulationExportUrl, getRollingSession, getDemandWeeklyTotals, getSessionPromoSchedules, getRuns, generateBranchForecasts, runBranches, getBranchForecast } from '@/lib/api/simulation'
import { RollingForecastModal } from './rolling-forecast-modal'
import { RunChunkModal } from './run-chunk-modal'
import { useSimulationStore } from '@/lib/store/simulationStore'
import { useFilterStore } from '@/lib/store/filterStore'
import type { AnalyticsMeta, SimulationSummary, RollingForecastSession, SimulationRun, BranchForecastRow, BranchForecastResponse } from '@/lib/api/types'
import { toIsoWeek } from '@/lib/utils'

// ── Aggregation helpers ───────────────────────────────────────────────────────

function aggPOS(pos: any[]) {
  const map = new Map<string, { demand: number; sales: number; lost: number; revenue: number; isPromo: boolean; promoName: string; promoGroupName: string; runType: string }>()
  for (const r of pos) {
    const c = map.get(r.pos_week) ?? { demand: 0, sales: 0, lost: 0, revenue: 0, isPromo: false, promoName: '', promoGroupName: '', runType: 'base' }
    const rowIsPromoDemand = Boolean(Number(r.is_promo_demand ?? 0))
    const rowPromoGroup = r.promo_group_name ?? ''
    // Prefer a promo_group_name from a row that actually has is_promo_demand=1 over an
    // earlier non-promo row whose name is blank (or stale). Otherwise keep first-seen.
    let nextGroup = c.promoGroupName
    if (rowIsPromoDemand && rowPromoGroup) {
      nextGroup = rowPromoGroup
    } else if (!nextGroup) {
      nextGroup = rowPromoGroup
    }
    map.set(r.pos_week, {
      demand: c.demand + Number(r.demand_qty),
      sales: c.sales + Number(r.sales_qty),
      lost: c.lost + Number(r.stockout_qty),
      revenue: c.revenue + Number(r.sales_amount),
      isPromo: c.isPromo || Boolean(Number(r.is_promo_week ?? r.is_promo_demand ?? 0)),
      promoName: c.promoName || (r.promo_name ?? ''),
      promoGroupName: nextGroup,
      // keep the most specific run_type seen for this week (rolling_chunk > extension > base)
      runType: r.run_type === 'rolling_chunk' ? 'rolling_chunk'
             : r.run_type === 'extension' && c.runType !== 'rolling_chunk' ? 'extension'
             : c.runType,
    })
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
    week,
    demand_qty: v.demand,
    sales_qty: v.sales,
    stockout_qty: v.lost,
    sales_amount: v.revenue,
    is_promo_week: v.isPromo ? 1 : 0,
    promo_name: v.promoName,
    promo_group_name: v.promoGroupName,
    run_type: v.runType,
  }))
}

function aggStoreInv(inv: any[]) {
  const onHand = new Map<string, number>()
  const avail  = new Map<string, number>()
  const onOrd  = new Map<string, number>()
  for (const r of inv) {
    const w = r.inventory_week
    onHand.set(w, (onHand.get(w) ?? 0) + Number(r.on_hand_quantity))
    avail.set(w,  (avail.get(w)  ?? 0) + Number(r.available_quantity))
    onOrd.set(w,  (onOrd.get(w)  ?? 0) + Number(r.on_order_quantity))
  }
  return [...onHand.keys()].sort().map(w => ({
    week: w,
    on_hand_quantity: onHand.get(w) ?? 0,
    available_quantity: avail.get(w) ?? 0,
    on_order_quantity: onOrd.get(w) ?? 0,
  }))
}

function aggShipments(rows: any[]) {
  const map = new Map<string, { ordered: number; shipped: number; fill_sum: number; n: number }>()
  for (const r of rows) {
    const w = r.shipment_week
    const c = map.get(w) ?? { ordered: 0, shipped: 0, fill_sum: 0, n: 0 }
    // summary rows have avg_fill_rate; detail rows have fill_rate
    const fill = Number(r.avg_fill_rate ?? r.fill_rate ?? 0)
    map.set(w, {
      ordered: c.ordered + Number(r.ordered_qty),
      shipped: c.shipped + Number(r.shipped_qty),
      fill_sum: c.fill_sum + fill,
      n: c.n + 1,
    })
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
    week,
    ordered_qty: v.ordered,
    shipped_qty: v.shipped,
    avg_fill_rate: v.n > 0 ? Math.round((v.fill_sum / v.n) * 100) / 100 : 0,
  }))
}

function aggDCInv(dc: any[], _sup: any[]) {
  const dcOnHand  = new Map<string, number>()
  const dcOnOrder = new Map<string, number>()
  for (const r of dc) {
    const w = r.inventory_week
    dcOnHand.set(w,  (dcOnHand.get(w)  ?? 0) + Number(r.on_hand_quantity))
    dcOnOrder.set(w, (dcOnOrder.get(w) ?? 0) + Number(r.on_order_quantity ?? 0))
  }
  const weeks = [...dcOnHand.keys()].sort()
  return weeks.map(w => ({
    week: w,
    dc_on_hand:  dcOnHand.get(w)  ?? 0,
    dc_on_order: dcOnOrder.get(w) ?? 0,
  }))
}

function computeKPIs(pos: any[], shipments: any[]) {
  const totalSales   = pos.reduce((s: number, r: any) => s + Number(r.sales_qty ?? 0), 0)
  const totalLost    = pos.reduce((s: number, r: any) => s + Number(r.stockout_qty ?? 0), 0)
  const totalRevenue = pos.reduce((s: number, r: any) => s + Number(r.sales_amount ?? 0), 0)
  const fillSum      = shipments.reduce((s: number, r: any) => s + Number(r.avg_fill_rate ?? r.fill_rate ?? 0), 0)
  const fillRate     = shipments.length > 0 ? (fillSum / shipments.length) * 100 : 0
  const stockoutRate = totalSales + totalLost > 0 ? (totalLost / (totalSales + totalLost)) * 100 : 0
  return { totalSales, totalRevenue, fillRate, stockoutRate }
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

function PerformanceBadge({ pct }: { pct: number | null | undefined }) {
  if (pct == null || pct === 0) return null
  const isOver = pct > 0
  const label = isOver ? `▲ +${pct.toFixed(1)}% overperformed` : `▼ ${pct.toFixed(1)}% underperformed`
  return (
    <div className={`mt-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${isOver ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
      {label}
    </div>
  )
}

// Convert an ISO week label like "2025-W25" → "Jun 2025 · 2025-W25".
// If input is not in ISO-week form, returns it unchanged.
function formatWeekLabel(label?: string): string {
  if (!label) return ''
  const m = /^(\d{4})-W(\d{1,2})$/.exec(label)
  if (!m) return label
  const year = parseInt(m[1], 10)
  const week = parseInt(m[2], 10)
  // ISO week: Monday of week 1 is the Monday of the week containing Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Dow = jan4.getUTCDay() || 7  // Mon=1, Sun=7
  const mondayW1 = new Date(jan4)
  mondayW1.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1))
  const target = new Date(mondayW1)
  target.setUTCDate(mondayW1.getUTCDate() + (week - 1) * 7)
  const month = target.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${month} ${target.getUTCFullYear()} · ${label}`
}

function ChartTooltip({ active, payload, label, promoWeekMap }: {
  active?: boolean; payload?: any[]; label?: string
  promoWeekMap?: Record<string, { name: string; groupName: string }>
}) {
  if (!active || !payload?.length) return null
  const data = payload[0]?.payload ?? {}
  const promoGroupName = data.promo_group_name || promoWeekMap?.[label ?? '']?.groupName || ''
  const promoName = data.promo_name || promoWeekMap?.[label ?? '']?.name || ''
  const promoLabel = promoGroupName || promoName || 'Promo week'
  const isPromo = data.is_promo_week || (promoWeekMap && label && promoWeekMap[label])
  return (
    <div className="rounded-lg border border-charcoal-blue-200 bg-white px-3 py-2 shadow-md text-xs min-w-[140px]">
      {isPromo && (
        <div className="mb-2 flex items-center gap-1.5 rounded-md bg-violet-50 px-2 py-1">
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-violet-500" />
          <span className="font-semibold text-violet-700 truncate">Promo: {promoLabel}</span>
        </div>
      )}
      <p className="mb-1 font-semibold text-charcoal-blue-700">{formatWeekLabel(label)}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex justify-between gap-4" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span className="font-medium">
            {p.name === 'Fill Rate' ? `${(Number(p.value) * 100).toFixed(1)}%` : Number(p.value).toLocaleString()}
          </span>
        </p>
      ))}
    </div>
  )
}

function POSTooltip({ active, payload, label, promoWeekMap, hideActual }: {
  active?: boolean; payload?: any[]; label?: string
  promoWeekMap?: Record<string, { name: string; groupName: string }>
  hideActual?: boolean
}) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload ?? {}
  const promoGroupName = d.promo_group_name || promoWeekMap?.[label ?? '']?.groupName || ''
  const promoName = d.promo_name || promoWeekMap?.[label ?? '']?.name || ''
  const promoLabel = promoGroupName || promoName || 'Promo week'
  const isPromo = d.is_promo_week || (promoWeekMap && label && promoWeekMap[label])
  const demand = Number(d.primary_demand_qty ?? d.demand_qty ?? 0)
  const actualDemand = Number(d.demand_qty ?? 0)
  const sales = Number(d.sales_qty ?? 0)
  const lost = Number(d.stockout_qty ?? 0)
  const revenue = Number(d.sales_amount ?? 0)
  const forecast = d.forecast_qty != null ? Number(d.forecast_qty) : null
  const branchForecast = d.branch_forecast_qty != null ? Number(d.branch_forecast_qty) : null
  const originalForecast = d.original_forecast_qty != null ? Number(d.original_forecast_qty) : null
  const baseForecast = d.base_forecast_qty != null ? Number(d.base_forecast_qty) : null
  // On branch views post-anchor, `primary_demand_qty` IS the planner forecast (dampened for Reactive,
  // baseline for Adaptive) — surface it as "Planner Demand" and pair with Actual Demand below.
  const isPlannerBar = d.actual_demand_qty != null && d.primary_demand_qty != null
  const plannerBarValue = isPlannerBar ? Number(d.primary_demand_qty) : null
  // Universal forecast-value resolution — label depends on which source produced it.
  const forecastedDemand =
    plannerBarValue != null ? { value: plannerBarValue, label: 'Planner Demand' }
    : originalForecast != null ? { value: originalForecast, label: 'Forecasted Demand' }
    : baseForecast != null ? { value: baseForecast, label: 'Forecasted Demand' }
    : forecast != null ? { value: forecast, label: 'Future Demand' }
    : branchForecast != null ? { value: branchForecast, label: 'Future Demand' }
    : null
  const fillRate = actualDemand > 0 ? (sales / actualDemand) * 100 : null
  const runType = d.run_type
  const runLabel = runType === 'rolling_chunk' ? 'Rolling Chunk' : runType === 'extension' ? 'Extension' : null
  // Branch-view marker: `actual_demand_qty` is set only on branch views past the
  // anchor, when the purple bar is the planner FORECAST (not raw actual). In that
  // case we show a separate "Actual Demand" row with the raw actual.
  const branchActual = d.actual_demand_qty != null ? Number(d.actual_demand_qty) : null
  const isBranchForecastBar = branchActual != null
  // Legacy pre-run branch-tail path (primary_demand_qty nulled, branch_forecast_qty carries value):
  const isBranchTail = d.primary_demand_qty == null && branchForecast != null
  const isFutureOnly = (demand === 0 && forecast != null) || isBranchTail
  // Computed performance for rolling_chunk weeks: actual demand vs original forecast
  const computedPerfPct = runType === 'rolling_chunk' && originalForecast && originalForecast > 0
    ? ((actualDemand - originalForecast) / originalForecast) * 100
    : null

  return (
    <div className="rounded-lg border border-charcoal-blue-200 bg-white px-3 py-2 shadow-md text-xs min-w-[180px]">
      {isPromo && (
        <div className="mb-2 rounded-md bg-violet-50 px-2 py-1">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-violet-500" />
            <span className="font-semibold text-violet-700 truncate">Promo: {promoLabel}</span>
          </div>
          <PerformanceBadge pct={computedPerfPct} />
        </div>
      )}
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <p className="font-semibold text-charcoal-blue-700">{formatWeekLabel(label)}</p>
        {runLabel && <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600">{runLabel}</span>}
      </div>
      <div className="mb-1.5 space-y-0.5">
        {forecastedDemand != null && (
          <p className={`flex justify-between gap-4 ${forecastedDemand.label === 'Future Demand' ? 'text-cyan-600' : 'text-violet-700'}`}>
            <span>{forecastedDemand.label}</span>
            <span className="font-medium">{Math.round(forecastedDemand.value).toLocaleString()}</span>
          </p>
        )}
        {(() => {
          // Post-anchor on a completed branch: `actual_demand_qty` (branchActual) is the branch child's realized demand.
          // Pre-anchor and non-branch: `demand_qty` (actualDemand) is the authoritative actual.
          // hideActual only fires when a branch is *selected but not yet run* — we suppress parent-leaked values then.
          const shown = branchActual != null ? branchActual : (hideActual ? null : (actualDemand > 0 ? actualDemand : null))
          if (shown == null) return null
          return (
            <p className="flex justify-between gap-4 text-charcoal-blue-600">
              <span>Actual Demand</span>
              <span className="font-medium">{Math.round(shown).toLocaleString()}</span>
            </p>
          )
        })()}
      </div>
      {!isFutureOnly && (
        <>
          <div className="mb-1.5 space-y-0.5">
            <p className="flex justify-between gap-4 text-emerald-700"><span>Sales</span><span className="font-medium">{sales.toLocaleString()}</span></p>
            <p className="flex justify-between gap-4 text-red-600"><span>Lost Sales</span><span className="font-medium">{lost.toLocaleString()}</span></p>
          </div>
        </>
      )}
    </div>
  )
}

function DCInvTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
  if (!active || !payload?.length) return null
  const d       = payload[0]?.payload ?? {}
  const onHand  = d.dc_on_hand  ?? 0
  const onOrder = d.dc_on_order ?? 0
  const status  = onHand === 0 && onOrder > 0 ? 'in-transit' : onHand === 0 ? 'stockout' : null
  return (
    <div className="rounded-lg border border-charcoal-blue-200 bg-white px-3 py-2 shadow-md text-xs min-w-[190px]">
      <p className="mb-2 font-semibold text-charcoal-blue-700">{formatWeekLabel(label)}</p>
      <p className="flex justify-between gap-4 text-charcoal-blue-700">
        <span>On Hand</span><span className="font-medium">{onHand.toLocaleString()}</span>
      </p>
      <p className="flex justify-between gap-4 text-charcoal-blue-500">
        <span>On Order</span><span className="font-medium">{onOrder.toLocaleString()}</span>
      </p>
      {status === 'stockout'   && <p className="mt-0.5 text-red-500 font-semibold">⚠ Stockout — nothing on order</p>}
      {status === 'in-transit' && <p className="mt-0.5 text-amber-500 font-semibold">↑ Stockout — replenishment incoming</p>}
    </div>
  )
}

function StoreInvTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload ?? {}
  const avail   = Number(d.available_quantity ?? 0)
  const onOrder = Number(d.on_order_quantity  ?? 0)
  const status  = avail === 0 && onOrder > 0 ? 'in-transit' : avail === 0 ? 'stockout' : null
  return (
    <div className="rounded-lg border border-charcoal-blue-200 bg-white px-3 py-2 shadow-md text-xs min-w-[180px]">
      <p className="mb-1.5 font-semibold text-charcoal-blue-700">{formatWeekLabel(label)}</p>
      <p className="flex justify-between gap-4 text-emerald-700"><span>Available</span><span className="font-medium">{avail.toLocaleString()}</span></p>
      <p className="flex justify-between gap-4 text-amber-600"><span>On Order</span><span className="font-medium">{onOrder.toLocaleString()}</span></p>
      {status === 'stockout'   && <p className="mt-1 text-red-500 font-semibold">⚠ Stockout — nothing on order</p>}
      {status === 'in-transit' && <p className="mt-1 text-amber-500 font-semibold">↑ Stockout — replenishment incoming</p>}
    </div>
  )
}

// ── Small components ──────────────────────────────────────────────────────────

function KPICard({ label, value, icon: Icon, color }: { label: string; value: string; icon: React.ElementType; color: string }) {
  return (
    <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-[10px] font-medium text-charcoal-blue-400">{label}</p>
          <p className="mt-1 text-lg font-black text-charcoal-blue-950">{value}</p>
        </div>
        <div className={`flex-shrink-0 rounded-xl p-2 ${color}`}>
          <Icon size={15} className="text-white" />
        </div>
      </div>
    </div>
  )
}

function ChartError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 mb-3">
      <AlertCircle size={13} className="flex-shrink-0 text-rose-500" />
      <p className="text-xs font-medium text-rose-700">{message}</p>
    </div>
  )
}

function ToggleSegment({ value, onChange, options }: {
  value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex rounded-xl border border-charcoal-blue-200 overflow-hidden">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            value === o.value
              ? 'bg-majorelle-blue-500 text-white'
              : 'bg-white text-charcoal-blue-600 hover:bg-charcoal-blue-50'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}


function ChartModal({ title, subtitle, filters, error, children, onClose }: {
  title: string; subtitle: string; filters?: React.ReactNode
  error: string; children: React.ReactNode; onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="flex w-full max-w-5xl max-h-[90vh] flex-col rounded-xl border border-charcoal-blue-200 bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex-shrink-0 p-5 pb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-charcoal-blue-950">{title}</h3>
            <p className="text-[10px] text-charcoal-blue-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filters}
            <button onClick={onClose} className="ml-2 rounded-full border border-charcoal-blue-200 px-2 py-1 text-xs font-semibold text-charcoal-blue-500 hover:bg-charcoal-blue-50">✕ Close</button>
          </div>
        </div>
        {error && <div className="flex-shrink-0 px-5"><ChartError message={error} /></div>}
        <div className="flex-1 overflow-y-auto p-5 pt-0">
          {children}
        </div>
      </div>
    </div>
  )
}

function ChartShell({ title, subtitle, filters, error, loading, chart, isZoomed, onZoomReset }: {
  title: string; subtitle: string; filters?: React.ReactNode
  error: string; loading: boolean; chart: (height: number) => React.ReactNode
  isZoomed?: boolean; onZoomReset?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm flex flex-col focus-within:outline-none focus-within:ring-1 focus-within:ring-charcoal-blue-200">
        {/* Header with Expand button top-right */}
        <div className="mb-4 flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-charcoal-blue-950">{title}</h3>
            <p className="text-[10px] text-charcoal-blue-400">{subtitle}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {isZoomed && onZoomReset && (
              <button onClick={onZoomReset} className="flex-shrink-0 rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50 px-2 py-1 text-[10px] font-semibold text-majorelle-blue-600 hover:bg-majorelle-blue-100">↙ Zoom out</button>
            )}
            <button onClick={() => setExpanded(true)} className="flex-shrink-0 rounded-xl border border-charcoal-blue-200 px-2 py-1 text-[10px] font-semibold text-charcoal-blue-500 hover:bg-charcoal-blue-50">⤢ Expand</button>
          </div>
        </div>
        
        {error && <ChartError message={error} />}
        {/* Chart — centered with minimal spacing */}
        <div className="flex flex-col items-center justify-center my-1" style={{ userSelect: 'none', outline: 'none' }}>
          {loading
            ? <Loader2 size={22} className="animate-spin text-majorelle-blue-400" />
            : chart(300)}
        </div>
      </div>
      {expanded && (
        <ChartModal title={title} subtitle={subtitle} filters={filters} error={error} onClose={() => setExpanded(false)}>
          {isZoomed && onZoomReset && (
            <div className="mb-3 flex justify-end">
              <button onClick={onZoomReset} className="rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50 px-2 py-1 text-[10px] font-semibold text-majorelle-blue-600 hover:bg-majorelle-blue-100">↙ Zoom out</button>
            </div>
          )}
          <div className="flex flex-col items-center justify-center my-2">
            {chart(450)}
          </div>
        </ChartModal>
      )}
    </>
  )
}

function useChartZoom<T extends { week: string }>(data: T[]) {
  const [zoomRange, setZoomRange] = useState<{ left: number; right: number } | null>(null)
  const dragRef = useRef<{ mode: 'select' | 'pan'; startIdx: number; startLeft: number; startRight: number } | null>(null)
  const [selEnd, setSelEnd] = useState<number | null>(null)

  const isZoomed = zoomRange !== null
  const displayData = zoomRange ? data.slice(zoomRange.left, zoomRange.right + 1) : data

  const onMouseDown = (e: any) => {
    const idx = e?.activeTooltipIndex
    if (idx == null) return
    if (isZoomed && zoomRange) {
      dragRef.current = { mode: 'pan', startIdx: idx, startLeft: zoomRange.left, startRight: zoomRange.right }
    } else {
      dragRef.current = { mode: 'select', startIdx: idx, startLeft: 0, startRight: 0 }
      setSelEnd(idx)
    }
  }

  const onMouseMove = (e: any) => {
    const idx = e?.activeTooltipIndex
    if (idx == null || !dragRef.current) return
    if (dragRef.current.mode === 'select') {
      setSelEnd(idx)
    } else if (dragRef.current.mode === 'pan') {
      const delta = dragRef.current.startIdx - idx
      const width = dragRef.current.startRight - dragRef.current.startLeft
      const newLeft = Math.max(0, Math.min(data.length - width - 1, dragRef.current.startLeft + delta))
      setZoomRange({ left: newLeft, right: newLeft + width })
    }
  }

  const onMouseUp = () => {
    if (!dragRef.current) return
    if (dragRef.current.mode === 'select') {
      const a = Math.min(dragRef.current.startIdx, selEnd ?? dragRef.current.startIdx)
      const b = Math.max(dragRef.current.startIdx, selEnd ?? dragRef.current.startIdx)
      if (b - a >= 1) setZoomRange({ left: a, right: b })
      setSelEnd(null)
    }
    dragRef.current = null
  }

  const resetZoom = () => { setZoomRange(null); setSelEnd(null); dragRef.current = null }

  const selectionArea = (yAxisId?: string) => {
    if (isZoomed || dragRef.current?.mode !== 'select' || selEnd == null || dragRef.current.startIdx === selEnd) return null
    const yProps = yAxisId ? { yAxisId } : {}
    return (
      <>
        <ReferenceArea
          x1={data[0]?.week}
          x2={data[Math.min(dragRef.current.startIdx, selEnd)]?.week}
          fill="#5d626f" fillOpacity={0.18} stroke="none"
          {...yProps}
        />
        <ReferenceArea
          x1={data[Math.max(dragRef.current.startIdx, selEnd)]?.week}
          x2={data[data.length - 1]?.week}
          fill="#5d626f" fillOpacity={0.18} stroke="none"
          {...yProps}
        />
      </>
    )
  }

  return { displayData, onMouseDown, onMouseMove, onMouseUp, resetZoom, isZoomed, selectionArea }
}

// ── Main page ─────────────────────────────────────────────────────────────────

type PageState = 'loading' | 'polling' | 'ready' | 'error'

export default function SimulationResultsPage() {
  const params = useParams()
  const router = useRouter()
  const simulationId = params.runId as string
  const { cache } = useSimulationStore()

  const { setOptions, clearOptions, setFilters, globalItem, globalStore, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand } = useFilterStore()

  const [pageState, setPageState] = useState<PageState>('loading')
  const [pageError, setPageError] = useState('')
  const [simName, setSimName] = useState('Simulation Results')
  const [showRollingModal, setShowRollingModal] = useState(false)
  const [showRunChunkModal, setShowRunChunkModal] = useState(false)
  const [rollingSession, setRollingSession] = useState<RollingForecastSession | null>(null)
  const [rollingForecastData, setRollingForecastData] = useState<{ week: string; forecast_qty: number }[]>([])
  // Snapshot accumulates original forecast per week across chunk completions — never shrinks
  const [rollingForecastSnapshot, setRollingForecastSnapshot] = useState<Map<string, number>>(new Map())
  // Pre-simulation forecasted demand for base simulation weeks (from weekly_demand)
  const [baseForecastMap, setBaseForecastMap] = useState<Map<string, number>>(new Map())
  const [rollingPromos, setRollingPromos] = useState<{ promo_group_name: string; promo_name: string; start_date: string; end_date: string; demand_multiplier: number }[]>([])
  const [promoGroupPerfMap, setPromoGroupPerfMap] = useState<Record<string, number | null>>({})
  const [runFullConfig, setRunFullConfig] = useState<Record<string, unknown> | null>(null)
  const [runEndWeek, setRunEndWeek] = useState<string>('')
  const [yamlModalOpen, setYamlModalOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('dashboard')
  // ── Comparison tab (Reactive vs Adaptive) ─────────────────────────────────
  const [cmpReactivePos, setCmpReactivePos] = useState<any[]>([])
  const [cmpReactiveInv, setCmpReactiveInv] = useState<any[]>([])
  const [cmpReactiveShip, setCmpReactiveShip] = useState<any[]>([])
  const [cmpAdaptivePos, setCmpAdaptivePos] = useState<any[]>([])
  const [cmpAdaptiveInv, setCmpAdaptiveInv] = useState<any[]>([])
  const [cmpAdaptiveShip, setCmpAdaptiveShip] = useState<any[]>([])
  const [cmpLoading, setCmpLoading] = useState(false)
  const [meta, setMeta] = useState<AnalyticsMeta | null>(null)
  const [analyticsStatus, setAnalyticsStatus] = useState<'PENDING' | 'READY' | 'FAILED' | null>(null)
  const analyticsStatusRef = useRef<'PENDING' | 'READY' | 'FAILED' | null>(null)
  const [analyticsReadyVisible, setAnalyticsReadyVisible] = useState(true)
  const bannerDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Chart 1 — POS (store sales)
  const [posData, setPosData] = useState<any[]>([])
  // Derive extensionStartWeek from posData so chart styling works for sims that have extension data
  const extensionStartWeek = posData.find(d => d.run_type === 'extension')?.week ?? null
  // Rolling forecast reference lines — shared across all 4 charts
  const _sortedChunks = (rollingSession?.chunks ?? []).slice().sort((a, b) => a.chunk_number - b.chunk_number)
  const rollingBaseStartWeek = rollingSession ? toIsoWeek(_sortedChunks[0]?.start_week ?? runEndWeek ?? '') : null
  const _lastCompletedChunk = (rollingSession?.chunks ?? []).filter(c => c.status === 'completed').slice(-1)[0]
  const rollingForecastStartWeek = _lastCompletedChunk ? toIsoWeek(_lastCompletedChunk.end_week) : null
  const chunkAreas = (rollingSession?.chunks ?? []).filter(c => c.status === 'completed').map(c => ({ x1: toIsoWeek(c.start_week), x2: toIsoWeek(c.end_week), num: c.chunk_number }))
  const [posError, setPosError] = useState('')
  const [posLoading, setPosLoading] = useState(false)

  // Chart 2 — Store inventory
  const [storeInvData, setStoreInvData] = useState<any[]>([])
  const [storeInvError, setStoreInvError] = useState('')
  const [storeInvLoading, setStoreInvLoading] = useState(false)

  // Chart 3 — Shipments
  const [shipData, setShipData] = useState<any[]>([])
  const [shipError, setShipError] = useState('')
  const [shipLoading, setShipLoading] = useState(false)

  // Chart 4 — DC inventory
  const [dcInvData, setDcInvData] = useState<any[]>([])
  const [dcInvError, setDcInvError] = useState('')
  const [dcInvLoading, setDcInvLoading] = useState(false)

  // HLS — Hidden Lost Sales reconciliation (only for hidden_lost_sales scenario)
  const [hlsData, setHlsData] = useState<HiddenLostSalesResponse | null>(null)
  // HLS — per-branch planner forecast rows (rendered as post-stockout future-demand tail)
  const [branchForecastRows, setBranchForecastRows] = useState<BranchForecastRow[]>([])
  // HLS — parent's POS rows (pre-anchor historical). Fetched on branch views so we can
  // show main-line's history to the LEFT of Forecast Start even after the branch has run
  // (analyticsSimId then points at the branch child which only has post-anchor rows).
  const [parentPosData, setParentPosData] = useState<any[]>([])
  const [parentStoreInvData, setParentStoreInvData] = useState<any[]>([])
  const [parentShipData, setParentShipData] = useState<any[]>([])
  const [parentDcInvData, setParentDcInvData] = useState<any[]>([])
  const [parentPosLoading, setParentPosLoading] = useState(false)
  // HLS — branch simulation execution state
  const [runBranchesInFlight, setRunBranchesInFlight] = useState(false)
  const [runBranchesError, setRunBranchesError] = useState('')

  // HLS branching state
  const [allRuns, setAllRuns] = useState<SimulationRun[]>([])
  const [selectedBranch, setSelectedBranch] = useState<'base' | 'reactive' | 'adaptive'>('base')
  const [compareModalOpen, setCompareModalOpen] = useState(false)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState('')
  const [branchPreview, setBranchPreview] = useState<{
    reactive: BranchForecastResponse
    adaptive: BranchForecastResponse
    rows: BranchForecastRow[]
  } | null>(null)

  const currentRun = allRuns.find(r => r.simulation_id === simulationId) || null
  const bothBranchesComplete =
    !!(allRuns.find(r => r.parent_simulation_id === simulationId && r.branch_type === 'reactive')?.simulation_status === 'COMPLETED'
      && allRuns.find(r => r.parent_simulation_id === simulationId && r.branch_type === 'adaptive')?.simulation_status === 'COMPLETED')
  const scenarioType = currentRun?.scenario_type
    ?? ((runFullConfig as any)?.scenario?.scenario_type as string | undefined)
    ?? ((runFullConfig as any)?.scenario_type as string | undefined)
  const childBranches = allRuns.filter(r => r.parent_simulation_id === simulationId)
  const reactiveChild = childBranches.find(r => r.branch_type === 'reactive') || null
  const adaptiveChild = childBranches.find(r => r.branch_type === 'adaptive') || null
  const hasBranches = childBranches.length > 0
  const bothBranchesCompleted =
    reactiveChild?.simulation_status === 'COMPLETED' &&
    adaptiveChild?.simulation_status === 'COMPLETED'
  const isHls = scenarioType === 'hidden_lost_sales' || (hlsData !== null && hlsData.disruption_windows.length > 0)
  const showCompareButton = isHls && !hasBranches && currentRun?.branch_type == null && !currentRun?.parent_simulation_id
  // Selected-branch sim id (may be a not-yet-run child); used to know which branch is active.
  const selectedBranchSimId =
    selectedBranch === 'reactive' && reactiveChild ? reactiveChild.simulation_id
    : selectedBranch === 'adaptive' && adaptiveChild ? adaptiveChild.simulation_id
    : null
  // Effective sim id we can actually pull analytics from. Falls back to the parent when
  // the branch child hasn't been run yet — otherwise every filter refetch would 409.
  const selectedBranchRun = selectedBranchSimId ? allRuns.find(r => r.simulation_id === selectedBranchSimId) : null
  const analyticsSimId =
    selectedBranchSimId && selectedBranchRun?.simulation_status === 'COMPLETED'
      ? selectedBranchSimId
      : simulationId

  // Anchor for the branch forecast tail: last week of the (last) stockout disruption window.
  const stockoutEndWeek = (() => {
    if (!hlsData || hlsData.disruption_windows.length === 0) return null
    const last = hlsData.disruption_windows
      .map(w => w.window_end)
      .filter(Boolean)
      .sort()
      .slice(-1)[0]
    return last ? toIsoWeek(last) : null
  })()
  // Cyan for both branches so the Planner Forecast bar doesn't collide with
  // Lost Sales (red) on Reactive views. Matches the rolling-forecast pattern.
  const branchTailColor =
    selectedBranch === 'adaptive' ? '#06b6d4'
    : selectedBranch === 'reactive' ? '#06b6d4'
    : null
  // Adaptive sources its tail from the parent's posData (no branch_forecast rows required);
  // Reactive needs the planner_forecast rows to have loaded.
  const showBranchForecastTail =
    selectedBranch !== 'base' &&
    !!stockoutEndWeek &&
    (selectedBranch === 'adaptive' || branchForecastRows.length > 0)
  // When a branch view is selected but its child sim hasn't been run, the non-POS charts fall back
  // to the parent's data — which is misleading past the stockout anchor. Cut those charts at the
  // anchor until the branch sim completes.
  const selectedBranchIsUnrun =
    selectedBranch !== 'base' && !!selectedBranchSimId && selectedBranchRun?.simulation_status !== 'COMPLETED'
  const hideBranchAnalyticsPastAnchor = selectedBranchIsUnrun && !!stockoutEndWeek
  const cutForBranch = <T extends { week: string }>(arr: T[]): T[] =>
    hideBranchAnalyticsPastAnchor && stockoutEndWeek ? arr.filter(d => d.week <= stockoutEndWeek) : arr
  // Union of item_codes across disruption windows. `null` = no filter (either
  // no disruption data yet, or any window scopes to 'all' items).
  const affectedItemCodes: Set<string> | null = (() => {
    if (!hlsData || hlsData.disruption_windows.length === 0) return null
    const codes = new Set<string>()
    for (const w of hlsData.disruption_windows) {
      if (w.item_codes === 'all' || (typeof w.item_codes === 'string' && w.item_codes === 'all')) return null
      if (Array.isArray(w.item_codes)) for (const c of w.item_codes) codes.add(c)
    }
    return codes.size > 0 ? codes : null
  })()


  const [combinedPosDataForZoom, setCombinedPosDataForZoom] = useState<any[]>([])
  // On branch views (post-run) the child sim only carries post-anchor rows. Merge in the parent's
  // pre-anchor context so Store Inventory / Shipments / DC Inventory show a full timeline.
  const branchIsCompletedForMerge = selectedBranchRun?.simulation_status === 'COMPLETED'
  const useBranchMerge = selectedBranch !== 'base' && branchIsCompletedForMerge && !!stockoutEndWeek
  const mergeWithParent = <T extends { week: string }>(child: T[], parent: T[]): T[] => {
    if (!useBranchMerge || parent.length === 0) return child
    const parentByWeek = new Map(parent.map(d => [d.week, d]))
    const childByWeek = new Map(child.map(d => [d.week, d]))
    const weeks = [...new Set([...parentByWeek.keys(), ...childByWeek.keys()])].sort()
    return weeks.map(w => {
      const isAfterAnchor = w > (stockoutEndWeek as string)
      return (isAfterAnchor ? (childByWeek.get(w) ?? parentByWeek.get(w)) : (parentByWeek.get(w) ?? childByWeek.get(w))) as T
    })
  }
  const mergedStoreInvData = useMemo(() => mergeWithParent(storeInvData, parentStoreInvData), [storeInvData, parentStoreInvData, useBranchMerge, stockoutEndWeek])
  const mergedShipData = useMemo(() => mergeWithParent(shipData, parentShipData), [shipData, parentShipData, useBranchMerge, stockoutEndWeek])
  const mergedDcInvData = useMemo(() => mergeWithParent(dcInvData, parentDcInvData), [dcInvData, parentDcInvData, useBranchMerge, stockoutEndWeek])
  // On branch views, override the KPI cards with numbers computed from the merged arrays so the
  // top-of-page totals reflect parent-pre-anchor + child-post-anchor over the current filter slice.
  const mergedPosForKpi = useMemo(() => mergeWithParent(posData, parentPosData), [posData, parentPosData, useBranchMerge, stockoutEndWeek])
  const branchKpis = useMemo(
    () => computeKPIs(mergedPosForKpi, mergedShipData),
    [mergedPosForKpi, mergedShipData]
  )
  const zoom1 = useChartZoom(combinedPosDataForZoom)
  const zoom2 = useChartZoom(mergedStoreInvData)
  const zoom3 = useChartZoom(mergedShipData)
  const zoom4 = useChartZoom(mergedDcInvData)

  // Keep zoom1 data in sync with posData + rollingForecastData so zoom covers future weeks too
  useEffect(() => {
    const forecastByWeek = new Map(rollingForecastData.map(r => [r.week, r.forecast_qty]))
    const merged = posData.map(d => {
      const origForecast = d.run_type === 'rolling_chunk' ? rollingForecastSnapshot.get(d.week) : undefined
      const baseForecast = d.run_type === 'base' ? baseForecastMap.get(d.week) : undefined
      return {
        ...d,
        forecast_qty: forecastByWeek.get(d.week),
        original_forecast_qty: origForecast,
        base_forecast_qty: baseForecast,
        primary_demand_qty: origForecast ?? baseForecast ?? d.demand_qty,
      }
    })
    const forecastOnly = rollingForecastData
      .filter(r => !posData.some(d => d.week === r.week))
      .map(r => ({ week: r.week, demand_qty: 0, sales_qty: 0, stockout_qty: 0, sales_amount: 0, is_promo_week: 0, promo_name: '', forecast_qty: r.forecast_qty }))
    setCombinedPosDataForZoom([...merged, ...forecastOnly].sort((a, b) => a.week.localeCompare(b.week)))
  }, [posData, rollingForecastData, rollingForecastSnapshot, baseForecastMap])

  const [kpis, setKpis] = useState({ totalSales: 0, totalRevenue: 0, fillRate: 0, stockoutRate: 0 })
  const displayKpis = selectedBranch !== 'base' ? branchKpis : kpis

  // ── Apply inline summary data ─────────────────────────────────────────────

  const applySummary = useCallback((s: SimulationSummary) => {
    const pos  = aggPOS(s.weekly_pos ?? [])
    const inv  = aggStoreInv(s.store_inventory ?? [])
    const ship = aggShipments(s.weekly_shipments ?? [])
    const dc   = aggDCInv(s.dc_inventory ?? [], s.supplier_dc_inventory ?? [])
    setPosData(pos)
    setStoreInvData(inv)
    setShipData(ship)
    setDcInvData(dc)
    setKpis(computeKPIs(s.weekly_pos ?? [], s.weekly_shipments ?? []))
  }, [])

  // ── Initial load ──────────────────────────────────────────────────────────

  const loadSummary = useCallback(async () => {
    // Skip entirely when any sidebar filter is active — the dedicated filter effect
    // handles fetching filtered summaries. Otherwise loadSummary would overwrite the
    // filtered posData/storeInvData/etc with portfolio-wide unfiltered aggregates.
    // Use getState() to bypass useCallback's stale closure.
    const fs = useFilterStore.getState()
    const anyFilter = !!(fs.globalItem || fs.globalStore || fs.globalSdc || fs.globalRdc || fs.globalCategory || fs.globalSubcategory || fs.globalBrand)
    if (anyFilter) { setPageState('ready'); return }
    // When a non-base branch is selected, always fetch fresh from the branch's simulation_id.
    if (analyticsSimId !== simulationId) {
      // Skip if the selected branch hasn't run yet — the child sim has no analytics.
      // Keep the parent's data on screen; the branch-forecast overlay renders on top.
      const childRun = allRuns.find(r => r.simulation_id === analyticsSimId)
      if (childRun && childRun.simulation_status !== 'COMPLETED') {
        setPageState('ready')
        return
      }
      try {
        const [metaData, storeSales, storeInv, supplyChain, upstream] = await Promise.all([
          getAnalyticsMeta(analyticsSimId),
          getSummaryStoreSales(analyticsSimId),
          getSummaryStoreInventory(analyticsSimId),
          getSummarySupplyChainSales(analyticsSimId),
          getSummaryUpstreamInventory(analyticsSimId),
        ])
        setMeta(metaData)
        setPosData(aggPOS(storeSales.weekly_pos ?? []))
        setStoreInvData(aggStoreInv(storeInv.store_inventory ?? []))
        setShipData(aggShipments(supplyChain.weekly_shipments ?? []))
        setDcInvData(aggDCInv(upstream.dc_inventory ?? [], upstream.supplier_dc_inventory ?? []))
        setKpis(computeKPIs(storeSales.weekly_pos ?? [], supplyChain.weekly_shipments ?? []))
        setPageState('ready')
      } catch (err: unknown) {
        setPageError(err instanceof Error ? err.message : 'Failed to load analytics')
        setPageState('error')
      }
      return
    }
    if (cache?.simulationId === simulationId && cache.summary) {
      // Check if the cache is stale: if the summary only contains base/null run_type rows,
      // rolling_chunk and extension weeks are absent. Bust the cache so fresh data is fetched.
      const cachedPos = cache.summary.weekly_pos ?? []
      const hasRollingOrExtensionRows = cachedPos.some((r: any) => r.run_type === 'rolling_chunk' || r.run_type === 'extension')
      if (hasRollingOrExtensionRows) {
        // Cache has up-to-date rolling/extension data — use it directly
        setSimName(cache.simulationName)
        applySummary(cache.summary)
        getAnalyticsMeta(simulationId).then(setMeta).catch(() => null)
        setPageState('ready')
        return
      }
      // Cache only has base rows (no rolling_chunk/extension) — fall through to fresh fetch
      // to pick up any rolling chunks or extensions that have since completed.
    }
    try {
      const [metaData, storeSales, storeInv, supplyChain, upstream] = await Promise.all([
        getAnalyticsMeta(simulationId),
        getSummaryStoreSales(simulationId),
        getSummaryStoreInventory(simulationId),
        getSummarySupplyChainSales(simulationId),
        getSummaryUpstreamInventory(simulationId),
      ])
      setMeta(metaData)
      setPosData(aggPOS(storeSales.weekly_pos ?? []))
      setStoreInvData(aggStoreInv(storeInv.store_inventory ?? []))
      setShipData(aggShipments(supplyChain.weekly_shipments ?? []))
      setDcInvData(aggDCInv(upstream.dc_inventory ?? [], upstream.supplier_dc_inventory ?? []))
      setKpis(computeKPIs(storeSales.weekly_pos ?? [], supplyChain.weekly_shipments ?? []))
      setPageState('ready')
    } catch (err: unknown) {
      setPageError(err instanceof Error ? err.message : 'Failed to load analytics')
      setPageState('error')
    }
  }, [simulationId, analyticsSimId, cache, applySummary, allRuns])



  // ── Load rolling forecast session and unrun forecast demand ───────────────
  const baseSeed: number = (runFullConfig as any)?.random_seed ?? 42

  const refreshRollingForecast = useCallback(async () => {
    if (!runEndWeek) return
    try {
      const session = await getRollingSession(simulationId)
      setRollingSession(session)
      // Fetch promo performance pcts for tooltip display
      getSessionPromoSchedules(session.session_id).then(schedules => {
        const map: Record<string, number | null> = {}
        for (const s of schedules) {
          if (s.performance_pct != null) map[s.promo_group_name] = s.performance_pct
        }
        setPromoGroupPerfMap(map)
      }).catch(() => null)
      // If chunks have run, the cache is stale — re-fetch all charts from backend with current filters
      if (session.chunks && session.chunks.length > 0) {
        const activeFilters = {
          item_id: globalItem || undefined,
          store_id: globalStore || undefined,
          category: globalCategory || undefined,
          subcategory: globalSubcategory || undefined,
          brand: globalBrand || undefined,
        }
        const shipFilters = {
          item_id: globalItem || undefined,
          supplier_dc_id: globalSdc || undefined,
          retailer_dc_id: globalRdc || undefined,
          category: globalCategory || undefined,
          subcategory: globalSubcategory || undefined,
          brand: globalBrand || undefined,
        }
        getSummaryStoreSales(simulationId, activeFilters)
          .then(s => setPosData(aggPOS(s.weekly_pos ?? [])))
          .catch(() => null)
        getSummaryStoreInventory(simulationId, activeFilters)
          .then(s => setStoreInvData(aggStoreInv(s.store_inventory ?? [])))
          .catch(() => null)
        getSummarySupplyChainSales(simulationId, shipFilters)
          .then(s => setShipData(aggShipments(s.weekly_shipments ?? [])))
          .catch(() => null)
        getDCInventory(simulationId, {
          item_id:        globalItem || undefined,
          dc_id:          globalRdc  || undefined,
          supplier_dc_id: globalSdc  || undefined,
          category:       globalCategory    || undefined,
          subcategory:    globalSubcategory || undefined,
          brand:          globalBrand       || undefined,
        }).then(s => setDcInvData(aggDCInv(s.dc_inventory ?? [], s.supplier_dc_inventory ?? [])))
          .catch(() => null)
      }
      if (session.status === 'active') {
        const futureStartWeek = session.current_completed_week
          ? toIsoWeek(new Date(new Date(session.current_completed_week + 'T12:00:00').getTime() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10))
          : toIsoWeek(runEndWeek)
        const endWeek = toIsoWeek(session.total_end_date)
        const seed = (runFullConfig as any)?.random_seed ?? 42
        const filters = {
          item_id: globalItem || undefined,
          store_id: globalStore || undefined,
          category: globalCategory || undefined,
          subcategory: globalSubcategory || undefined,
          brand: globalBrand || undefined,
        }
        // Fetch future demand (for the forecast line/bar)
        getDemandWeeklyTotals(session.retailer_account_id, futureStartWeek, endWeek, seed, filters)
          .then(rows => {
            const mapped = rows.map(r => ({ week: r.pos_week, forecast_qty: r.demand_qty }))
            setRollingForecastData(mapped)
            setRollingForecastSnapshot(prev => {
              const next = new Map(prev)
              mapped.forEach(r => next.set(r.week, r.forecast_qty))
              return next
            })
          })
          .catch(() => null)

        // Backfill snapshot with original forecast for already-completed chunk weeks.
        // weekly_demand retains the pre-run forecast even after chunks execute, so this
        // gives us the original prediction to compare against actual demand in the tooltip.
        const completedChunks = (session.chunks ?? []).filter(c => c.status === 'completed')
        if (completedChunks.length > 0) {
          const sorted = [...completedChunks].sort((a, b) => a.chunk_number - b.chunk_number)
          const snapshotStartWeek = toIsoWeek(sorted[0].start_week)
          const snapshotEndWeek = toIsoWeek(session.current_completed_week!)
          getDemandWeeklyTotals(session.retailer_account_id, snapshotStartWeek, snapshotEndWeek, seed, filters)
            .then(rows => {
              setRollingForecastSnapshot(prev => {
                const next = new Map(prev)
                rows.forEach(r => next.set(r.pos_week, r.demand_qty))
                return next
              })
            })
            .catch(() => null)
        }
      } else {
        setRollingForecastData([])
      }
    } catch {
      // 404 = no active session, that's fine
    }
  }, [simulationId, runEndWeek, runFullConfig,
      globalItem, globalStore, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand])

  useEffect(() => {
    if (pageState !== 'ready' || !runEndWeek) return
    refreshRollingForecast()
  }, [pageState, refreshRollingForecast, runEndWeek])

  // ── Fetch base simulation forecasted demand from weekly_demand ────────────
  useEffect(() => {
    // On branch views the child sim only exposes post-anchor rows, so posData has no base weeks.
    // Prefer parentPosData in that case — the base forecast we need is the parent's, since pre-anchor
    // context on the branch is sourced from the parent.
    const sourceRows = selectedBranch !== 'base' && parentPosData.length > 0 ? parentPosData : posData
    const baseWeeks = sourceRows.filter((d: any) => d.run_type === 'base')
    if (baseWeeks.length === 0 || !runFullConfig) return
    const seed = (runFullConfig as any)?.random_seed ?? 42
    const retailerAccountId = params.retailerAccountId as string
    const startWeek = baseWeeks[0].week
    const endWeek = baseWeeks[baseWeeks.length - 1].week
    const filters = {
      item_id: globalItem || undefined,
      store_id: globalStore || undefined,
      category: globalCategory || undefined,
      subcategory: globalSubcategory || undefined,
      brand: globalBrand || undefined,
    }
    getDemandWeeklyTotals(retailerAccountId, startWeek, endWeek, seed, filters)
      .then(rows => {
        const m = new Map<string, number>()
        rows.forEach(r => m.set(r.pos_week, r.demand_qty))
        setBaseForecastMap(m)
      })
      .catch(() => null)
  }, [posData, parentPosData, selectedBranch, runFullConfig, params.retailerAccountId,
      globalItem, globalStore, globalCategory, globalSubcategory, globalBrand])

  // ── Filtered fetch handlers ───────────────────────────────────────────────

  const fetchPOSFiltered = useCallback(async (itemId: string, storeId: string, category: string, subcategory: string, brand: string) => {
    setPosLoading(true); setPosError('')
    try {
      const p = { item_id: itemId || undefined, store_id: storeId || undefined, category: category || undefined, subcategory: subcategory || undefined, brand: brand || undefined }
      const data = await getStoreSales(analyticsSimId, p)
      setPosData(aggPOS(data.weekly_pos ?? []))
    } catch (e: any) { setPosError(e?.message ?? 'Failed') }
    finally { setPosLoading(false) }
  }, [analyticsSimId])

  const fetchStoreInvFiltered = useCallback(async (itemId: string, storeId: string, category: string, subcategory: string, brand: string) => {
    setStoreInvLoading(true); setStoreInvError('')
    try {
      const p = { item_id: itemId || undefined, store_id: storeId || undefined, category: category || undefined, subcategory: subcategory || undefined, brand: brand || undefined }
      const data = await getStoreInventory(analyticsSimId, p)
      const rows = aggStoreInv(data.store_inventory ?? [])
      setStoreInvData(rows)
      if (rows.length === 0 && analyticsStatusRef.current === 'READY') {
        setAnalyticsStatus('PENDING')
      }
    } catch (e: any) { setStoreInvError(e?.message ?? 'Failed') }
    finally { setStoreInvLoading(false) }
  }, [analyticsSimId])

  const fetchShipFiltered = useCallback(async (itemId: string, sdcId: string, rdcId: string, category: string, subcategory: string, brand: string) => {
    setShipLoading(true); setShipError('')
    try {
      const data = await getSupplierSales(analyticsSimId, {
        item_id:          itemId || undefined,
        supplier_dc_id:   sdcId  || undefined,
        retailer_dc_id:   rdcId  || undefined,
        category:         category  || undefined,
        subcategory:      subcategory || undefined,
        brand:            brand    || undefined,
      })
      setShipData(aggShipments(data.weekly_shipments ?? []))
    } catch (e: any) { setShipError(e?.message ?? 'Failed') }
    finally { setShipLoading(false) }
  }, [analyticsSimId])

  const fetchDCInvFiltered = useCallback(async (itemId: string, rdcId: string, sdcId: string, category: string, subcategory: string, brand: string) => {
    setDcInvLoading(true); setDcInvError('')
    try {
      const data = await getDCInventory(analyticsSimId, {
        item_id:        itemId || undefined,
        dc_id:          rdcId  || undefined,
        supplier_dc_id: sdcId  || undefined,
        category:       category  || undefined,
        subcategory:    subcategory || undefined,
        brand:          brand    || undefined,
      })
      const rows = aggDCInv(data.dc_inventory ?? [], data.supplier_dc_inventory ?? [])
      setDcInvData(rows)
      if (rows.length === 0 && analyticsStatusRef.current === 'READY') {
        setAnalyticsStatus('PENDING')
      }
    } catch (e: any) { setDcInvError(e?.message ?? 'Failed') }
    finally { setDcInvLoading(false) }
  }, [analyticsSimId])

  const resetToSummary = useCallback((chart: 'pos' | 'inv' | 'ship' | 'dc') => {
    const cachedPos = cache?.summary?.weekly_pos ?? []
    const cacheHasRollingRows = cachedPos.some((r: any) => r.run_type === 'rolling_chunk' || r.run_type === 'extension')
    if (cache?.simulationId === simulationId && cache.summary && cacheHasRollingRows) {
      const s = cache.summary
      if (chart === 'pos')  setPosData(aggPOS(s.weekly_pos ?? []))
      if (chart === 'inv')  setStoreInvData(aggStoreInv(s.store_inventory ?? []))
      if (chart === 'ship') setShipData(aggShipments(s.weekly_shipments ?? []))
      if (chart === 'dc')   setDcInvData(aggDCInv(s.dc_inventory ?? [], s.supplier_dc_inventory ?? []))
    } else {
      loadSummary()
    }
  }, [cache, simulationId, loadSummary])

  // Clear sidebar options on unmount
  useEffect(() => () => clearOptions(), [clearOptions])

  // React to any sidebar filter change and re-fetch affected charts.
  // Category/Subcategory/Brand narrow the item list but the backend only takes item_id,
  // so when those change we still call the API with the current item (or reset to summary).
  // Skip the initial mount run (all filters are empty on first render).
  const filterMountedRef = useRef(false)
  useEffect(() => {
    if (!filterMountedRef.current) { filterMountedRef.current = true; return }
    if (pageState !== 'ready') return
    const posFilters = {
      item_id: globalItem || undefined,
      store_id: globalStore || undefined,
      category: globalCategory || undefined,
      subcategory: globalSubcategory || undefined,
      brand: globalBrand || undefined,
    }
    const shipFilters = {
      item_id: globalItem || undefined,
      supplier_dc_id: globalSdc || undefined,
      retailer_dc_id: globalRdc || undefined,
      category: globalCategory || undefined,
      subcategory: globalSubcategory || undefined,
      brand: globalBrand || undefined,
    }
    const anyPos  = !!(globalItem || globalStore || globalCategory || globalSubcategory || globalBrand)
    const anyShip = !!(globalItem || globalSdc || globalRdc || globalCategory || globalSubcategory || globalBrand)
    const anyFilter = anyPos || anyShip
    if (anyPos) {
      fetchPOSFiltered(globalItem, globalStore, globalCategory, globalSubcategory, globalBrand)
      fetchStoreInvFiltered(globalItem, globalStore, globalCategory, globalSubcategory, globalBrand)
    } else {
      resetToSummary('pos'); resetToSummary('inv')
    }
    if (anyShip) { fetchShipFiltered(globalItem, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand); fetchDCInvFiltered(globalItem, globalRdc, globalSdc, globalCategory, globalSubcategory, globalBrand) }
    else         { resetToSummary('ship'); resetToSummary('dc') }
    // Re-fetch KPI summary using all active filters so KPI cards always reflect the filtered scope.
    // posFilters covers item/store/category/subcategory/brand (drives Total Sales, Revenue, Stockout Rate).
    // shipFilters covers item/SDC/RDC/category/subcategory/brand (drives Avg Fill Rate).
    // When no filters are active both calls fetch the full unfiltered summary.
    Promise.all([
      getSummaryStoreSales(simulationId, anyFilter ? posFilters : undefined),
      getSummarySupplyChainSales(simulationId, anyFilter ? shipFilters : undefined),
    ]).then(([ss, sc]) => {
      setKpis(computeKPIs(ss.weekly_pos ?? [], sc.weekly_shipments ?? []))
    }).catch(() => null)
    // Re-fetch rolling forecast demand with the updated filters so it matches the same scope
    if (rollingSession?.status === 'active') refreshRollingForecast()
  // Depend on analyticsSimId too — after a branch switch, loadSummary overwrites posData with
  // unfiltered summary data, so we must re-fetch with the active filters to avoid stale portfolio-wide
  // bars appearing on a filtered branch view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalItem, globalStore, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand, analyticsSimId])

  // ── Coordinate branch selector with the affected-items filter ────────────
  // Switching to Reactive/Adaptive auto-picks the first affected item (branch
  // forecast is scoped to those items, so historical bars must be too).
  // Switching back to Main-line clears the filter only if it's currently on an
  // affected item — a manually-picked non-affected item is preserved.
  useEffect(() => {
    const items = meta?.items_meta ?? []
    if (!affectedItemCodes || affectedItemCodes.size === 0 || items.length === 0) return
    const affectedIds = items.filter((m: any) => affectedItemCodes.has(m.item_code)).map((m: any) => m.item_id)
    if (affectedIds.length === 0) return
    if (selectedBranch === 'base') {
      if (globalItem && affectedIds.includes(globalItem)) setFilters({ globalItem: '' })
      return
    }
    if (globalItem && affectedIds.includes(globalItem)) return
    setFilters({ globalItem: affectedIds[0] })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranch, hlsData, meta])

  // ── Fetch HLS reconciliation data ─────────────────────────────────────────
  // Fires as soon as simulationId is known. For non-HLS runs the response has
  // an empty under_fulfilled_shipments array and disruption_windows, so the
  // section renders nothing. Not gated on pageState / runFullConfig to avoid
  // a race where the section shows only after refresh (previously the effect
  // depended on runFullConfig arriving before pageState=ready).
  // Always fetch from the PARENT simulation, not analyticsSimId. Branch children
  // run with `resolved_scenario = None` so their /hidden-lost-sales response has an
  // empty disruption_windows array — which would collapse stockoutEndWeek to null
  // and drop the Forecast Start line on branch views.
  useEffect(() => {
    if (!simulationId) return
    let cancelled = false
    getHiddenLostSales(simulationId)
      .then((d) => { if (!cancelled) setHlsData(d) })
      .catch(() => null)
    return () => { cancelled = true }
  }, [simulationId])

  // ── Fetch per-branch planner forecast rows for the post-stockout tail ─────
  // Always fetch from the REACTIVE child: those rows carry both `planner_forecast`
  // (dampened) and `base_demand` (baseline), which we use for Reactive and Adaptive
  // overlays respectively. The Adaptive child has no rows written by the backend.
  //
  // Do NOT clear rows on selectedBranch change — showBranchForecastTail already gates
  // rendering by branch, so keeping the cache prevents a flash-of-empty-tail when
  // toggling Main-line ↔ Reactive/Adaptive. Only clear when the reactive child id
  // itself disappears.
  const reactiveChildId = reactiveChild?.simulation_id ?? null
  useEffect(() => {
    if (!reactiveChildId) {
      setBranchForecastRows([])
      return
    }
    // Skip refetch if we already have rows keyed to this child; this avoids the flash-of-empty
    // during branch toggle AND recovers naturally on retry-toggles when a prior fetch failed
    // (empty rows → refetch).
    if (branchForecastRows.length > 0 && branchForecastRows[0]?.simulation_id === reactiveChildId) return
    let cancelled = false
    getBranchForecast(reactiveChildId)
      .then(rows => { if (!cancelled) setBranchForecastRows(rows) })
      .catch(() => { /* keep prior rows; user can retry by re-toggling branch */ })
    return () => { cancelled = true }
  // Depend on selectedBranch so a manual re-toggle retries a failed fetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactiveChildId, selectedBranch])

  // ── Fetch parent's POS data for pre-anchor context on branch views ──────
  // When the user is on Reactive/Adaptive we always want main-line's historical
  // bars to the LEFT of Forecast Start — regardless of whether the branch child
  // has run yet. Once the branch is COMPLETED, analyticsSimId switches to the
  // child (which only has post-anchor rows), so without this we lose the pre-anchor
  // history entirely. Honors the item/store/category filter so the parent's slice
  // matches the branch's slice.
  useEffect(() => {
    // Parent slices are needed on branch views AND on the Comparison tab (which merges both branches
    // with the parent's pre-anchor context). Bail on Main-line dashboard where they're unused.
    if (selectedBranch === 'base' && activeTab !== 'comparison') {
      setParentPosData([]); setParentStoreInvData([]); setParentShipData([]); setParentDcInvData([])
      setParentPosLoading(false)
      return
    }
    if (!isHls || !simulationId) return
    let cancelled = false
    const filters = {
      item_id: globalItem || undefined,
      store_id: globalStore || undefined,
      category: globalCategory || undefined,
      subcategory: globalSubcategory || undefined,
      brand: globalBrand || undefined,
    }
    // Shipments have their own filter shape (no category/subcategory/brand)
    const shipFilters = {
      item_id: globalItem || undefined,
      store_id: globalStore || undefined,
      supplier_dc_id: globalSdc || undefined,
      retailer_dc_id: globalRdc || undefined,
    }
    // DC inventory filters (retailer/supplier DC scoping)
    const dcFilters = {
      item_id: globalItem || undefined,
      supplier_dc_id: globalSdc || undefined,
      retailer_dc_id: globalRdc || undefined,
      category: globalCategory || undefined,
      subcategory: globalSubcategory || undefined,
      brand: globalBrand || undefined,
    }
    const anyFilter = !!(globalItem || globalStore || globalCategory || globalSubcategory || globalBrand)
    const anyShipFilter = !!(globalItem || globalStore || globalSdc || globalRdc)
    const anyDcFilter = !!(globalItem || globalSdc || globalRdc || globalCategory || globalSubcategory || globalBrand)
    setParentPosLoading(true)
    Promise.all([
      getSummaryStoreSales(simulationId, anyFilter ? filters : undefined).catch(() => ({ weekly_pos: [] })),
      getSummaryStoreInventory(simulationId, anyFilter ? filters : undefined).catch(() => ({ store_inventory: [] })),
      getSummarySupplyChainSales(simulationId, anyShipFilter ? shipFilters : undefined).catch(() => ({ weekly_shipments: [] })),
      getSummaryUpstreamInventory(simulationId, anyDcFilter ? dcFilters : undefined).catch(() => ({ dc_inventory: [], supplier_dc_inventory: [] })),
    ]).then(([pos, storeInv, ship, upstream]) => {
      if (cancelled) return
      setParentPosData(aggPOS((pos as any).weekly_pos ?? []))
      setParentStoreInvData(aggStoreInv((storeInv as any).store_inventory ?? []))
      setParentShipData(aggShipments((ship as any).weekly_shipments ?? []))
      setParentDcInvData(aggDCInv((upstream as any).dc_inventory ?? [], (upstream as any).supplier_dc_inventory ?? []))
      setParentPosLoading(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationId, selectedBranch, activeTab, isHls, globalItem, globalStore, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand])

  // ── Fetch both branches' POS+StoreInv for the Comparison tab ──────────────
  // Only when both branch children are COMPLETED and the tab is active. Honors the current filter.
  useEffect(() => {
    if (activeTab !== 'comparison') return
    if (!bothBranchesCompleted || !reactiveChild || !adaptiveChild) return
    let cancelled = false
    const filters = {
      item_id: globalItem || undefined,
      store_id: globalStore || undefined,
      category: globalCategory || undefined,
      subcategory: globalSubcategory || undefined,
      brand: globalBrand || undefined,
    }
    const shipFilters = {
      item_id: globalItem || undefined,
      store_id: globalStore || undefined,
      supplier_dc_id: globalSdc || undefined,
      retailer_dc_id: globalRdc || undefined,
    }
    const anyFilter = !!(globalItem || globalStore || globalCategory || globalSubcategory || globalBrand)
    const anyShipFilter = !!(globalItem || globalStore || globalSdc || globalRdc)
    const f = anyFilter ? filters : undefined
    const sf = anyShipFilter ? shipFilters : undefined
    setCmpLoading(true)
    Promise.all([
      getSummaryStoreSales(reactiveChild.simulation_id, f).catch(() => ({ weekly_pos: [] })),
      getSummaryStoreInventory(reactiveChild.simulation_id, f).catch(() => ({ store_inventory: [] })),
      getSummarySupplyChainSales(reactiveChild.simulation_id, sf).catch(() => ({ weekly_shipments: [] })),
      getSummaryStoreSales(adaptiveChild.simulation_id, f).catch(() => ({ weekly_pos: [] })),
      getSummaryStoreInventory(adaptiveChild.simulation_id, f).catch(() => ({ store_inventory: [] })),
      getSummarySupplyChainSales(adaptiveChild.simulation_id, sf).catch(() => ({ weekly_shipments: [] })),
    ]).then(([rPos, rInv, rShip, aPos, aInv, aShip]) => {
      if (cancelled) return
      setCmpReactivePos(aggPOS((rPos as any).weekly_pos ?? []))
      setCmpReactiveInv(aggStoreInv((rInv as any).store_inventory ?? []))
      setCmpReactiveShip(aggShipments((rShip as any).weekly_shipments ?? []))
      setCmpAdaptivePos(aggPOS((aPos as any).weekly_pos ?? []))
      setCmpAdaptiveInv(aggStoreInv((aInv as any).store_inventory ?? []))
      setCmpAdaptiveShip(aggShipments((aShip as any).weekly_shipments ?? []))
      setCmpLoading(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, bothBranchesCompleted, reactiveChild?.simulation_id, adaptiveChild?.simulation_id,
      globalItem, globalStore, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand])

  // ── Status polling ────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    if (cache?.simulationId === simulationId && cache.summary) {
      loadSummary()
      getRunConfig(simulationId).then(cfg => {
        if (!cancelled) {
          setSimName(String((cfg.full_config as any)?.run?.simulation_name ?? cache.simulationName))
          setRunFullConfig(cfg.full_config)
          if (cfg.end_week) setRunEndWeek(cfg.end_week)
        }
      }).catch(() => null)
      return
    }

    const checkStatus = async () => {
      try {
        const cfg = await getRunConfig(simulationId)
        const name = (cfg.full_config as any)?.run?.simulation_name ?? 'Simulation Results'
        if (!cancelled) {
          setSimName(String(name))
          setRunFullConfig(cfg.full_config)
          if (cfg.end_week) setRunEndWeek(cfg.end_week)
        }
        if (cfg.status === 'COMPLETED') {
          if (!cancelled) await loadSummary()
        } else if (cfg.status === 'FAILED') {
          if (!cancelled) { setPageError('Simulation failed.'); setPageState('error') }
        } else {
          if (!cancelled) { setPageState('polling'); timer = setTimeout(checkStatus, 4000) }
        }
      } catch (err: unknown) {
        if (!cancelled) { setPageError(err instanceof Error ? err.message : 'Failed to check status'); setPageState('error') }
      }
    }

    checkStatus()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [simulationId, loadSummary, cache])

  // Fetch runs list to detect siblings/branches for the current simulation
  useEffect(() => {
    const retId = params.retailerAccountId as string
    if (!retId) return
    let cancelled = false
    getRuns(retId, '').then(rs => { if (!cancelled) setAllRuns(rs) }).catch(() => null)
    return () => { cancelled = true }
  }, [params.retailerAccountId, simulationId])

  // When branch selection changes, refetch analytics for the newly selected sim id
  useEffect(() => {
    if (pageState !== 'ready') return
    // Skip: the sidebar-filter effect fetches filtered summaries whenever a
    // filter is active. Running loadSummary here would overwrite that with the
    // unfiltered aggregate and leave the chart showing portfolio-wide bars
    // while the sidebar shows a specific item selected.
    const anyFilter = !!(globalItem || globalStore || globalSdc || globalRdc || globalCategory || globalSubcategory || globalBrand)
    if (anyFilter) return
    loadSummary()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyticsSimId])

  // Auto-hide the READY banner after 5s
  useEffect(() => {
    if (analyticsStatus === 'READY') {
      bannerDismissRef.current = setTimeout(() => setAnalyticsReadyVisible(false), 5_000)
    }
    return () => { if (bannerDismissRef.current) clearTimeout(bannerDismissRef.current) }
  }, [analyticsStatus])

  // Keep ref in sync so fetch callbacks can read current status without stale closure
  useEffect(() => { analyticsStatusRef.current = analyticsStatus }, [analyticsStatus])

  // When analytics becomes READY, reload summary tiles and all 4 charts from ClickHouse immediately
  useEffect(() => {
    if (analyticsStatus !== 'READY') return
    loadSummary()
    fetchPOSFiltered(globalItem, globalStore, globalCategory, globalSubcategory, globalBrand)
    fetchStoreInvFiltered(globalItem, globalStore, globalCategory, globalSubcategory, globalBrand)
    fetchShipFiltered(globalItem, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand)
    fetchDCInvFiltered(globalItem, globalRdc, globalSdc, globalCategory, globalSubcategory, globalBrand)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyticsStatus])

  // Poll analytics-status endpoint until CH write is done
  useEffect(() => {
    if (pageState !== 'ready' || (analyticsStatus !== 'PENDING' && analyticsStatus !== null)) return
    let cancelled = false
    const poll = async () => {
      try {
        const { ready } = await getAnalyticsStatus(simulationId)
        if (!cancelled) setAnalyticsStatus(ready ? 'READY' : 'PENDING')
        if (!cancelled && !ready) setTimeout(poll, 3000)
      } catch { /* silent — banner just stays */ }
    }
    const t = setTimeout(poll, 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [pageState, analyticsStatus, simulationId])

  const allItemOptions  = [...new Map((meta?.items_meta ?? []).map((m: any) => [m.item_id, { value: m.item_id, label: m.item_description ? `${m.item_name} — ${m.item_description}` : m.item_name }])).values()]
  const allStoreOptions = (meta?.stores_meta ?? []).map((m: any) => ({ value: m.store_id, label: m.store_code }))

  // Build item→stores and store→items lookup from store_item_map
  const storeItemMap = meta?.store_item_map ?? {}
  const itemStoreMap: Record<string, string[]> = {}
  for (const [storeId, itemIds] of Object.entries(storeItemMap)) {
    for (const itemId of itemIds) {
      if (!itemStoreMap[itemId]) itemStoreMap[itemId] = []
      itemStoreMap[itemId].push(storeId)
    }
  }

  const allSupplierDCOptions = (meta?.dcs_meta ?? [])
    .filter((m: any) => m.dc_role === 'SUPPLIER_DC')
    .map((m: any) => ({ value: m.dc_id, label: m.dc_code }))
  const allRetailerDCOptions = (meta?.dcs_meta ?? [])
    .filter((m: any) => m.dc_role !== 'SUPPLIER_DC')
    .map((m: any) => ({ value: m.dc_id, label: m.dc_code }))

  const supplierDcItemMap = meta?.supplier_dc_item_map ?? {}
  const rdcToSdcMap       = meta?.rdc_to_sdc_map       ?? {}

  // item→SDCs: SDCs that carry the item (with optional RDC cross-filter)
  function filteredShipSdcOptions(itemId: string, rdcId: string) {
    let opts = allSupplierDCOptions
    if (rdcId) {
      const sdcsForRdc = new Set(rdcToSdcMap[rdcId] ?? [])
      opts = opts.filter(o => sdcsForRdc.has(o.value))
    }
    if (itemId) {
      opts = opts.filter(o => (supplierDcItemMap[o.value] ?? []).includes(itemId))
    }
    return opts
  }

  // item→RDCs: RDCs served by the selected SDC (with optional item cross-filter)
  function filteredShipRdcOptions(itemId: string, sdcId: string) {
    let opts = allRetailerDCOptions
    if (sdcId) {
      const rdcsForSdc = new Set(
        Object.entries(rdcToSdcMap)
          .filter(([, sdcs]) => (sdcs as string[]).includes(sdcId))
          .map(([rdc]) => rdc)
      )
      opts = opts.filter(o => rdcsForSdc.has(o.value))
    }
    if (itemId) {
      const dcItemMap = meta?.dc_item_map ?? {}
      opts = opts.filter(o => (dcItemMap[o.value] ?? []).includes(itemId))
    }
    return opts
  }

  function filteredStoreOptions(activeItemId: string) {
    if (!activeItemId) return allStoreOptions
    const allowed = new Set(itemStoreMap[activeItemId] ?? [])
    return allStoreOptions.filter(o => allowed.has(o.value))
  }

  // Populate sidebar filter panel options whenever meta changes
  useEffect(() => {
    if (!meta) return
    const itemsMeta = meta.items_meta ?? []

    const categoryOptions = [...new Set(itemsMeta.map((m: any) => m.category).filter(Boolean))]
      .sort().map((v: string) => ({ value: v, label: v }))
    const subcategoryOptions = [...new Set(itemsMeta.map((m: any) => m.subcategory).filter(Boolean))]
      .sort().map((v: string) => ({ value: v, label: v }))
    const brandOptions = [...new Set(itemsMeta.map((m: any) => m.brand).filter(Boolean))]
      .sort().map((v: string) => ({ value: v, label: v }))

    function filteredItemOptions(category: string, subcategory: string, brand: string) {
      let items = itemsMeta
      if (category)    items = items.filter((m: any) => m.category    === category)
      if (subcategory) items = items.filter((m: any) => m.subcategory === subcategory)
      if (brand)       items = items.filter((m: any) => m.brand       === brand)
      return items.map((m: any) => ({ value: m.item_id, label: m.item_description || m.item_name || m.item_code }))
    }

    function filteredSubcategoryOptions(category: string) {
      const items = category ? itemsMeta.filter((m: any) => m.category === category) : itemsMeta
      return [...new Set(items.map((m: any) => m.subcategory).filter(Boolean))]
        .sort().map((v: string) => ({ value: v, label: v }))
    }

    function filteredBrandOptions(category: string, subcategory: string) {
      let items = itemsMeta
      if (category)    items = items.filter((m: any) => m.category    === category)
      if (subcategory) items = items.filter((m: any) => m.subcategory === subcategory)
      return [...new Set(items.map((m: any) => m.brand).filter(Boolean))]
        .sort().map((v: string) => ({ value: v, label: v }))
    }

    setOptions({
      itemOptions: allItemOptions,
      storeOptions: allStoreOptions,
      sdcOptions: allSupplierDCOptions,
      rdcOptions: allRetailerDCOptions,
      categoryOptions,
      subcategoryOptions,
      brandOptions,
      filteredStoreOptions: (itemId) => filteredStoreOptions(itemId),
      filteredSdcOptions: (itemId, rdcId) => filteredShipSdcOptions(itemId, rdcId),
      filteredRdcOptions: (itemId, sdcId) => filteredShipRdcOptions(itemId, sdcId),
      filteredItemOptions,
      filteredSubcategoryOptions,
      filteredBrandOptions,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta])

  const xAxisProps = { angle: -45, textAnchor: 'end' as const, height: 80, tick: { fontSize: 10 } }

  const yAxisTickFormatter = (v: number) => v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}K` : v.toLocaleString()

  const [exportLoading, setExportLoading] = useState(false)
  const handleExport = async () => {
    setExportLoading(true)
    try {
      const url = getSimulationExportUrl(simulationId)
      const a = document.createElement('a')
      a.href = url
      a.download = ''
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } finally {
      setExportLoading(false)
    }
  }

  if (pageState === 'loading' || pageState === 'polling') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 py-32">
        <Loader2 size={40} className="animate-spin text-majorelle-blue-500" />
        <p className="text-lg font-semibold text-charcoal-blue-600">
          {pageState === 'polling' ? 'Simulation is running…' : 'Loading results…'}
        </p>
        {pageState === 'polling' && (
          <p className="text-sm text-charcoal-blue-400">This page updates automatically when done.</p>
        )}
      </div>
    )
  }

  if (pageState === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 py-32">
        <AlertCircle size={40} className="text-rose-500" />
        <p className="text-lg font-semibold text-charcoal-blue-950">Failed to load results</p>
        <p className="text-sm text-charcoal-blue-400">{pageError}</p>
      </div>
    )
  }

  return (
    <>
    <div className="w-full min-h-screen bg-gradient-to-br from-charcoal-blue-50 via-white to-charcoal-blue-50 px-6 py-6">
      <div className="w-full">

        {/* Header */}
        <div className="mb-5 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-black tracking-tight text-charcoal-blue-950">{simName}</h1>
              {hasBranches && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                  selectedBranch === 'reactive' ? 'bg-rose-100 text-rose-700'
                  : selectedBranch === 'adaptive' ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-charcoal-blue-100 text-charcoal-blue-700'
                }`}>
                  {selectedBranch === 'base' ? 'Main-line' : selectedBranch === 'reactive' ? 'Reactive' : 'Adaptive'}
                </span>
              )}
              <button
                onClick={() => setYamlModalOpen(true)}
                title="View run YAML config"
                className="self-end rounded-full p-1 text-charcoal-blue-400 hover:bg-charcoal-blue-100 hover:text-charcoal-blue-700 transition-colors"
              >
                <FileCode size={16} />
              </button>
            </div>
            {meta && (
              <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">
                {meta.items_meta.length} items · {meta.stores_meta.length} stores · {meta.dcs_meta.length} DCs
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {pageState === 'ready' && hasBranches && (() => {
              const branchOpts: Array<{ v: 'base' | 'reactive' | 'adaptive'; label: string; activeCls: string; enabled: boolean }> = [
                { v: 'base',     label: 'Main-line', activeCls: 'bg-charcoal-blue-900 text-white shadow',      enabled: true },
                { v: 'reactive', label: 'Reactive',  activeCls: 'bg-rose-500 text-white shadow',               enabled: !!reactiveChild },
                { v: 'adaptive', label: 'Adaptive',  activeCls: 'bg-emerald-500 text-white shadow',            enabled: !!adaptiveChild },
              ]
              const helper =
                selectedBranch === 'reactive' ? '↑ Full correction based on avg historical performance'
                : selectedBranch === 'adaptive' ? 'Base forecast — no dampening applied'
                : 'Showing main-line simulation data'
              return (
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-charcoal-blue-500">Branch view:</span>
                  <div className="inline-flex items-center rounded-xl border border-charcoal-blue-200 bg-charcoal-blue-50 p-0.5">
                    {branchOpts.map(opt => {
                      const active = selectedBranch === opt.v
                      return (
                        <button
                          key={opt.v}
                          disabled={!opt.enabled}
                          onClick={() => opt.enabled && setSelectedBranch(opt.v)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                            active
                              ? opt.activeCls
                              : opt.enabled
                                ? 'text-charcoal-blue-600 hover:bg-white'
                                : 'text-charcoal-blue-300 cursor-not-allowed'
                          }`}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                  <span className={`text-[11px] font-medium ${
                    selectedBranch === 'reactive' ? 'text-rose-600'
                    : selectedBranch === 'adaptive' ? 'text-emerald-600'
                    : 'text-charcoal-blue-400'
                  }`}>
                    {helper}
                  </span>
                </div>
              )
            })()}
            {pageState === 'ready' && showCompareButton && (
              <button
                onClick={() => { setCompareModalOpen(true); setBranchPreview(null); setCompareError(''); }}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-rose-400 px-4 py-2 text-xs font-bold text-rose-600 transition-all hover:bg-rose-50"
              >
                <ChevronRight size={13} /> Compare Reactive vs Adaptive
              </button>
            )}
            {pageState === 'ready' && isHls && hasBranches && !bothBranchesComplete && (
              <button
                onClick={async () => {
                  if (!reactiveChild || !adaptiveChild) return
                  setRunBranchesInFlight(true); setRunBranchesError('')
                  try {
                    await runBranches(reactiveChild.simulation_id, adaptiveChild.simulation_id)
                    const retId = params.retailerAccountId as string
                    // Poll runs list until both children COMPLETED (or FAILED)
                    const done = (rs: SimulationRun[]) => {
                      const rc = rs.find(r => r.parent_simulation_id === simulationId && r.branch_type === 'reactive')
                      const ac = rs.find(r => r.parent_simulation_id === simulationId && r.branch_type === 'adaptive')
                      return rc && ac && ['COMPLETED', 'FAILED'].includes(rc.simulation_status) && ['COMPLETED', 'FAILED'].includes(ac.simulation_status)
                    }
                    for (let i = 0; i < 60; i++) {
                      const rs = await getRuns(retId, '').catch(() => [] as SimulationRun[])
                      setAllRuns(rs)
                      if (done(rs)) break
                      await new Promise(r => setTimeout(r, 4000))
                    }
                    // Refresh analytics for whichever branch is currently selected
                    if (selectedBranch !== 'base') loadSummary()
                  } catch (e: any) {
                    setRunBranchesError(e?.message ?? 'Failed to launch branch simulations')
                  } finally {
                    setRunBranchesInFlight(false)
                  }
                }}
                disabled={runBranchesInFlight}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-majorelle-blue-500 px-4 py-2 text-xs font-bold text-majorelle-blue-600 transition-all hover:bg-majorelle-blue-50 disabled:opacity-60"
                title={runBranchesError || undefined}
              >
                {runBranchesInFlight ? <Loader2 size={13} className="animate-spin" /> : <ChevronRight size={13} />}
                {runBranchesInFlight ? 'Simulating branches…' : 'Run Simulation for Future Demand'}
              </button>
            )}
            {pageState === 'ready' && !rollingSession && !isHls && (
              <button
                onClick={() => setShowRollingModal(true)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-amber-400 px-4 py-2 text-xs font-bold text-amber-600 transition-all hover:bg-amber-50"
              >
                <ChevronRight size={13} /> Rolling Forecast
              </button>
            )}
            {pageState === 'ready' && rollingSession?.status === 'active' && !isHls && (
              <button
                onClick={() => setShowRollingModal(true)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-amber-400 px-4 py-2 text-xs font-bold text-amber-600 transition-all hover:bg-amber-50"
              >
                <ChevronRight size={13} /> Edit Setup
              </button>
            )}
            {pageState === 'ready' && rollingSession?.status === 'active' && rollingForecastData.length > 0 && !isHls && (
              <button
                onClick={() => setShowRunChunkModal(true)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600"
              >
                <ChevronRight size={13} /> Run Weeks
              </button>
            )}
          <button
            onClick={handleExport}
            disabled={exportLoading}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {exportLoading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {exportLoading ? 'Exporting…' : 'Export'}
          </button>
          </div>
        </div>

        {/* Analytics write status banner */}
        {analyticsStatus === 'PENDING' && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5">
            <div className="h-3.5 w-3.5 flex-shrink-0 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
            <p className="text-xs font-semibold text-amber-800">Writing to analytics database — filtered drilldowns will be available shortly.</p>
          </div>
        )}
        {analyticsStatus === 'READY' && analyticsReadyVisible && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5">
            <span className="text-emerald-500 text-sm">✓</span>
            <p className="text-xs font-semibold text-emerald-800">Analytics database ready — all filters and drilldowns are available.</p>
          </div>
        )}
        {analyticsStatus === 'FAILED' && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5">
            <AlertCircle size={14} className="flex-shrink-0 text-rose-500" />
            <p className="text-xs font-semibold text-rose-800">Analytics write failed — filtered drilldowns may be unavailable.</p>
          </div>
        )}

        {/* Tabs */}
        <div className="mb-5 flex gap-2 border-b border-charcoal-blue-200">
          <button onClick={() => setActiveTab('dashboard')}
            className={`px-3 py-2 text-xs font-semibold transition-all border-b-2 ${
              activeTab === 'dashboard'
                ? 'border-majorelle-blue-500 text-majorelle-blue-600'
                : 'border-transparent text-charcoal-blue-400 hover:text-charcoal-blue-950'
            }`}
          >
            Data Dashboard
          </button>
          <button
            onClick={() => bothBranchesCompleted && setActiveTab('comparison')}
            disabled={!bothBranchesCompleted}
            title={bothBranchesCompleted ? '' : 'Run Compare Reactive vs Adaptive to unlock'}
            className={`inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold transition-all border-b-2 ${
              activeTab === 'comparison'
                ? 'border-majorelle-blue-500 text-majorelle-blue-600'
                : bothBranchesCompleted
                  ? 'border-transparent text-charcoal-blue-400 hover:text-charcoal-blue-950'
                  : 'border-transparent text-charcoal-blue-300 cursor-not-allowed'
            }`}
          >
            Comparison
            {!bothBranchesCompleted && <Lock size={11} />}
          </button>
        </div>

        {activeTab === 'dashboard' && (
          <>
            {/* KPIs */}
            <div className="mb-5 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <KPICard label="Total Sales (units)" value={displayKpis.totalSales.toLocaleString()} icon={ShoppingCart} color="bg-blue-500" />
              <KPICard label="Total Revenue" value={`$${(displayKpis.totalRevenue / 1000).toFixed(1)}K`} icon={Package} color="bg-emerald-500" />
              <KPICard label="Avg Fill Rate" value={`${displayKpis.fillRate.toFixed(1)}%`} icon={Truck} color="bg-majorelle-blue-500" />
              <KPICard label="Stockout Rate" value={`${displayKpis.stockoutRate.toFixed(1)}%`} icon={AlertCircle} color="bg-rose-500" />
            </div>

            {/* Hidden Lost Sales — Affected Items (moved up so users see disrupted items before scanning charts) */}
            {hlsData && hlsData.disruption_windows.length > 0 && (
              <div className="mb-5 rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
                <div className="mb-3">
                  <h3 className="text-sm font-bold text-charcoal-blue-950">Hidden Lost Sales — Affected Items</h3>
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {hlsData.disruption_windows.flatMap((w) => {
                      const codes = w.item_codes
                      if (codes === 'all' || (typeof codes === 'string' && codes === 'all')) {
                        return [{ key: `all-${w.supplier_dc_code}`, code: null, desc: `All items on ${w.supplier_dc_code}` }]
                      }
                      const arr = Array.isArray(codes) ? codes : []
                      return arr.map((c) => ({ key: `${w.supplier_dc_code}-${c}`, code: c, desc: '' }))
                    }).filter((chip, idx, arr) => arr.findIndex(x => x.key === chip.key) === idx)
                      .map((chip) => {
                        if (chip.code === null) {
                          return (
                            <span key={chip.key} className="rounded-full border border-charcoal-blue-300 bg-charcoal-blue-50 px-2.5 py-1 text-[11px] font-semibold text-charcoal-blue-700">
                              {chip.desc}
                            </span>
                          )
                        }
                        const match = (meta?.items_meta ?? []).find((m: any) => m.item_code === chip.code)
                        const label = match?.item_description || match?.item_name || chip.code
                        const isSelected = !!match && globalItem === match.item_id
                        const clickable = !!match
                        return (
                          <button
                            key={chip.key}
                            type="button"
                            disabled={!clickable}
                            onClick={() => {
                              if (!match) return
                              // On branch views, chips are select-only — the auto-select effect
                              // would immediately re-pick an affected item, making a "deselect"
                              // toggle feel broken. Clicking the selected chip on a branch view
                              // is a no-op.
                              if (isSelected && selectedBranch !== 'base') return
                              setFilters({ globalItem: isSelected ? '' : match.item_id })
                            }}
                            className={`rounded-full border px-2.5 py-1 text-left text-[11px] font-semibold transition-colors ${
                              isSelected
                                ? 'border-majorelle-blue-500 bg-majorelle-blue-500 text-white'
                                : clickable
                                  ? 'border-charcoal-blue-300 bg-white text-charcoal-blue-700 hover:border-majorelle-blue-400 hover:bg-majorelle-blue-50 cursor-pointer'
                                  : 'border-charcoal-blue-200 bg-charcoal-blue-50 text-charcoal-blue-400 cursor-default'
                            }`}
                            title={label}
                          >
                            <span className="font-mono">{chip.code}</span>
                            {label && label !== chip.code && (
                              <span className={`ml-1.5 font-normal ${isSelected ? 'text-white/90' : 'text-charcoal-blue-500'}`}>{label}</span>
                            )}
                          </button>
                        )
                      })}
                </div>
              </div>
            )}

            <div className="mb-5 grid gap-4 grid-cols-1 lg:grid-cols-2">

              {/* Chart 1 — POS Store Sales */}
              {(() => {
                // Merge simulated posData with rolling forecast data for unrun weeks
                const forecastByWeek = new Map(rollingForecastData.map(r => [r.week, r.forecast_qty]))
                // Aggregate branch planner forecast rows by week, restricted to affected items.
                // Reactive uses planner_forecast (dampened, from branch_forecast table).
                // Adaptive reuses main-line's demand directly (see mergedPosData below) — no
                // aggregation needed here; leaving the map empty for adaptive.
                // Honor the Item filter (globalItem = item_id) so future-demand bars scope match
                // the historical bars — otherwise picking one affected item shows one item's history
                // vs the sum of ALL affected items' future demand.
                const branchForecastByWeek = new Map<string, number>()
                // Clip the reactive tail to the parent run's end_week: the engine's branch/forecast
                // horizon extends a full year past the stockout, but the demo should stay within the
                // user's original simulation window.
                const runEndIsoWeek = runEndWeek ? toIsoWeek(runEndWeek) : null
                // Build item metadata lookup once so we can filter branch_forecast rows by
                // category / subcategory / brand — none of which are on the row itself.
                const itemsMetaById = new Map<string, any>((meta?.items_meta ?? []).map((m: any) => [m.item_id, m]))
                if (selectedBranch !== 'adaptive') {
                  for (const r of branchForecastRows) {
                    if (affectedItemCodes && !affectedItemCodes.has(r.item_code)) continue
                    if (globalItem && r.item_id !== globalItem) continue
                    if (globalStore && r.store_id !== globalStore) continue
                    if (globalCategory || globalSubcategory || globalBrand) {
                      const im = itemsMetaById.get(r.item_id)
                      if (!im) continue
                      if (globalCategory && im.category !== globalCategory) continue
                      if (globalSubcategory && im.subcategory !== globalSubcategory) continue
                      if (globalBrand && im.brand !== globalBrand) continue
                    }
                    if (!r.forecast_week) continue
                    // Backend already returns ISO week ("2025-W29"); only pass through toIsoWeek for YYYY-MM-DD.
                    const w = /^\d{4}-W\d{2}$/.test(r.forecast_week) ? r.forecast_week : toIsoWeek(r.forecast_week)
                    if (!w || w.includes('NaN')) continue
                    if (runEndIsoWeek && w > runEndIsoWeek) continue
                    branchForecastByWeek.set(w, (branchForecastByWeek.get(w) ?? 0) + (r.planner_forecast ?? 0))
                  }
                }
                // Branch-view sourcing:
                //  • Pre-anchor weeks always come from the PARENT's posData so we keep the
                //    main-line historical context to the left of Forecast Start (even after
                //    the branch has run, when analyticsSimId → child and posData covers
                //    post-anchor weeks only).
                //  • Post-anchor weeks come from posData (which is the branch child once
                //    COMPLETED, or the parent's projection while still unrun) so they show
                //    the branch's own realized sales/stockouts.
                const branchIsCompleted = selectedBranchRun?.simulation_status === 'COMPLETED'
                const useMergedSources = selectedBranch !== 'base' && branchIsCompleted && parentPosData.length > 0 && !!stockoutEndWeek
                const parentByWeek = new Map(parentPosData.map((d: any) => [d.week, d]))
                const branchByWeek = new Map(posData.map((d: any) => [d.week, d]))
                const allWeeks = useMergedSources
                  ? [...new Set([...parentByWeek.keys(), ...branchByWeek.keys()])].sort()
                  : posData.map((d: any) => d.week)
                const mergedPosData = allWeeks.map(week => {
                  const pre = parentByWeek.get(week)
                  const post = branchByWeek.get(week)
                  const isAfterAnchor = !!stockoutEndWeek && week > stockoutEndWeek
                  // Pick the authoritative row for THIS week:
                  //  • merged branch view: pre-anchor → parent, post-anchor → branch
                  //  • else: original posData row
                  const src: any = useMergedSources ? (isAfterAnchor ? post ?? pre : pre ?? post) : (post ?? pre ?? { week })
                  const origForecast = src.run_type === 'rolling_chunk' ? rollingForecastSnapshot.get(week) : undefined
                  const baseForecast = src.run_type === 'base' ? baseForecastMap.get(week) : undefined
                  // Legacy pre-run behavior: cut historical bars past anchor when branch hasn't run.
                  const legacyCut = !useMergedSources && showBranchForecastTail && stockoutEndWeek && week > stockoutEndWeek
                  // On branch views POST-anchor, the purple "Demand" bar represents the
                  // planner FORECAST (dampened for Reactive, baseline for Adaptive) — the
                  // number the planner ordered against. Raw actual demand moves to the
                  // tooltip as "Actual Demand". Pre-anchor and Main-line: unchanged.
                  const onBranchView = selectedBranch !== 'base'
                  const isPlannerBar = onBranchView && isAfterAnchor
                  const plannerValue = selectedBranch === 'adaptive'
                    ? (pre?.demand_qty ?? src.demand_qty ?? null)
                    : (branchForecastByWeek.get(week) ?? null)
                  return {
                    ...src,
                    week,
                    forecast_qty: forecastByWeek.get(week),
                    original_forecast_qty: origForecast,
                    base_forecast_qty: baseForecast,
                    primary_demand_qty: legacyCut
                      ? null
                      : isPlannerBar
                        ? plannerValue
                        : (origForecast ?? baseForecast ?? src.demand_qty),
                    sales_qty: legacyCut ? null : src.sales_qty,
                    stockout_qty: legacyCut ? null : src.stockout_qty,
                    // Raw actual demand preserved for tooltip (labeled "Actual Demand"
                    // when it diverges from the planner forecast shown as the purple bar).
                    // Only expose actual demand when the branch child has actually run.
                    // On pre-run compare views, src falls back to the parent's row, so
                    // src.demand_qty would leak the parent's demand as "branch actual".
                    actual_demand_qty: isAfterAnchor && onBranchView && branchIsCompleted
                      ? (post?.demand_qty ?? null)
                      : null,
                    // Cyan branch forecast overlay is redundant now that the purple bar
                    // shows planner forecast post-anchor. Keep it only for the pre-run
                    // legacy path (when we can't put values into primary_demand_qty).
                    branch_forecast_qty: legacyCut && isAfterAnchor && onBranchView
                      ? plannerValue
                      : null,
                  }
                })
                const forecastOnlyWeeks = rollingForecastData
                  .filter(r => !posData.some(d => d.week === r.week))
                  .map(r => ({ week: r.week, demand_qty: 0, sales_qty: 0, stockout_qty: 0, sales_amount: 0, is_promo_week: 0, promo_name: '', forecast_qty: r.forecast_qty, branch_forecast_qty: null }))
                // Extend branch forecast tail past the last posData week (mirrors forecastOnlyWeeks above).
                const posWeeks = new Set(posData.map(d => d.week))
                const forecastOnlyWeeksAlready = new Set(forecastOnlyWeeks.map(r => r.week))
                const branchForecastOnlyWeeks = showBranchForecastTail
                  ? [...branchForecastByWeek.entries()]
                      .filter(([w]) => !posWeeks.has(w) && !forecastOnlyWeeksAlready.has(w) && !!stockoutEndWeek && w > stockoutEndWeek)
                      .map(([w, v]) => ({
                        week: w, demand_qty: 0, sales_qty: 0, stockout_qty: 0, sales_amount: 0,
                        is_promo_week: 0, promo_name: '', forecast_qty: null,
                        // Purple planner-forecast bar (post-anchor synthetic rows). No cyan overlay.
                        primary_demand_qty: v,
                        actual_demand_qty: null,
                        branch_forecast_qty: null,
                      }))
                  : []
                const combinedPosData = [...mergedPosData, ...forecastOnlyWeeks, ...branchForecastOnlyWeeks].sort((a, b) => a.week.localeCompare(b.week))

                return (
                  <ChartShell
                    title="POS — Store Sales"
                    subtitle="Weekly demand, sales and lost sales across all stores"
                    error={posError} loading={posLoading || (selectedBranch !== 'base' && parentPosLoading)}
                    isZoomed={zoom1.isZoomed} onZoomReset={zoom1.resetZoom}
                    chart={(h) => (
                      <ResponsiveContainer width="100%" height={h}>
                        <ComposedChart data={zoom1.isZoomed ? zoom1.displayData : combinedPosData} margin={{ top: 5, right: 20, left: 0, bottom: 20 }} barCategoryGap="4%" barGap={2}
                          onMouseDown={zoom1.onMouseDown} onMouseMove={zoom1.onMouseMove} onMouseUp={zoom1.onMouseUp}
                          style={{ cursor: zoom1.isZoomed ? 'grab' : 'crosshair', outline: 'none' }}>
                          {combinedPosData.filter(d => d.is_promo_week).map(d => (
                            <ReferenceArea
                              key={d.week} x1={d.week} x2={d.week}
                              fill={extensionStartWeek && d.week >= extensionStartWeek ? '#f59e0b' : '#8b5cf6'}
                              fillOpacity={0.12} stroke="none"
                            />
                          ))}
                          {zoom1.selectionArea()}
                          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                          <XAxis dataKey="week" {...xAxisProps} />
                          <YAxis tickFormatter={yAxisTickFormatter} />
                          <Tooltip content={<POSTooltip hideActual={selectedBranch !== 'base' && !branchIsCompleted} promoWeekMap={Object.fromEntries(posData.filter(d => d.is_promo_week).map(d => [d.week, { name: d.promo_name, groupName: d.promo_group_name }]))} />} />
                          <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                          <Bar dataKey="primary_demand_qty" fill="#8b5cf6" name="Demand" barSize={10}>
                            {combinedPosData.map((d, i) => {
                              const rt = d.run_type
                              const fill = rt === 'rolling_chunk' ? '#a78bfa' : rt === 'extension' ? '#c4b5fd' : '#8b5cf6'
                              return <Cell key={i} fill={fill} />
                            })}
                          </Bar>
                          <Bar dataKey="sales_qty" fill="#10b981" name="Sales" barSize={10}>
                            {combinedPosData.map((d, i) => {
                              const rt = d.run_type
                              const fill = rt === 'rolling_chunk' ? '#34d399' : rt === 'extension' ? '#6ee7b7' : '#10b981'
                              return <Cell key={i} fill={fill} />
                            })}
                          </Bar>
                          <Bar dataKey="stockout_qty" fill="#ef4444" name="Lost Sales" barSize={10}>
                            {combinedPosData.map((d, i) => {
                              const rt = d.run_type
                              const fill = rt === 'rolling_chunk' ? '#f87171' : rt === 'extension' ? '#fca5a5' : '#ef4444'
                              return <Cell key={i} fill={fill} />
                            })}
                          </Bar>
                          {rollingForecastData.length > 0 && (
                            <Bar dataKey="forecast_qty" fill="#06b6d4" fillOpacity={0.45} name="Future Demand" barSize={10} />
                          )}
                          {showBranchForecastTail && branchTailColor && selectedBranchRun?.simulation_status !== 'COMPLETED' && (
                            <Bar dataKey="branch_forecast_qty" fill={branchTailColor} fillOpacity={0.45} name="Future Demand" barSize={10} />
                          )}
                          {extensionStartWeek && !rollingBaseStartWeek && !rollingForecastStartWeek && (
                            <ReferenceLine x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />
                          )}
                          {rollingBaseStartWeek && <ReferenceLine x={rollingBaseStartWeek} stroke="#8b5cf6" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: '#8b5cf6' }} />}
                          {rollingForecastStartWeek && rollingForecastStartWeek !== rollingBaseStartWeek && (
                            <ReferenceLine x={rollingForecastStartWeek} stroke="#7c3aed" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: `Chunk ${chunkAreas.length} End`, position: 'insideBottomRight', fontSize: 9, fill: '#7c3aed' }} />
                          )}
                          {showBranchForecastTail && stockoutEndWeek && branchTailColor && (
                            <ReferenceLine x={stockoutEndWeek} stroke={branchTailColor} strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: branchTailColor }} />
                          )}
                        </ComposedChart>
                      </ResponsiveContainer>
                    )}
                  />
                )
              })()}

              {/* Chart 2 — Store Inventory */}
              <ChartShell
                title="Store Inventory"
                subtitle="Weekly on-hand, available and on-order inventory at stores"
                error={storeInvError} loading={storeInvLoading || (selectedBranch !== 'base' && parentPosLoading)}
                isZoomed={zoom2.isZoomed} onZoomReset={zoom2.resetZoom}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={cutForBranch(zoom2.displayData)} margin={{ top: 5, right: 20, left: 0, bottom: 20 }}
                      onMouseDown={zoom2.onMouseDown} onMouseMove={zoom2.onMouseMove} onMouseUp={zoom2.onMouseUp}
                      style={{ cursor: zoom2.isZoomed ? 'grab' : 'crosshair', outline: 'none' }}>
                      {zoom2.selectionArea()}
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis tickFormatter={yAxisTickFormatter} />
                      <Tooltip content={<StoreInvTooltip />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                      <Line dataKey="available_quantity" stroke="#10b981" name="Available" type="monotone" strokeWidth={2} dot={false} />
                      <Line dataKey="on_order_quantity" stroke="#f59e0b" name="On Order" type="monotone" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                      {extensionStartWeek && !rollingBaseStartWeek && !rollingForecastStartWeek && (
                        <ReferenceLine x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />
                      )}
                      {rollingBaseStartWeek && <ReferenceLine x={rollingBaseStartWeek} stroke="#8b5cf6" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: '#8b5cf6' }} />}
                      {rollingForecastStartWeek && rollingForecastStartWeek !== rollingBaseStartWeek && (
                        <ReferenceLine x={rollingForecastStartWeek} stroke="#7c3aed" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: `Chunk ${chunkAreas.length} End`, position: 'insideBottomRight', fontSize: 9, fill: '#7c3aed' }} />
                      )}
                      {showBranchForecastTail && stockoutEndWeek && branchTailColor && (
                        <ReferenceLine x={stockoutEndWeek} stroke={branchTailColor} strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: branchTailColor }} />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              />

              {/* Chart 3 — Supply Chain Shipments */}
              <ChartShell
                title="Supply Chain Shipments"
                subtitle="Retailer DC's weekly orders to its supplier DC and what actually shipped. Fill Rate = Shipped ÷ Ordered on this leg (not manufacturer → supplier)."
                error={shipError} loading={shipLoading || (selectedBranch !== 'base' && parentPosLoading)}
                isZoomed={zoom3.isZoomed} onZoomReset={zoom3.resetZoom}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={cutForBranch(zoom3.displayData)} margin={{ top: 5, right: 40, left: 0, bottom: 20 }} barCategoryGap="4%" barGap={2}
                      onMouseDown={zoom3.onMouseDown} onMouseMove={zoom3.onMouseMove} onMouseUp={zoom3.onMouseUp}
                      style={{ cursor: zoom3.isZoomed ? 'grab' : 'crosshair', outline: 'none' }}>
                      {cutForBranch(zoom3.displayData).filter(d => d.is_promo_week).map(d => (
                        <ReferenceArea
                          key={d.week} yAxisId="left" x1={d.week} x2={d.week}
                          fill={extensionStartWeek && d.week >= extensionStartWeek ? '#f59e0b' : '#8b5cf6'}
                          fillOpacity={0.12} stroke="none"
                        />
                      ))}
                      {zoom3.selectionArea('left')}
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis yAxisId="left" tickFormatter={yAxisTickFormatter} />
                      <YAxis yAxisId="right" orientation="right" domain={[0, 1]} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                      <Tooltip content={<ChartTooltip promoWeekMap={Object.fromEntries(posData.filter(d => d.is_promo_week).map(d => [d.week, { name: d.promo_name, groupName: d.promo_group_name }]))} />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                      <Bar yAxisId="left" dataKey="ordered_qty" fill="#3b82f6" name="Ordered" barSize={10}>
                        {cutForBranch(zoom3.displayData).map((d, i) => <Cell key={i} fill={extensionStartWeek && d.week >= extensionStartWeek ? '#93c5fd' : '#3b82f6'} />)}
                      </Bar>
                      <Bar yAxisId="left" dataKey="shipped_qty" fill="#ec4899" name="Shipped" barSize={10}>
                        {cutForBranch(zoom3.displayData).map((d, i) => <Cell key={i} fill={extensionStartWeek && d.week >= extensionStartWeek ? '#f9a8d4' : '#ec4899'} />)}
                      </Bar>
                      {extensionStartWeek && !rollingBaseStartWeek && !rollingForecastStartWeek && (
                        <ReferenceLine yAxisId="left" x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />
                      )}
                      {rollingBaseStartWeek && <ReferenceLine yAxisId="left" x={rollingBaseStartWeek} stroke="#8b5cf6" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: '#8b5cf6' }} />}
                      {rollingForecastStartWeek && rollingForecastStartWeek !== rollingBaseStartWeek && (
                        <ReferenceLine yAxisId="left" x={rollingForecastStartWeek} stroke="#7c3aed" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: `Chunk ${chunkAreas.length} End`, position: 'insideBottomRight', fontSize: 9, fill: '#7c3aed' }} />
                      )}
                      {showBranchForecastTail && stockoutEndWeek && branchTailColor && (
                        <ReferenceLine yAxisId="left" x={stockoutEndWeek} stroke={branchTailColor} strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: branchTailColor }} />
                      )}
                      <Line yAxisId="right" dataKey="avg_fill_rate" stroke="#f59e0b" name="Fill Rate" type="monotone" strokeWidth={2} dot={false} />
                      <ReferenceLine yAxisId="right" y={0.95} stroke="#d1d5db" strokeDasharray="5 5" />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              />

              {/* Chart 4 — DC Inventory */}
              <ChartShell
                title="DC Inventory"
                subtitle="Weekly inventory at Retailer DCs"
                error={dcInvError} loading={dcInvLoading || (selectedBranch !== 'base' && parentPosLoading)}
                isZoomed={zoom4.isZoomed} onZoomReset={zoom4.resetZoom}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={cutForBranch(zoom4.displayData)} margin={{ top: 5, right: 20, left: 0, bottom: 20 }}
                      onMouseDown={zoom4.onMouseDown} onMouseMove={zoom4.onMouseMove} onMouseUp={zoom4.onMouseUp}
                      style={{ cursor: zoom4.isZoomed ? 'grab' : 'crosshair', outline: 'none' }}>
                      {zoom4.selectionArea()}
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis tickFormatter={yAxisTickFormatter} />
                      <Tooltip content={<DCInvTooltip />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                      <Line dataKey="dc_on_hand" stroke="#10b981" name="On Hand" type="monotone" strokeWidth={2} dot={false} />
                      <Line dataKey="dc_on_order" stroke="#f59e0b" name="On Order" type="monotone" strokeWidth={2} dot={false} strokeDasharray="4 2" />
                      {extensionStartWeek && !rollingBaseStartWeek && !rollingForecastStartWeek && (
                        <ReferenceLine x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />
                      )}
                      {rollingBaseStartWeek && <ReferenceLine x={rollingBaseStartWeek} stroke="#8b5cf6" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: '#8b5cf6' }} />}
                      {rollingForecastStartWeek && rollingForecastStartWeek !== rollingBaseStartWeek && (
                        <ReferenceLine x={rollingForecastStartWeek} stroke="#7c3aed" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: `Chunk ${chunkAreas.length} End`, position: 'insideBottomRight', fontSize: 9, fill: '#7c3aed' }} />
                      )}
                      {showBranchForecastTail && stockoutEndWeek && branchTailColor && (
                        <ReferenceLine x={stockoutEndWeek} stroke={branchTailColor} strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: branchTailColor }} />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              />

            </div>

          </>
        )}

        {activeTab === 'comparison' && (() => {
          // Merge parent's pre-anchor rows with each branch child's post-anchor rows at the anchor.
          const mergeAt = <T extends { week: string }>(child: T[], parent: T[]): T[] => {
            if (!stockoutEndWeek || parent.length === 0) return child
            const p = new Map(parent.map(d => [d.week, d]))
            const c = new Map(child.map(d => [d.week, d]))
            const weeks = [...new Set([...p.keys(), ...c.keys()])].sort()
            return weeks.map(w => (w > (stockoutEndWeek as string) ? (c.get(w) ?? p.get(w)) : (p.get(w) ?? c.get(w))) as T)
          }
          const buildCombined = (pos: any[], inv: any[]) => {
            const invByWeek = new Map(inv.map((d: any) => [d.week, d]))
            return pos.map((d: any) => ({
              ...d,
              on_hand_quantity: invByWeek.get(d.week)?.on_hand_quantity ?? null,
            }))
          }
          const rPosMerged = mergeAt(cmpReactivePos, parentPosData)
          const rInvMerged = mergeAt(cmpReactiveInv, parentStoreInvData)
          const rShipMerged = mergeAt(cmpReactiveShip, parentShipData)
          const aPosMerged = mergeAt(cmpAdaptivePos, parentPosData)
          const aInvMerged = mergeAt(cmpAdaptiveInv, parentStoreInvData)
          const aShipMerged = mergeAt(cmpAdaptiveShip, parentShipData)
          const rKpi = computeKPIs(rPosMerged, rShipMerged)
          const aKpi = computeKPIs(aPosMerged, aShipMerged)
          const rChart = buildCombined(rPosMerged, rInvMerged)
          const aChart = buildCombined(aPosMerged, aInvMerged)

          const Section = ({ title, accent, kpi, data }: { title: string; accent: string; kpi: typeof rKpi; data: any[] }) => (
            <div className="mb-4 rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${accent}`} />
                <h3 className="text-sm font-black uppercase tracking-widest text-charcoal-blue-950">{title}</h3>
              </div>
              <div className="mb-4 grid gap-3 grid-cols-2 lg:grid-cols-4">
                <KPICard label="Total Sales (units)" value={kpi.totalSales.toLocaleString()} icon={ShoppingCart} color="bg-blue-500" />
                <KPICard label="Total Revenue" value={`$${(kpi.totalRevenue / 1000).toFixed(1)}K`} icon={Package} color="bg-emerald-500" />
                <KPICard label="Avg Fill Rate" value={`${kpi.fillRate.toFixed(1)}%`} icon={Truck} color="bg-majorelle-blue-500" />
                <KPICard label="Stockout Rate" value={`${kpi.stockoutRate.toFixed(1)}%`} icon={AlertCircle} color="bg-rose-500" />
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 20 }} barCategoryGap="4%" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="week" {...xAxisProps} />
                  <YAxis yAxisId="left" tickFormatter={yAxisTickFormatter} />
                  <YAxis yAxisId="right" orientation="right" tickFormatter={yAxisTickFormatter} />
                  <Tooltip content={<POSTooltip promoWeekMap={Object.fromEntries(data.filter(d => d.is_promo_week).map(d => [d.week, { name: d.promo_name, groupName: d.promo_group_name }]))} />} />
                  <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                  <Bar yAxisId="left" dataKey="demand_qty" fill="#8b5cf6" name="Demand" barSize={8} />
                  <Bar yAxisId="left" dataKey="sales_qty" fill="#10b981" name="Sales" barSize={8} />
                  <Bar yAxisId="left" dataKey="stockout_qty" fill="#ef4444" name="Lost Sales" barSize={8} />
                  <Line yAxisId="right" dataKey="on_hand_quantity" stroke="#0891b2" name="Store On-Hand" type="monotone" strokeWidth={2} dot={false} />
                  {stockoutEndWeek && <ReferenceLine yAxisId="left" x={stockoutEndWeek} stroke="#06b6d4" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: '#06b6d4' }} />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )

          if (cmpLoading || (cmpReactivePos.length === 0 && cmpAdaptivePos.length === 0)) {
            return (
              <div className="flex items-center justify-center rounded-xl border border-charcoal-blue-200 bg-white py-24">
                <Loader2 size={20} className="animate-spin text-majorelle-blue-500" />
              </div>
            )
          }
          return (
            <div>
              <Section title="Adaptive" accent="bg-emerald-500" kpi={aKpi} data={aChart} />
              <Section title="Reactive" accent="bg-rose-500" kpi={rKpi} data={rChart} />
            </div>
          )
        })()}

      </div>
    </div>

    <RollingForecastModal
      open={showRollingModal}
      onClose={() => setShowRollingModal(false)}
      baseSimulationId={simulationId}
      retailerAccountId={params.retailerAccountId as string}
      baseSeed={baseSeed}
      baseEndDate={runEndWeek}
      existingSession={rollingSession}
      onSessionUpdated={(s) => {
        setRollingSession(s)
        if (!s || s.status !== 'active') setRollingForecastData([])
      }}
      onDemandReady={(promos) => { setRollingPromos(promos); refreshRollingForecast() }}
    />

    {rollingSession && (
      <RunChunkModal
        open={showRunChunkModal}
        onClose={() => setShowRunChunkModal(false)}
        session={rollingSession}
        baseEndDate={runEndWeek}
        onChunkComplete={(result) => {
          const updatedSession: RollingForecastSession = {
            ...rollingSession,
            current_completed_week: result.rolling_session?.current_completed_week ?? rollingSession.current_completed_week,
            status: result.rolling_session?.session_status as any ?? 'active',
          }
          setRollingSession(updatedSession)
          // refreshRollingForecast internally re-fetches getSummaryStoreSales (posData) when chunks exist.
          // Do NOT also call loadSummary() here — the concurrent fetch would race and may overwrite
          // rolling_chunk-typed rows with stale base-only data, causing chunk weeks to vanish from charts.
          refreshRollingForecast()
        }}
      />
    )}

    {/* YAML config modal */}
    {yamlModalOpen && (() => {
      const fc = runFullConfig as any
      const displayYaml = fc ? (() => {
        const run: Record<string, unknown> = {
          simulation_name: fc.simulation_name,
          start_date: fc.start_date,
          end_date: fc.end_date,
          store_target_wos: fc.store_target_wos,
          store_initial_wos: fc.store_initial_wos,
          retailer_dc_target_wos: fc.retailer_dc_target_wos,
          retailer_dc_initial_wos: fc.retailer_dc_initial_wos,
          supplier_dc_initial_wos: fc.supplier_dc_initial_wos,
          retailer_dc_to_store_lead_weeks: fc.retailer_dc_to_store_lead_weeks,
          supplier_dc_to_retailer_dc_lead_weeks: fc.supplier_dc_to_retailer_dc_lead_weeks,
          dc_otd_rate: fc.dc_otd_rate,
          dc_in_full_rate: fc.dc_in_full_rate,
          supplier_otd_rate: fc.supplier_otd_rate,
          supplier_in_full_rate: fc.supplier_in_full_rate,
        }
        for (const f of [
          'retailer_dc_initial_wos_by_dc', 'retailer_dc_target_wos_by_dc',
          'supplier_dc_initial_wos_by_supplier',
          'retailer_dc_to_store_lead_weeks_by_dc',
          'supplier_dc_to_retailer_dc_lead_weeks_by_supplier',
          'dc_otd_rate_by_dc', 'dc_in_full_rate_by_dc',
          'supplier_otd_rate_by_supplier', 'supplier_in_full_rate_by_supplier',
        ]) {
          const v = fc[f]
          if (v && typeof v === 'object' && Object.keys(v).length > 0) run[f] = v
        }
        return yaml.dump({ run })
      })() : ''
      const promoEntries: any[] = (() => {
        try {
          const raw = fc?.promo_yaml
          if (!raw) return []
          const parsed = yaml.load(raw) as any
          return parsed?.promos ?? []
        } catch { return [] }
      })()
      return (
        <ChartModal
          title="Run YAML Config"
          subtitle={simName}
          error=""
          filters={
            <button
              onClick={() => navigator.clipboard.writeText(displayYaml)}
              className="rounded-full border border-charcoal-blue-200 px-2 py-1 text-xs font-semibold text-charcoal-blue-500 hover:bg-charcoal-blue-50"
            >Copy</button>
          }
          onClose={() => setYamlModalOpen(false)}
        >
          <pre className="rounded-lg bg-charcoal-blue-50 p-4 font-mono text-xs text-charcoal-blue-900 whitespace-pre-wrap">
            {displayYaml || 'No config available'}
          </pre>
          {promoEntries.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-charcoal-blue-500">Promotions</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-charcoal-blue-100 text-left text-[10px] font-semibold text-charcoal-blue-500">
                    <th className="pb-1 pr-4">Name</th><th className="pb-1 pr-4">Start</th>
                    <th className="pb-1 pr-4">End</th><th className="pb-1">Multiplier</th>
                  </tr>
                </thead>
                <tbody>
                  {promoEntries.map((p: any, i: number) => (
                    <tr key={i} className="border-b border-charcoal-blue-50">
                      <td className="py-1 pr-4 font-medium text-charcoal-blue-900">{p.promo_name}</td>
                      <td className="py-1 pr-4 text-charcoal-blue-600">{p.start_date}</td>
                      <td className="py-1 pr-4 text-charcoal-blue-600">{p.end_date}</td>
                      <td className="py-1 text-charcoal-blue-600">{p.demand_multiplier ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ChartModal>
      )
    })()}

    {compareModalOpen && (() => {
      const startCompare = async () => {
        setCompareLoading(true); setCompareError('')
        try {
          const codes = affectedItemCodes ? [...affectedItemCodes] : undefined
          const res = await generateBranchForecasts(simulationId, codes)
          const rows = await getBranchForecast(res.reactive.simulation_id).catch(() => [] as BranchForecastRow[])
          setBranchPreview({ reactive: res.reactive, adaptive: res.adaptive, rows })
          const retId = params.retailerAccountId as string
          const rs = await getRuns(retId, '').catch(() => [])
          setAllRuns(rs)
          setCompareModalOpen(false)
        } catch (e: any) {
          setCompareError(e?.message ?? 'Failed to generate branch forecasts')
        } finally {
          setCompareLoading(false)
        }
      }

      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={() => !compareLoading && setCompareModalOpen(false)}>
          <div className="w-full max-w-md rounded-xl border border-charcoal-blue-200 bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="p-5">
              <h3 className="text-sm font-bold text-charcoal-blue-950">Start Compare</h3>
              <p className="mt-1 text-xs text-charcoal-blue-500">
                Generate the Reactive and Adaptive planner forecasts for this run. You&apos;ll then be able to switch between them and see their future demand on the POS chart, and run the branch simulations from the toolbar.
              </p>
              {compareError && <div className="mt-3"><ChartError message={compareError} /></div>}
              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  onClick={() => setCompareModalOpen(false)}
                  disabled={compareLoading}
                  className="rounded-xl border border-charcoal-blue-200 px-4 py-2 text-xs font-semibold text-charcoal-blue-600 hover:bg-charcoal-blue-50 disabled:opacity-50"
                >Cancel</button>
                <button
                  onClick={startCompare}
                  disabled={compareLoading}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white hover:bg-majorelle-blue-600 disabled:opacity-60"
                >
                  {compareLoading ? <Loader2 size={13} className="animate-spin" /> : <ChevronRight size={13} />}
                  Start Compare
                </button>
              </div>
            </div>
          </div>
        </div>
      )
    })()}
    </>
  )
}
