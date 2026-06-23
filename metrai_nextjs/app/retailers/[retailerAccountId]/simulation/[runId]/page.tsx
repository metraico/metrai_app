'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Download, Package, Truck, ShoppingCart, AlertCircle, Loader2, ChevronLeft, ChevronRight, History, ChevronDown, FileCode } from 'lucide-react'
import * as yaml from 'js-yaml'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea, Cell,
} from 'recharts'
import {
  getAnalyticsMeta,
  getStoreSales, getStoreInventory, getSupplierSales, getDCInventory,
  getSummaryStoreSales, getSummaryStoreInventory, getSummarySupplyChainSales, getSummaryUpstreamInventory,
} from '@/lib/api/analytics'
import { getRunConfig, getSimulationExtensions, getAnalyticsStatus, getSimulationExportUrl, getRollingSession, getDemandWeeklyTotals } from '@/lib/api/simulation'
import { ExtendForecastModal } from './extend-modal'
import { RollingForecastModal } from './rolling-forecast-modal'
import { RunChunkModal } from './run-chunk-modal'
import { useSimulationStore } from '@/lib/store/simulationStore'
import { useFilterStore } from '@/lib/store/filterStore'
import type { AnalyticsMeta, SimulationSummary, SimulationExtensionRecord, RollingForecastSession } from '@/lib/api/types'
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

