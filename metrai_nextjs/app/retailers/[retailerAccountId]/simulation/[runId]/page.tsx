'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Download, Package, Truck, ShoppingCart, AlertCircle, Loader2, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import {
  getAnalyticsMeta,
  getStoreSales, getStoreInventory, getSupplierSales, getDCInventory,
  getSummaryStoreSales, getSummaryStoreInventory, getSummarySupplyChainSales, getSummaryUpstreamInventory,
} from '@/lib/api/analytics'
import { getRunConfig } from '@/lib/api/simulation'
import { useSimulationStore } from '@/lib/store/simulationStore'
import type { AnalyticsMeta, SimulationSummary } from '@/lib/api/types'

// ── Aggregation helpers ───────────────────────────────────────────────────────

function aggPOS(pos: any[]) {
  const map = new Map<string, { demand: number; sales: number; lost: number; revenue: number; isPromo: boolean; promoName: string }>()
  for (const r of pos) {
    const c = map.get(r.pos_week) ?? { demand: 0, sales: 0, lost: 0, revenue: 0, isPromo: false, promoName: '' }
    map.set(r.pos_week, {
      demand: c.demand + Number(r.demand_qty),
      sales: c.sales + Number(r.sales_qty),
      lost: c.lost + Number(r.lost_sales_qty),
      revenue: c.revenue + Number(r.sales_amount),
      isPromo: c.isPromo || Boolean(Number(r.is_promo_week ?? r.is_promo_demand ?? 0)),
      promoName: c.promoName || (r.promo_name ?? ''),
    })
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
    week,
    demand_qty: v.demand,
    sales_qty: v.sales,
    lost_sales_qty: v.lost,
    sales_amount: v.revenue,
    is_promo_week: v.isPromo ? 1 : 0,
    promo_name: v.promoName,
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
  const totalLost    = pos.reduce((s: number, r: any) => s + Number(r.lost_sales_qty ?? 0), 0)
  const totalRevenue = pos.reduce((s: number, r: any) => s + Number(r.sales_amount ?? 0), 0)
  const fillSum      = shipments.reduce((s: number, r: any) => s + Number(r.avg_fill_rate ?? r.fill_rate ?? 0), 0)
  const fillRate     = shipments.length > 0 ? (fillSum / shipments.length) * 100 : 0
  const stockoutRate = totalSales + totalLost > 0 ? (totalLost / (totalSales + totalLost)) * 100 : 0
  return { totalSales, totalRevenue, fillRate, stockoutRate }
}

// ── Custom tooltip ────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label, promoWeekMap }: {
  active?: boolean; payload?: any[]; label?: string
  promoWeekMap?: Record<string, string>
}) {
  if (!active || !payload?.length) return null
  const promoName = payload[0]?.payload?.promo_name || promoWeekMap?.[label ?? ''] || ''
  const isPromo = payload[0]?.payload?.is_promo_week || (promoWeekMap && label && promoWeekMap[label])
  return (
    <div className="rounded-lg border border-charcoal-blue-200 bg-white px-3 py-2 shadow-md text-xs min-w-[140px]">
      {isPromo && (
        <div className="mb-2 flex items-center gap-1.5 rounded-md bg-violet-50 px-2 py-1">
          <span className="h-2 w-2 flex-shrink-0 rounded-full bg-violet-500" />
          <span className="font-semibold text-violet-700 truncate">{promoName || 'Promo week'}</span>
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

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold text-charcoal-blue-500">{label}</span>
      <div className="relative">
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-48 truncate appearance-none rounded-xl border border-charcoal-blue-200 bg-white px-3 py-1.5 pr-7 text-xs font-medium text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none"
        >
          <option value="">All</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-charcoal-blue-400">▼</span>
      </div>
    </div>
  )
}

function ChartModal({ title, subtitle, filters, error, children, onClose }: {
  title: string; subtitle: string; filters?: React.ReactNode
  error: string; children: React.ReactNode; onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div className="w-full max-w-5xl rounded-xl border border-charcoal-blue-200 bg-white p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-charcoal-blue-950">{title}</h3>
            <p className="text-[10px] text-charcoal-blue-400">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {filters}
            <button onClick={onClose} className="ml-2 rounded-lg border border-charcoal-blue-200 px-2 py-1 text-xs font-semibold text-charcoal-blue-500 hover:bg-charcoal-blue-50">✕ Close</button>
          </div>
        </div>
        {error && <ChartError message={error} />}
        {children}
      </div>
    </div>
  )
}

function ChartShell({ title, subtitle, filters, error, loading, chart }: {
  title: string; subtitle: string; filters?: React.ReactNode
  error: string; loading: boolean; chart: (height: number) => React.ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <div className="rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm flex flex-col">
        {/* Header with Expand button top-right */}
        <div className="mb-4 flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold text-charcoal-blue-950">{title}</h3>
            <p className="text-[10px] text-charcoal-blue-400">{subtitle}</p>
          </div>
          <button onClick={() => setExpanded(true)} className="flex-shrink-0 rounded-xl border border-charcoal-blue-200 px-2 py-1 text-[10px] font-semibold text-charcoal-blue-500 hover:bg-charcoal-blue-50">⤢ Expand</button>
        </div>
        {/* Filters below heading */}
        {filters && <div className="mb-4 flex flex-wrap items-center gap-2">{filters}</div>}
        {error && <ChartError message={error} />}
        {/* Chart — centered with minimal spacing */}
        <div className="flex flex-col items-center justify-center my-1">
          {loading
            ? <Loader2 size={22} className="animate-spin text-majorelle-blue-400" />
            : chart(220)}
        </div>
      </div>
      {expanded && (
        <ChartModal title={title} subtitle={subtitle} filters={filters} error={error} onClose={() => setExpanded(false)}>
          <div className="flex flex-col items-center justify-center my-2">
            {chart(450)}
          </div>
        </ChartModal>
      )}
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type PageState = 'loading' | 'polling' | 'ready' | 'error'

export default function SimulationResultsPage() {
  const params = useParams()
  const simulationId = params.runId as string
  const { cache } = useSimulationStore()

  const [pageState, setPageState] = useState<PageState>('loading')
  const [pageError, setPageError] = useState('')
  const [simName, setSimName] = useState('Simulation Results')
  const [activeTab, setActiveTab] = useState('dashboard')
  const [narrativeStep, setNarrativeStep] = useState(0)
  const [meta, setMeta] = useState<AnalyticsMeta | null>(null)

  // Chart 1 — POS (store sales)
  const [posData, setPosData] = useState<any[]>([])
  const [posError, setPosError] = useState('')
  const [posLoading, setPosLoading] = useState(false)
  const [posItemFilter, setPosItemFilter] = useState('')
  const [posStoreFilter, setPosStoreFilter] = useState('')

  // Chart 2 — Store inventory
  const [storeInvData, setStoreInvData] = useState<any[]>([])
  const [storeInvError, setStoreInvError] = useState('')
  const [storeInvLoading, setStoreInvLoading] = useState(false)
  const [invItemFilter, setInvItemFilter] = useState('')
  const [invStoreFilter, setInvStoreFilter] = useState('')

  // Chart 3 — Shipments
  const [shipData, setShipData] = useState<any[]>([])
  const [shipError, setShipError] = useState('')
  const [shipLoading, setShipLoading] = useState(false)
  const [shipItemFilter, setShipItemFilter] = useState('')
  const [shipSdcFilter, setShipSdcFilter]   = useState('')
  const [shipRdcFilter, setShipRdcFilter]   = useState('')

  // Chart 4 — DC inventory
  const [dcInvData, setDcInvData] = useState<any[]>([])
  const [dcInvError, setDcInvError] = useState('')
  const [dcInvLoading, setDcInvLoading] = useState(false)
  const [dcItemFilter, setDcItemFilter] = useState('')
  const [dcFilter, setDcFilter] = useState('')
  const [dcSdcFilter, setDcSdcFilter]   = useState('')
  const [dcViewMode, setDcViewMode]     = useState<'both' | 'rdc_only'>('both')

  const [kpis, setKpis] = useState({ totalSales: 0, totalRevenue: 0, fillRate: 0, stockoutRate: 0 })

  // ── Global filters ────────────────────────────────────────────────────────
  const [globalItem, setGlobalItem]   = useState('')
  const [globalStore, setGlobalStore] = useState('')
  const [globalSdc, setGlobalSdc]     = useState('')
  const [globalRdc, setGlobalRdc]     = useState('')

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
      setSimName(cache.simulationName)
      applySummary(cache.summary)
      getAnalyticsMeta(simulationId).then(setMeta).catch(() => null)
      setPageState('ready')
      return
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

  // ── Filtered fetch handlers ───────────────────────────────────────────────

  const fetchPOSFiltered = useCallback(async (itemId: string, storeId: string) => {
    setPosLoading(true); setPosError('')
    try {
      const p = { item_id: itemId || undefined, store_id: storeId || undefined }
      const data = await getStoreSales(simulationId, p)
      setPosData(aggPOS(data.weekly_pos ?? []))
    } catch (e: any) { setPosError(e?.message ?? 'Failed') }
    finally { setPosLoading(false) }
  }, [simulationId])

  const fetchStoreInvFiltered = useCallback(async (itemId: string, storeId: string) => {
    setStoreInvLoading(true); setStoreInvError('')
    try {
      const p = { item_id: itemId || undefined, store_id: storeId || undefined }
      const data = await getStoreInventory(simulationId, p)
      setStoreInvData(aggStoreInv(data.store_inventory ?? []))
    } catch (e: any) { setStoreInvError(e?.message ?? 'Failed') }
    finally { setStoreInvLoading(false) }
  }, [simulationId])

  const fetchShipFiltered = useCallback(async (itemId: string, sdcId: string, rdcId: string) => {
    setShipLoading(true); setShipError('')
    try {
      const data = await getSupplierSales(simulationId, {
        item_id:          itemId || undefined,
        supplier_dc_id:   sdcId  || undefined,
        retailer_dc_id:   rdcId  || undefined,
      })
      setShipData(aggShipments(data.weekly_shipments ?? []))
    } catch (e: any) { setShipError(e?.message ?? 'Failed') }
    finally { setShipLoading(false) }
  }, [simulationId])

  const fetchDCInvFiltered = useCallback(async (itemId: string, rdcId: string, sdcId: string) => {
    setDcInvLoading(true); setDcInvError('')
    try {
      const data = await getDCInventory(simulationId, {
        item_id:        itemId || undefined,
        dc_id:          rdcId  || undefined,
        supplier_dc_id: sdcId  || undefined,
      })
      setDcInvData(aggDCInv(data.dc_inventory ?? [], data.supplier_dc_inventory ?? []))
    } catch (e: any) { setDcInvError(e?.message ?? 'Failed') }
    finally { setDcInvLoading(false) }
  }, [simulationId])

  const resetToSummary = useCallback((chart: 'pos' | 'inv' | 'ship' | 'dc') => {
    if (cache?.simulationId === simulationId && cache.summary) {
      const s = cache.summary
      if (chart === 'pos')  setPosData(aggPOS(s.weekly_pos ?? []))
      if (chart === 'inv')  setStoreInvData(aggStoreInv(s.store_inventory ?? []))
      if (chart === 'ship') setShipData(aggShipments(s.weekly_shipments ?? []))
      if (chart === 'dc')   setDcInvData(aggDCInv(s.dc_inventory ?? [], s.supplier_dc_inventory ?? []))
    } else {
      loadSummary()
    }
  }, [cache, simulationId, loadSummary])

  const applyGlobalFilters = useCallback((item: string, store: string, sdc: string, rdc: string) => {
    setGlobalItem(item); setGlobalStore(store); setGlobalSdc(sdc); setGlobalRdc(rdc)
    // Broadcast to per-chart filters
    setPosItemFilter(item);     setPosStoreFilter(store)
    setInvItemFilter(item);     setInvStoreFilter(store)
    setShipItemFilter(item);    setShipSdcFilter(sdc);   setShipRdcFilter(rdc)
    setDcItemFilter(item);      setDcSdcFilter(sdc);     setDcFilter(rdc)
    // Re-fetch each chart
    const anyPos  = !!(item || store)
    const anyShip = !!(item || sdc || rdc)
    if (anyPos)  { fetchPOSFiltered(item, store); fetchStoreInvFiltered(item, store) }
    else         { resetToSummary('pos'); resetToSummary('inv') }
    if (anyShip) { fetchShipFiltered(item, sdc, rdc); fetchDCInvFiltered(item, rdc, sdc) }
    else         { resetToSummary('ship'); resetToSummary('dc') }
  }, [fetchPOSFiltered, fetchStoreInvFiltered, fetchShipFiltered, fetchDCInvFiltered, resetToSummary])

  const resetAllFilters = useCallback(() => {
    applyGlobalFilters('', '', '', '')
  }, [applyGlobalFilters])

  // ── Status polling ────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    if (cache?.simulationId === simulationId && cache.summary) {
      loadSummary()
      return
    }

    const checkStatus = async () => {
      try {
        const cfg = await getRunConfig(simulationId)
        const name = (cfg.full_config as any)?.run?.simulation_name ?? 'Simulation Results'
        if (!cancelled) setSimName(String(name))
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

  function filteredItemOptions(activeStoreId: string) {
    if (!activeStoreId) return allItemOptions
    const allowed = new Set(storeItemMap[activeStoreId] ?? [])
    return allItemOptions.filter(o => allowed.has(o.value))
  }
  function filteredStoreOptions(activeItemId: string) {
    if (!activeItemId) return allStoreOptions
    const allowed = new Set(itemStoreMap[activeItemId] ?? [])
    return allStoreOptions.filter(o => allowed.has(o.value))
  }

  const xAxisProps = { angle: -45, textAnchor: 'end' as const, height: 80, tick: { fontSize: 10 } }

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
    <div className="w-full min-h-screen bg-gradient-to-br from-charcoal-blue-50 via-white to-charcoal-blue-50 px-6 py-6">
      <div className="w-full">

        {/* Header */}
        <div className="mb-5 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-2xl font-black tracking-tight text-charcoal-blue-950">{simName}</h1>
            {meta && (
              <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">
                {meta.items_meta.length} items · {meta.stores_meta.length} stores · {meta.dcs_meta.length} DCs
              </p>
            )}
          </div>
          <button className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600">
            <Download size={13} /> Export
          </button>
        </div>

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

            {/* Global Filter Bar */}
            <div className="mb-5 rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50 px-4 py-3 flex flex-wrap items-center gap-3">
              <span className="text-xs font-bold text-majorelle-blue-700 shrink-0">Global Filter</span>
              <FilterSelect label="Item" value={globalItem} options={allItemOptions}
                onChange={v => applyGlobalFilters(v, globalStore, globalSdc, globalRdc)} />
              <FilterSelect label="Store" value={globalStore} options={filteredStoreOptions(globalItem)}
                onChange={v => applyGlobalFilters(globalItem, v, globalSdc, globalRdc)} />
              <FilterSelect label="Supplier DC" value={globalSdc} options={filteredShipSdcOptions(globalItem, globalRdc)}
                onChange={v => applyGlobalFilters(globalItem, globalStore, v, globalRdc)} />
              <FilterSelect label="Retailer DC" value={globalRdc} options={filteredShipRdcOptions(globalItem, globalSdc)}
                onChange={v => applyGlobalFilters(globalItem, globalStore, globalSdc, v)} />
              {(globalItem || globalStore || globalSdc || globalRdc) && (
                <button
                  onClick={resetAllFilters}
                  className="ml-auto text-xs font-semibold text-majorelle-blue-600 hover:text-majorelle-blue-800 underline underline-offset-2 shrink-0"
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="mb-5 grid gap-4 grid-cols-1 lg:grid-cols-2">

              {/* Chart 1 — POS Store Sales */}
              <ChartShell
                title="POS — Store Sales"
                subtitle="Weekly demand, sales and lost sales across all stores"
                error={posError} loading={posLoading}
                filters={<>
                  <FilterSelect label="Item" value={posItemFilter} options={filteredItemOptions(posStoreFilter)}
                    onChange={v => { setPosItemFilter(v); (v || posStoreFilter) ? fetchPOSFiltered(v, posStoreFilter) : resetToSummary('pos') }} />
                  <FilterSelect label="Store" value={posStoreFilter} options={filteredStoreOptions(posItemFilter)}
                    onChange={v => { setPosStoreFilter(v); (posItemFilter || v) ? fetchPOSFiltered(posItemFilter, v) : resetToSummary('pos') }} />
                </>}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={posData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }} barCategoryGap="4%" barGap={2}>
                      {posData.filter(d => d.is_promo_week).map(d => (
                        <ReferenceArea key={d.week} x1={d.week} x2={d.week} fill="#8b5cf6" fillOpacity={0.12} stroke="none" />
                      ))}
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }} />
                      <Bar dataKey="demand_qty" fill="#8b5cf6" name="Demand" />
                      <Bar dataKey="sales_qty" fill="#10b981" name="Sales" />
                      <Bar dataKey="lost_sales_qty" fill="#ef4444" name="Lost Sales" />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              />

              {/* Chart 2 — Store Inventory */}
              <ChartShell
                title="Store Inventory"
                subtitle="Weekly on-hand, available and on-order inventory at stores"
                error={storeInvError} loading={storeInvLoading}
                filters={<>
                  <FilterSelect label="Item" value={invItemFilter} options={filteredItemOptions(invStoreFilter)}
                    onChange={v => { setInvItemFilter(v); (v || invStoreFilter) ? fetchStoreInvFiltered(v, invStoreFilter) : resetToSummary('inv') }} />
                  <FilterSelect label="Store" value={invStoreFilter} options={filteredStoreOptions(invItemFilter)}
                    onChange={v => { setInvStoreFilter(v); (invItemFilter || v) ? fetchStoreInvFiltered(invItemFilter, v) : resetToSummary('inv') }} />
                </>}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={storeInvData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                      <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }} />
                      <Line dataKey="available_quantity" stroke="#10b981" name="Available" type="monotone" strokeWidth={2} dot={false} />
                      <Line dataKey="on_order_quantity" stroke="#f59e0b" name="On Order" type="monotone" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              />

              {/* Chart 3 — Supply Chain Shipments */}
              <ChartShell
                title="Supply Chain Shipments"
                subtitle="Supplier DC → Retailer DC ordered vs shipped and fill rate"
                error={shipError} loading={shipLoading}
                filters={<>
                  <FilterSelect label="Item" value={shipItemFilter} options={allItemOptions}
                    onChange={v => { setShipItemFilter(v); (v || shipSdcFilter || shipRdcFilter) ? fetchShipFiltered(v, shipSdcFilter, shipRdcFilter) : resetToSummary('ship') }} />
                  <FilterSelect label="Supplier DC" value={shipSdcFilter} options={filteredShipSdcOptions(shipItemFilter, shipRdcFilter)}
                    onChange={v => { setShipSdcFilter(v); (shipItemFilter || v || shipRdcFilter) ? fetchShipFiltered(shipItemFilter, v, shipRdcFilter) : resetToSummary('ship') }} />
                  <FilterSelect label="Retailer DC" value={shipRdcFilter} options={filteredShipRdcOptions(shipItemFilter, shipSdcFilter)}
                    onChange={v => { setShipRdcFilter(v); (shipItemFilter || shipSdcFilter || v) ? fetchShipFiltered(shipItemFilter, shipSdcFilter, v) : resetToSummary('ship') }} />
                </>}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={shipData} margin={{ top: 5, right: 40, left: 0, bottom: 60 }} barCategoryGap="4%" barGap={2}>
                      {posData.filter(d => d.is_promo_week).map(d => (
                        <ReferenceArea key={d.week} yAxisId="left" x1={d.week} x2={d.week} fill="#8b5cf6" fillOpacity={0.12} stroke="none" />
                      ))}
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis yAxisId="left" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                      <YAxis yAxisId="right" orientation="right" domain={[0, 1]} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                      <Tooltip content={<ChartTooltip promoWeekMap={Object.fromEntries(posData.filter(d => d.is_promo_week).map(d => [d.week, d.promo_name]))} />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }} />
                      <Bar yAxisId="left" dataKey="ordered_qty" fill="#3b82f6" name="Ordered" />
                      <Bar yAxisId="left" dataKey="shipped_qty" fill="#ec4899" name="Shipped" />
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
                filters={<>
                  <FilterSelect label="Item" value={dcItemFilter} options={allItemOptions}
                    onChange={v => { setDcItemFilter(v); (v || dcFilter || dcSdcFilter) ? fetchDCInvFiltered(v, dcFilter, dcSdcFilter) : resetToSummary('dc') }} />
                  <FilterSelect label="Supplier DC" value={dcSdcFilter} options={filteredShipSdcOptions(dcItemFilter, dcFilter)}
                    onChange={v => { setDcSdcFilter(v); (dcItemFilter || dcFilter || v) ? fetchDCInvFiltered(dcItemFilter, dcFilter, v) : resetToSummary('dc') }} />
                  <FilterSelect label="Retailer DC" value={dcFilter} options={filteredShipRdcOptions(dcItemFilter, dcSdcFilter)}
                    onChange={v => { setDcFilter(v); (dcItemFilter || v || dcSdcFilter) ? fetchDCInvFiltered(dcItemFilter, v, dcSdcFilter) : resetToSummary('dc') }} />
                  <ToggleSegment
                    value={dcViewMode}
                    onChange={v => setDcViewMode(v as 'both' | 'rdc_only')}
                    options={[{ value: 'both', label: 'Both' }, { value: 'rdc_only', label: 'Retailer DC only' }]}
                  />
                </>}
                chart={(h) => (
                  <ResponsiveContainer width="100%" height={h}>
                    <ComposedChart data={dcInvData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="week" {...xAxisProps} />
                      <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                      <Tooltip content={<DCInvTooltip />} />
                      <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }} />
                      <Line dataKey="dc_inventory" stroke="#6366f1" name="Retailer DC" type="monotone" strokeWidth={2} dot={false} />
                      {dcViewMode === 'both' && (
                        <Line dataKey="supplier_dc_inventory" stroke="#ec4899" name="Supplier DC" type="monotone" strokeWidth={2} dot={false} />
                      )}
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
                { label: 'Lost Sales Rate', value: (() => { const s = posData.slice(0, third); const sold = s.reduce((a: number, r: any) => a + r.sales_qty, 0); const lost = s.reduce((a: number, r: any) => a + r.lost_sales_qty, 0); return sold + lost > 0 ? `${((lost / (sold + lost)) * 100).toFixed(1)}%` : '—' })() },
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
                { label: 'Lost Sales Rate', value: (() => { const s = posData.slice(third, third * 2); const sold = s.reduce((a: number, r: any) => a + r.sales_qty, 0); const lost = s.reduce((a: number, r: any) => a + r.lost_sales_qty, 0); return sold + lost > 0 ? `${((lost / (sold + lost)) * 100).toFixed(1)}%` : '—' })() },
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
                        <Line dataKey="retailer_dc_inventory" stroke="#6366f1" name="Retailer DC" type="monotone" strokeWidth={2} dot={false} />
                        <Line dataKey="supplier_dc_inventory" stroke="#ec4899" name="Supplier DC" type="monotone" strokeWidth={2} dot={false} />
                        <Bar dataKey="ordered_qty" yAxisId={undefined} fill="transparent" />
                      </ComposedChart>
                    ) : (
                      <ComposedChart data={step.posSlice} margin={{ top: 5, right: 20, left: 0, bottom: 50 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="week" angle={-45} textAnchor="end" height={60} tick={{ fontSize: 9 }} />
                        <YAxis tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 9 }} />
                        <Tooltip formatter={(v) => typeof v === 'number' ? v.toLocaleString() : String(v ?? '')} />
                        <Legend verticalAlign="bottom" align="right" wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }} />
                        <Bar dataKey="demand_qty" fill="#8b5cf6" name="Demand" />
                        <Bar dataKey="sales_qty" fill="#10b981" name="Sales" />
                        <Bar dataKey="lost_sales_qty" fill="#ef4444" name="Lost Sales" />
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
  )
}