function aggDCInv(dc: any[], sup: any[]) {
  const dcOnHand   = new Map<string, number>()
  const dcOnOrder  = new Map<string, number>()
  const supOnHand  = new Map<string, number>()
  const supOnOrder = new Map<string, number>()
  for (const r of dc) {
    const w = r.inventory_week
    dcOnHand.set(w,  (dcOnHand.get(w)  ?? 0) + Number(r.on_hand_quantity))
    dcOnOrder.set(w, (dcOnOrder.get(w) ?? 0) + Number(r.on_order_quantity ?? 0))
  }
  for (const r of sup) {
    const w = r.inventory_week
    supOnHand.set(w,  (supOnHand.get(w)  ?? 0) + Number(r.on_hand_quantity))
    supOnOrder.set(w, (supOnOrder.get(w) ?? 0) + Number(r.on_order_quantity ?? 0))
  }
  const weeks = [...new Set([...dcOnHand.keys(), ...supOnHand.keys()])].sort()
  return weeks.map(w => ({
    week: w,
    dc_inventory:          dcOnHand.get(w)   ?? 0,
    dc_on_order:           dcOnOrder.get(w)  ?? 0,
    supplier_dc_inventory: supOnHand.get(w)  ?? 0,
    supplier_dc_on_order:  supOnOrder.get(w) ?? 0,
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
      <p className="mb-1 font-semibold text-charcoal-blue-700">{label}</p>
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

function POSTooltip({ active, payload, label, promoWeekMap }: {
  active?: boolean; payload?: any[]; label?: string
  promoWeekMap?: Record<string, { name: string; groupName: string }>
}) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload ?? {}
  const promoGroupName = d.promo_group_name || promoWeekMap?.[label ?? '']?.groupName || ''
  const promoName = d.promo_name || promoWeekMap?.[label ?? '']?.name || ''
  const promoLabel = promoGroupName || promoName || 'Promo week'
  const isPromo = d.is_promo_week || (promoWeekMap && label && promoWeekMap[label])
  const demand = Number(d.demand_qty ?? 0)
  const sales = Number(d.sales_qty ?? 0)
  const lost = Number(d.stockout_qty ?? 0)
  const revenue = Number(d.sales_amount ?? 0)
  const forecast = d.forecast_qty != null ? Number(d.forecast_qty) : null
  const runType = d.run_type
  const runLabel = runType === 'rolling_chunk' ? 'Rolling Chunk' : runType === 'extension' ? 'Extension' : null
  const isFutureOnly = demand === 0 && forecast != null

  return (
    <div className="rounded-lg border border-charcoal-blue-200 bg-white px-3 py-2 shadow-md text-xs min-w-[180px]">
      {isPromo && (
        <div className="mb-2 flex items-center gap-1.5 rounded-md bg-violet-50 px-2 py-1">
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-violet-500" />
          <span className="font-semibold text-violet-700 truncate">Promo: {promoLabel}</span>
        </div>
      )}
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <p className="font-semibold text-charcoal-blue-700">{label}</p>
        {runLabel && <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600">{runLabel}</span>}
      </div>
      {!isFutureOnly && (
        <>
          <div className="mb-1.5 space-y-0.5">
            <p className="flex justify-between gap-4 text-violet-700"><span>Demand</span><span className="font-medium">{demand.toLocaleString()}</span></p>
            <p className="flex justify-between gap-4 text-emerald-700"><span>Sales</span><span className="font-medium">{sales.toLocaleString()}</span></p>
            <p className="flex justify-between gap-4 text-red-600"><span>Lost Sales</span><span className="font-medium">{lost.toLocaleString()}</span></p>
          </div>
        </>
      )}
      {forecast != null && (
        <div className={`${!isFutureOnly ? 'border-t border-charcoal-blue-100 pt-1.5 mt-1' : ''}`}>
          <p className="flex justify-between gap-4 text-cyan-600"><span>Future Demand</span><span className="font-medium">{forecast.toLocaleString()}</span></p>
        </div>
      )}
    </div>
  )
}

function DCInvTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload ?? {}
  const rdcOnHand  = d.dc_inventory          ?? 0
  const rdcOnOrder = d.dc_on_order           ?? 0
  const sdcOnHand  = d.supplier_dc_inventory ?? 0
  const sdcOnOrder = d.supplier_dc_on_order  ?? 0
  const rdcStatus  = rdcOnHand === 0 && rdcOnOrder > 0 ? 'in-transit' : rdcOnHand === 0 ? 'stockout' : null
  const sdcStatus  = sdcOnHand === 0 && sdcOnOrder > 0 ? 'in-transit' : sdcOnHand === 0 ? 'stockout' : null
  return (
    <div className="rounded-lg border border-charcoal-blue-200 bg-white px-3 py-2 shadow-md text-xs min-w-[190px]">
      <p className="mb-2 font-semibold text-charcoal-blue-700">{label}</p>
      <div className="mb-1.5">
        <p className="font-semibold text-indigo-600 mb-0.5">Retailer DC</p>
        <p className="flex justify-between gap-4 text-charcoal-blue-700">
          <span>On Hand</span><span className="font-medium">{rdcOnHand.toLocaleString()}</span>
        </p>
        <p className="flex justify-between gap-4 text-charcoal-blue-500">
          <span>On Order</span><span className="font-medium">{rdcOnOrder.toLocaleString()}</span>
        </p>
        {rdcStatus === 'stockout'   && <p className="mt-0.5 text-red-500 font-semibold">⚠ Stockout — nothing on order</p>}
        {rdcStatus === 'in-transit' && <p className="mt-0.5 text-amber-500 font-semibold">↑ Stockout — replenishment incoming</p>}
      </div>
      {(sdcOnHand > 0 || sdcOnOrder > 0) && (
        <div className="border-t border-charcoal-blue-100 pt-1.5">
          <p className="font-semibold text-rose-500 mb-0.5">Supplier DC</p>
          <p className="flex justify-between gap-4 text-charcoal-blue-700">
            <span>On Hand</span><span className="font-medium">{sdcOnHand.toLocaleString()}</span>
          </p>
          <p className="flex justify-between gap-4 text-charcoal-blue-500">
            <span>On Order</span><span className="font-medium">{sdcOnOrder.toLocaleString()}</span>
          </p>
          {sdcStatus === 'stockout'   && <p className="mt-0.5 text-red-500 font-semibold">⚠ Stockout — nothing on order</p>}
          {sdcStatus === 'in-transit' && <p className="mt-0.5 text-amber-500 font-semibold">↑ Stockout — replenishment incoming</p>}
        </div>
      )}
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
      <p className="mb-1.5 font-semibold text-charcoal-blue-700">{label}</p>
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

  const { setOptions, clearOptions, globalItem, globalStore, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand } = useFilterStore()

  const [pageState, setPageState] = useState<PageState>('loading')
  const [pageError, setPageError] = useState('')
  const [simName, setSimName] = useState('Simulation Results')
  const [showExtendModal, setShowExtendModal] = useState(false)
  const [showRollingModal, setShowRollingModal] = useState(false)
  const [showRunChunkModal, setShowRunChunkModal] = useState(false)
  const [rollingSession, setRollingSession] = useState<RollingForecastSession | null>(null)
  const [rollingForecastData, setRollingForecastData] = useState<{ week: string; forecast_qty: number }[]>([])
  const [rollingPromos, setRollingPromos] = useState<{ promo_group_name: string; promo_name: string; start_date: string; end_date: string; demand_multiplier: number }[]>([])
  const [extensions, setExtensions] = useState<SimulationExtensionRecord[]>([])
  const extensionStartWeek = extensions.length > 0 ? toIsoWeek(extensions[0].previous_end_week) : null
  const [showExtensionHistory, setShowExtensionHistory] = useState(false)
  const [runFullConfig, setRunFullConfig] = useState<Record<string, unknown> | null>(null)
  const [runEndWeek, setRunEndWeek] = useState<string>('')
  const [yamlModalOpen, setYamlModalOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('dashboard')
  const [narrativeStep, setNarrativeStep] = useState(0)
  const [meta, setMeta] = useState<AnalyticsMeta | null>(null)
  const [analyticsStatus, setAnalyticsStatus] = useState<'PENDING' | 'READY' | 'FAILED' | null>(null)
  const [analyticsReadyVisible, setAnalyticsReadyVisible] = useState(true)
  const bannerDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Chart 1 — POS (store sales)
  const [posData, setPosData] = useState<any[]>([])
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
  const [dcViewMode, setDcViewMode] = useState<'both' | 'rdc_only'>('both')

  const [combinedPosDataForZoom, setCombinedPosDataForZoom] = useState<any[]>([])
  const zoom1 = useChartZoom(combinedPosDataForZoom)
  const zoom2 = useChartZoom(storeInvData)
  const zoom3 = useChartZoom(shipData)
  const zoom4 = useChartZoom(dcInvData)

  // Keep zoom1 data in sync with posData + rollingForecastData so zoom covers future weeks too
  useEffect(() => {
    const forecastByWeek = new Map(rollingForecastData.map(r => [r.week, r.forecast_qty]))
    const merged = posData.map(d => ({ ...d, forecast_qty: forecastByWeek.get(d.week) }))
    const forecastOnly = rollingForecastData
      .filter(r => !posData.some(d => d.week === r.week))
      .map(r => ({ week: r.week, demand_qty: 0, sales_qty: 0, stockout_qty: 0, sales_amount: 0, is_promo_week: 0, promo_name: '', forecast_qty: r.forecast_qty }))
    setCombinedPosDataForZoom([...merged, ...forecastOnly].sort((a, b) => a.week.localeCompare(b.week)))
  }, [posData, rollingForecastData])

  const [kpis, setKpis] = useState({ totalSales: 0, totalRevenue: 0, fillRate: 0, stockoutRate: 0 })

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
  }, [simulationId, cache, applySummary])

  // ── Load extension history once simulation is ready ──────────────────────
  useEffect(() => {
    if (pageState !== 'ready') return
    getSimulationExtensions(simulationId).then(setExtensions).catch(() => null)
  }, [pageState, simulationId])

  // ── Load rolling forecast session and unrun forecast demand ───────────────
  const baseSeed: number = (runFullConfig as any)?.random_seed ?? 42

  const refreshRollingForecast = useCallback(async () => {
    if (!runEndWeek) return
    try {
      const session = await getRollingSession(simulationId)
      setRollingSession(session)
      // If chunks have run, the cache is stale — re-fetch posData from backend with current filters
      if (session.chunks && session.chunks.length > 0) {
        const activeFilters = {
          item_id: globalItem || undefined,
          store_id: globalStore || undefined,
          category: globalCategory || undefined,
          subcategory: globalSubcategory || undefined,
          brand: globalBrand || undefined,
        }
        getSummaryStoreSales(simulationId, activeFilters)
          .then(s => setPosData(aggPOS(s.weekly_pos ?? [])))
          .catch(() => null)
      }
      if (session.status === 'active') {
        const startWeek = session.current_completed_week
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
        getDemandWeeklyTotals(session.retailer_account_id, startWeek, endWeek, seed, filters)
          .then(rows => setRollingForecastData(rows.map(r => ({ week: r.pos_week, forecast_qty: r.demand_qty }))))
          .catch(() => null)
      } else {
        setRollingForecastData([])
      }
    } catch {
      // 404 = no active session, that's fine
    }
  }, [simulationId, runEndWeek, runFullConfig,
      globalItem, globalStore, globalCategory, globalSubcategory, globalBrand])

  useEffect(() => {
    if (pageState !== 'ready' || !runEndWeek) return
    refreshRollingForecast()
  }, [pageState, refreshRollingForecast, runEndWeek])

  // ── Filtered fetch handlers ───────────────────────────────────────────────

  const fetchPOSFiltered = useCallback(async (itemId: string, storeId: string, category: string, subcategory: string, brand: string) => {
    setPosLoading(true); setPosError('')
    try {
      const p = { item_id: itemId || undefined, store_id: storeId || undefined, category: category || undefined, subcategory: subcategory || undefined, brand: brand || undefined }
      const data = await getStoreSales(simulationId, p)
      setPosData(aggPOS(data.weekly_pos ?? []))
    } catch (e: any) { setPosError(e?.message ?? 'Failed') }
    finally { setPosLoading(false) }
  }, [simulationId])

  const fetchStoreInvFiltered = useCallback(async (itemId: string, storeId: string, category: string, subcategory: string, brand: string) => {
    setStoreInvLoading(true); setStoreInvError('')
    try {
      const p = { item_id: itemId || undefined, store_id: storeId || undefined, category: category || undefined, subcategory: subcategory || undefined, brand: brand || undefined }
      const data = await getStoreInventory(simulationId, p)
      setStoreInvData(aggStoreInv(data.store_inventory ?? []))
    } catch (e: any) { setStoreInvError(e?.message ?? 'Failed') }
    finally { setStoreInvLoading(false) }
  }, [simulationId])

  const fetchShipFiltered = useCallback(async (itemId: string, sdcId: string, rdcId: string, category: string, subcategory: string, brand: string) => {
    setShipLoading(true); setShipError('')
    try {
      const data = await getSupplierSales(simulationId, {
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
  }, [simulationId])

  const fetchDCInvFiltered = useCallback(async (itemId: string, rdcId: string, sdcId: string, category: string, subcategory: string, brand: string) => {
    setDcInvLoading(true); setDcInvError('')
    try {
      const data = await getDCInventory(simulationId, {
        item_id:        itemId || undefined,
        dc_id:          rdcId  || undefined,
        supplier_dc_id: sdcId  || undefined,
        category:       category  || undefined,
        subcategory:    subcategory || undefined,
        brand:          brand    || undefined,
      })
      setDcInvData(aggDCInv(data.dc_inventory ?? [], data.supplier_dc_inventory ?? []))
    } catch (e: any) { setDcInvError(e?.message ?? 'Failed') }
    finally { setDcInvLoading(false) }
  }, [simulationId])

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalItem, globalStore, globalSdc, globalRdc, globalCategory, globalSubcategory, globalBrand])

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

  // Auto-hide the READY banner after 5s
  useEffect(() => {
    if (analyticsStatus === 'READY') {
      bannerDismissRef.current = setTimeout(() => setAnalyticsReadyVisible(false), 5_000)
    }
    return () => { if (bannerDismissRef.current) clearTimeout(bannerDismissRef.current) }
  }, [analyticsStatus])

  // When analytics becomes READY, reload all 4 charts from ClickHouse
  useEffect(() => {
    if (analyticsStatus !== 'READY') return
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
            {/* Extension history toggle */}
            {extensions.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={() => setShowExtensionHistory(v => !v)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-majorelle-blue-500 hover:text-majorelle-blue-700"
                >
                  <History size={12} />
                  Extension History ({extensions.length})
                  <ChevronDown size={12} className={`transition-transform duration-150 ${showExtensionHistory ? 'rotate-180' : ''}`} />
                </button>
                {showExtensionHistory && (
                  <div className="mt-2 space-y-1.5">
                    {extensions.map(ext => (
                      <div key={ext.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-charcoal-blue-100 bg-charcoal-blue-50 px-3 py-2 text-xs">
                        <span className="font-bold text-charcoal-blue-400">#{ext.extension_number}</span>
                        <span className="font-mono font-semibold text-charcoal-blue-700">{ext.previous_end_week} → {ext.new_end_week}</span>
                        {ext.scenario_type !== 'no_scenario' && (
                          <span className="rounded-full border border-majorelle-blue-200 bg-majorelle-blue-50 px-2 py-0.5 text-[10px] font-bold text-majorelle-blue-600">
                            {ext.scenario_name || ext.scenario_type}
                          </span>
                        )}
                        <span className="ml-auto text-[10px] text-charcoal-blue-400">
                          {new Date(ext.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {pageState === 'ready' && (
              <button
                onClick={() => setShowExtendModal(true)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-majorelle-blue-400 px-4 py-2 text-xs font-bold text-majorelle-blue-600 transition-all hover:bg-majorelle-blue-50"
              >
                <ChevronRight size={13} /> Extend Forecast
              </button>
            )}
            {pageState === 'ready' && !rollingSession && (
              <button
                onClick={() => setShowRollingModal(true)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-amber-400 px-4 py-2 text-xs font-bold text-amber-600 transition-all hover:bg-amber-50"
              >
                <ChevronRight size={13} /> Rolling Forecast
              </button>
            )}
            {pageState === 'ready' && rollingSession?.status === 'active' && (
              <button
                onClick={() => setShowRollingModal(true)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-amber-400 px-4 py-2 text-xs font-bold text-amber-600 transition-all hover:bg-amber-50"
              >
                <ChevronRight size={13} /> Edit Setup
              </button>
            )}
            {pageState === 'ready' && rollingSession?.status === 'active' && rollingForecastData.length > 0 && (
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
          {['dashboard', 'narrative'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-3 py-2 text-xs font-semibold transition-all border-b-2 capitalize ${
                activeTab === tab
                  ? 'border-majorelle-blue-500 text-majorelle-blue-600'
                  : 'border-transparent text-charcoal-blue-400 hover:text-charcoal-blue-950'
              }`}
            >
              {tab === 'dashboard' ? 'Data Dashboard' : 'Guided Narrative'}
            </button>
          ))}
        </div>

        {activeTab === 'dashboard' && (
          <>
            {/* KPIs */}
            <div className="mb-5 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <KPICard label="Total Sales (units)" value={kpis.totalSales.toLocaleString()} icon={ShoppingCart} color="bg-blue-500" />
              <KPICard label="Total Revenue" value={`$${(kpis.totalRevenue / 1000).toFixed(1)}K`} icon={Package} color="bg-emerald-500" />
              <KPICard label="Avg Fill Rate" value={`${kpis.fillRate.toFixed(1)}%`} icon={Truck} color="bg-majorelle-blue-500" />
              <KPICard label="Stockout Rate" value={`${kpis.stockoutRate.toFixed(1)}%`} icon={AlertCircle} color="bg-rose-500" />
            </div>


            <div className="mb-5 grid gap-4 grid-cols-1 lg:grid-cols-2">

              {/* Chart 1 — POS Store Sales */}
              {(() => {
                // Merge simulated posData with rolling forecast data for unrun weeks
                const forecastByWeek = new Map(rollingForecastData.map(r => [r.week, r.forecast_qty]))
                // current_completed_week is the last day of the last completed chunk (YYYY-MM-DD).
                // Adding 7 days gives the first day of the next (unrun) week — consistent with how
                // the active-session startWeek is computed at lines 534-536.
                // Forecast Start anchor — the base simulation's end-week. Sourced from the
                // FIRST chunk's start_week because simulation_config.end_week gets mutated
                // (advanced) as rolling chunks complete and so isn't a stable reference.
                const sortedChunks = (rollingSession?.chunks ?? [])
                  .slice()
                  .sort((a, b) => a.chunk_number - b.chunk_number)
                const baseSimEndDate = sortedChunks[0]?.start_week ?? runEndWeek
                const rollingBaseStartWeek = rollingSession ? toIsoWeek(baseSimEndDate) : null

                // Chunk N End marker — ISO week of the last completed chunk's end_week.
                // (Previously added +7 days to current_completed_week, which moved the label
                // 1 week past the actual chunk end.)
                const lastCompletedChunk = sortedChunks
                  .filter(c => c.status === 'completed')
                  .slice(-1)[0]
                const rollingForecastStartWeek = lastCompletedChunk
                  ? toIsoWeek(lastCompletedChunk.end_week)
                  : null
                // One shaded band per completed chunk
                const chunkAreas = (rollingSession?.chunks ?? [])
                  .filter(c => c.status === 'completed')
                  .map(c => ({ x1: toIsoWeek(c.start_week), x2: toIsoWeek(c.end_week), num: c.chunk_number }))
                const mergedPosData = posData.map(d => ({ ...d, forecast_qty: forecastByWeek.get(d.week) }))
                const forecastOnlyWeeks = rollingForecastData
                  .filter(r => !posData.some(d => d.week === r.week))
                  .map(r => ({ week: r.week, demand_qty: 0, sales_qty: 0, stockout_qty: 0, sales_amount: 0, is_promo_week: 0, promo_name: '', forecast_qty: r.forecast_qty }))
                const combinedPosData = [...mergedPosData, ...forecastOnlyWeeks].sort((a, b) => a.week.localeCompare(b.week))

                return (
                  <ChartShell
                    title="POS — Store Sales"
                    subtitle="Weekly demand, sales and lost sales across all stores"
                    error={posError} loading={posLoading}
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
                          <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                          <Tooltip content={<POSTooltip promoWeekMap={Object.fromEntries(posData.filter(d => d.is_promo_week).map(d => [d.week, { name: d.promo_name, groupName: d.promo_group_name }]))} />} />
                          <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                          <Bar dataKey="demand_qty" fill="#8b5cf6" name="Demand" barSize={10}>
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
                          {extensionStartWeek && !rollingBaseStartWeek && !rollingForecastStartWeek && (
                            <ReferenceLine x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />
                          )}
                          {rollingBaseStartWeek && <ReferenceLine x={rollingBaseStartWeek} stroke="#8b5cf6" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: 'Forecast Start', position: 'insideTopLeft', fontSize: 9, fill: '#8b5cf6' }} />}
                          {rollingForecastStartWeek && rollingForecastStartWeek !== rollingBaseStartWeek && (
                            <ReferenceLine x={rollingForecastStartWeek} stroke="#7c3aed" strokeDasharray="4 2" strokeWidth={1.5} label={{ value: `Chunk ${chunkAreas.length} End`, position: 'insideBottomRight', fontSize: 9, fill: '#7c3aed' }} />
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
                error={storeInvError} loading={storeInvLoading}
                isZoomed={zoom2.isZoomed} onZoomReset={zoom2.resetZoom}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={zoom2.displayData} margin={{ top: 5, right: 20, left: 0, bottom: 20 }}
                      onMouseDown={zoom2.onMouseDown} onMouseMove={zoom2.onMouseMove} onMouseUp={zoom2.onMouseUp}
                      style={{ cursor: zoom2.isZoomed ? 'grab' : 'crosshair', outline: 'none' }}>
                      {zoom2.selectionArea()}
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                      <Tooltip content={<StoreInvTooltip />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                      <Line dataKey="available_quantity" stroke="#10b981" name="Available" type="monotone" strokeWidth={2} dot={false} />
                      <Line dataKey="on_order_quantity" stroke="#f59e0b" name="On Order" type="monotone" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                      {extensionStartWeek && <ReferenceLine x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              />

              {/* Chart 3 — Supply Chain Shipments */}
              <ChartShell
                title="Supply Chain Shipments"
                subtitle="Supplier DC → Retailer DC ordered vs shipped and fill rate"
                error={shipError} loading={shipLoading}
                isZoomed={zoom3.isZoomed} onZoomReset={zoom3.resetZoom}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={zoom3.displayData} margin={{ top: 5, right: 40, left: 0, bottom: 20 }} barCategoryGap="4%" barGap={2}
                      onMouseDown={zoom3.onMouseDown} onMouseMove={zoom3.onMouseMove} onMouseUp={zoom3.onMouseUp}
                      style={{ cursor: zoom3.isZoomed ? 'grab' : 'crosshair', outline: 'none' }}>
                      {zoom3.displayData.filter(d => d.is_promo_week).map(d => (
                        <ReferenceArea
                          key={d.week} yAxisId="left" x1={d.week} x2={d.week}
                          fill={extensionStartWeek && d.week >= extensionStartWeek ? '#f59e0b' : '#8b5cf6'}
                          fillOpacity={0.12} stroke="none"
                        />
                      ))}
                      {zoom3.selectionArea('left')}
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis yAxisId="left" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                      <YAxis yAxisId="right" orientation="right" domain={[0, 1]} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                      <Tooltip content={<ChartTooltip promoWeekMap={Object.fromEntries(posData.filter(d => d.is_promo_week).map(d => [d.week, { name: d.promo_name, groupName: d.promo_group_name }]))} />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                      <Bar yAxisId="left" dataKey="ordered_qty" fill="#3b82f6" name="Ordered" barSize={10}>
                        {shipData.map((_, i) => <Cell key={i} fill={extensionStartWeek && shipData[i].week >= extensionStartWeek ? '#93c5fd' : '#3b82f6'} />)}
                      </Bar>
                      <Bar yAxisId="left" dataKey="shipped_qty" fill="#ec4899" name="Shipped" barSize={10}>
                        {shipData.map((_, i) => <Cell key={i} fill={extensionStartWeek && shipData[i].week >= extensionStartWeek ? '#f9a8d4' : '#ec4899'} />)}
                      </Bar>
                      {extensionStartWeek && <ReferenceLine yAxisId="left" x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />}
                      <Line yAxisId="right" dataKey="avg_fill_rate" stroke="#f59e0b" name="Fill Rate" type="monotone" strokeWidth={2} dot={false} />
                      <ReferenceLine yAxisId="right" y={0.95} stroke="#d1d5db" strokeDasharray="5 5" />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              />

              {/* Chart 4 — DC Inventory */}
              <ChartShell
                title="DC Inventory"
                subtitle="Weekly on-hand inventory at Retailer DCs and Supplier DCs"
                error={dcInvError} loading={dcInvLoading}
                isZoomed={zoom4.isZoomed} onZoomReset={zoom4.resetZoom}
                filters={
                  <ToggleSegment
                    value={dcViewMode}
                    onChange={v => setDcViewMode(v as 'both' | 'rdc_only')}
                    options={[{ value: 'both', label: 'Both' }, { value: 'rdc_only', label: 'Retailer DC only' }]}
                  />
                }
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={zoom4.displayData} margin={{ top: 5, right: 20, left: 0, bottom: 20 }}
                      onMouseDown={zoom4.onMouseDown} onMouseMove={zoom4.onMouseMove} onMouseUp={zoom4.onMouseUp}
                      style={{ cursor: zoom4.isZoomed ? 'grab' : 'crosshair', outline: 'none' }}>
                      {zoom4.selectionArea()}
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                      <Tooltip content={<DCInvTooltip />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                      <Line dataKey="dc_inventory" stroke="#6366f1" name="Retailer DC" type="monotone" strokeWidth={2} dot={false} />
                      {dcViewMode === 'both' && (
                        <Line dataKey="supplier_dc_inventory" stroke="#ec4899" name="Supplier DC" type="monotone" strokeWidth={2} dot={false} />
                      )}
                      {extensionStartWeek && <ReferenceLine x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />}
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              />

            </div>
          </>
        )}

        {activeTab === 'narrative' && (() => {
          const third = Math.ceil(posData.length / 3)
          const steps = [
            {
              label: 'The Baseline',
              weekRange: `${posData[0]?.week ?? '—'} – ${posData[third - 1]?.week ?? '—'}`,
              description: 'Stable demand history. All supply chain nodes operating within target weeks-of-supply.',
              posSlice: posData.slice(0, third),
              invSlice: storeInvData.slice(0, third),
              shipSlice: shipData.slice(0, third),
              kpis: [
                { label: 'Avg Weekly Sales', value: posData.slice(0, third).length ? `${Math.round(posData.slice(0, third).reduce((s: number, r: any) => s + r.sales_qty, 0) / third).toLocaleString()} units` : '—' },
                { label: 'Lost Sales Rate', value: (() => { const s = posData.slice(0, third); const sold = s.reduce((a: number, r: any) => a + r.sales_qty, 0); const lost = s.reduce((a: number, r: any) => a + r.stockout_qty, 0); return sold + lost > 0 ? `${((lost / (sold + lost)) * 100).toFixed(1)}%` : '—' })() },
                { label: 'Avg Fill Rate', value: shipData.slice(0, third).length ? `${(shipData.slice(0, third).reduce((s: number, r: any) => s + r.avg_fill_rate, 0) / third * 100).toFixed(1)}%` : '—' },
                { label: 'Peak On-Hand', value: storeInvData.slice(0, third).length ? `${Math.max(...storeInvData.slice(0, third).map((r: any) => r.on_hand_quantity)).toLocaleString()}` : '—' },
              ],
              narrative: 'The simulation opens with all supply chain nodes operating smoothly. Store inventory levels are well above target, the retailer DC is shipping full replenishment orders, and the supplier is fulfilling close to 100% of DC orders. Demand is steady with predictable weekly patterns — this baseline period establishes the "healthy state" benchmark for the rest of the run.',
              finding: 'When the system starts healthy, the replenishment logic performs exactly as designed. This period confirms the model is calibrated correctly.',
              findingColor: 'border-emerald-300 bg-emerald-50 text-emerald-800',
            },
            {
              label: 'The Constraint Emerges',
              weekRange: `${posData[third]?.week ?? '—'} – ${posData[third * 2 - 1]?.week ?? '—'}`,
              description: 'Supplier fill rate begins to fall. Retailer DC inventory declines below target WOS.',
              posSlice: posData.slice(third, third * 2),
              invSlice: storeInvData.slice(third, third * 2),
              shipSlice: shipData.slice(third, third * 2),
              kpis: [
                { label: 'Avg Weekly Sales', value: posData.slice(third, third * 2).length ? `${Math.round(posData.slice(third, third * 2).reduce((s: number, r: any) => s + r.sales_qty, 0) / third).toLocaleString()} units` : '—' },
                { label: 'Lost Sales Rate', value: (() => { const s = posData.slice(third, third * 2); const sold = s.reduce((a: number, r: any) => a + r.sales_qty, 0); const lost = s.reduce((a: number, r: any) => a + r.stockout_qty, 0); return sold + lost > 0 ? `${((lost / (sold + lost)) * 100).toFixed(1)}%` : '—' })() },
                { label: 'Avg Fill Rate', value: shipData.slice(third, third * 2).length ? `${(shipData.slice(third, third * 2).reduce((s: number, r: any) => s + r.avg_fill_rate, 0) / third * 100).toFixed(1)}%` : '—' },
                { label: 'DC On-Hand Drop', value: storeInvData.slice(third, third * 2).length ? `${Math.round((1 - storeInvData[third * 2 - 1]?.on_hand_quantity / (storeInvData[third]?.on_hand_quantity || 1)) * 100)}%` : '—' },
              ],
              narrative: 'Midway through the simulation, supplier fill rates begin to deteriorate. The retailer DC can no longer replenish its full ordered quantity, and on-hand inventory at the DC starts declining. Stores begin experiencing isolated stockouts — initially masked in the aggregate data but visible when filtered by individual store. The replenishment engine responds by ordering more, but the supplier cannot keep up.',
              finding: 'A drop in fill rate at the supplier level takes 3–4 weeks to visibly impact store shelves. This lag is the window where intervention is possible before lost sales cascade.',
              findingColor: 'border-amber-300 bg-amber-50 text-amber-800',
            },
            {
              label: 'Vendor Comparison',
              weekRange: `${shipData[0]?.week ?? '—'} – ${shipData[shipData.length - 1]?.week ?? '—'}`,
              description: 'Retailer DC vs Supplier DC — who absorbed the pressure and who passed it on.',
              posSlice: dcInvData,
              invSlice: storeInvData,
              shipSlice: shipData,
              kpis: [
                { label: 'Total Ordered', value: shipData.length ? `${Math.round(shipData.reduce((s: number, r: any) => s + r.ordered_qty, 0) / 1000).toLocaleString()}K` : '—' },
                { label: 'Total Shipped', value: shipData.length ? `${Math.round(shipData.reduce((s: number, r: any) => s + r.shipped_qty, 0) / 1000).toLocaleString()}K` : '—' },
                { label: 'Overall Fill Rate', value: shipData.length ? `${(shipData.reduce((s: number, r: any) => s + r.avg_fill_rate, 0) / shipData.length * 100).toFixed(1)}%` : '—' },
                { label: 'Unfulfilled Units', value: shipData.length ? `${Math.round((shipData.reduce((s: number, r: any) => s + r.ordered_qty, 0) - shipData.reduce((s: number, r: any) => s + r.shipped_qty, 0)) / 1000).toLocaleString()}K` : '—' },
              ],
              narrative: 'Comparing inventory levels at the Retailer DC and Supplier DC reveals a clear divergence. The Supplier DC maintains high on-hand inventory throughout the run, while the Retailer DC is persistently depleted. This pattern indicates the supplier is holding inventory upstream rather than releasing it — the bottleneck is not production capacity but allocation and order fulfillment policy at the vendor level.',
              finding: 'When the Supplier DC holds inventory while the Retailer DC starves, the issue is vendor allocation policy — not a supply shortage. Escalating fill rate SLAs or shifting to vendor-managed inventory would address the root cause.',
              findingColor: 'border-majorelle-blue-200 bg-majorelle-blue-50 text-majorelle-blue-800',
            },
          ]

          const step = steps[narrativeStep]

          return (
            <div>
              {/* Step progress */}
              <div className="mb-6 flex items-center gap-0">
                {steps.map((s, i) => (
                  <div key={i} className="flex flex-1 items-center">
                    <button
                      onClick={() => setNarrativeStep(i)}
                      className="flex flex-shrink-0 flex-col items-center gap-1"
                    >
                      <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all ${
                        i < narrativeStep ? 'bg-emerald-500 text-white' : i === narrativeStep ? 'bg-majorelle-blue-500 text-white' : 'bg-charcoal-blue-100 text-charcoal-blue-400'
                      }`}>
                        {i < narrativeStep ? '✓' : i + 1}
                      </div>
                      <span className={`text-[10px] font-semibold whitespace-nowrap ${i === narrativeStep ? 'text-majorelle-blue-600' : 'text-charcoal-blue-400'}`}>{s.label}</span>
                    </button>
                    {i < steps.length - 1 && (
                      <div className={`mx-2 mb-4 h-px flex-1 ${i < narrativeStep ? 'bg-emerald-400' : 'bg-charcoal-blue-200'}`} />
                    )}
                  </div>
                ))}
              </div>

              {/* Step content */}
              <div className="rounded-xl border border-charcoal-blue-200 bg-white p-5 shadow-sm">
                <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-majorelle-blue-500">Step {narrativeStep + 1} of {steps.length}</p>
                <h2 className="text-lg font-black tracking-tight text-charcoal-blue-950">{step.label}</h2>
                <p className="mb-4 mt-0.5 text-xs text-charcoal-blue-400">{step.weekRange} — {step.description}</p>

                {/* Chart */}
                <div className="mb-4 rounded-lg border border-charcoal-blue-100 bg-charcoal-blue-50 p-3">
                  <ResponsiveContainer width="100%" height={220}>
                    {narrativeStep === 2 ? (
                      <ComposedChart data={dcInvData} margin={{ top: 5, right: 20, left: 0, bottom: 50 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="week" angle={-45} textAnchor="end" height={60} tick={{ fontSize: 9 }} />
                        <YAxis tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 9 }} />
                        <Tooltip formatter={(v) => typeof v === 'number' ? v.toLocaleString() : String(v ?? '')} />
                        <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                        <Line dataKey="retailer_dc_inventory" stroke="#6366f1" name="Vendor A" type="monotone" strokeWidth={2} dot={false} />
                        <Line dataKey="supplier_dc_inventory" stroke="#ec4899" name="Vendor B" type="monotone" strokeWidth={2} dot={false} />
                        <Bar dataKey="ordered_qty" yAxisId={undefined} fill="transparent" />
                      </ComposedChart>
                    ) : (
                      <ComposedChart data={step.posSlice} margin={{ top: 5, right: 20, left: 0, bottom: 50 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="week" angle={-45} textAnchor="end" height={60} tick={{ fontSize: 9 }} />
                        <YAxis tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 9 }} />
                        <Tooltip formatter={(v) => typeof v === 'number' ? v.toLocaleString() : String(v ?? '')} />
                        <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                        <Bar dataKey="demand_qty" fill="#8b5cf6" name="Demand" barSize={10}>
                          {step.posSlice.map((e: any, i: number) => <Cell key={i} fill={extensionStartWeek && e.week >= extensionStartWeek ? '#c4b5fd' : '#8b5cf6'} />)}
                        </Bar>
                        <Bar dataKey="sales_qty" fill="#10b981" name="Sales" barSize={10}>
                          {step.posSlice.map((e: any, i: number) => <Cell key={i} fill={extensionStartWeek && e.week >= extensionStartWeek ? '#6ee7b7' : '#10b981'} />)}
                        </Bar>
                        <Bar dataKey="stockout_qty" fill="#ef4444" name="Lost Sales" barSize={10}>
                          {step.posSlice.map((e: any, i: number) => <Cell key={i} fill={extensionStartWeek && e.week >= extensionStartWeek ? '#fca5a5' : '#ef4444'} />)}
                        </Bar>
                        {extensionStartWeek && <ReferenceLine x={extensionStartWeek} stroke="#5b5fcf" strokeDasharray="4 2" label={{ value: 'Extension', position: 'insideTopRight', fontSize: 9, fill: '#5b5fcf' }} />}
                      </ComposedChart>
                    )}
                  </ResponsiveContainer>
                </div>

                {/* KPI row */}
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {step.kpis.map((kpi, i) => (
                    <div key={i} className="rounded-lg border border-charcoal-blue-100 bg-charcoal-blue-50 px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-charcoal-blue-400">{kpi.label}</p>
                      <p className="mt-0.5 text-sm font-black text-charcoal-blue-950">{kpi.value}</p>
                    </div>
                  ))}
                </div>

                {/* Narrative text */}
                <p className="mb-3 text-xs leading-relaxed text-charcoal-blue-700">{step.narrative}</p>

                {/* Key finding */}
                <div className={`rounded-lg border px-3 py-2.5 ${step.findingColor}`}>
                  <span className="mr-1 text-[10px] font-black uppercase tracking-wide">Key finding:</span>
                  <span className="text-[11px] leading-relaxed">{step.finding}</span>
                </div>
              </div>

              {/* Navigation */}
              <div className="mt-4 flex items-center justify-between">
                <button
                  onClick={() => setNarrativeStep(s => Math.max(0, s - 1))}
                  disabled={narrativeStep === 0}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-charcoal-blue-200 bg-white px-4 py-2 text-xs font-bold text-charcoal-blue-600 transition hover:bg-charcoal-blue-50 disabled:opacity-30"
                >
                  <ChevronLeft size={14} /> Previous
                </button>
                <span className="text-xs text-charcoal-blue-400">{narrativeStep + 1} / {steps.length}</span>
                <button
                  onClick={() => setNarrativeStep(s => Math.min(steps.length - 1, s + 1))}
                  disabled={narrativeStep === steps.length - 1}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition hover:bg-majorelle-blue-600 disabled:opacity-30"
                >
                  Next <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )
        })()}
      </div>
    </div>

    <ExtendForecastModal
      open={showExtendModal}
      onClose={() => setShowExtendModal(false)}
      baseSimulationId={simulationId}
    />

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
    </>
  )
}
