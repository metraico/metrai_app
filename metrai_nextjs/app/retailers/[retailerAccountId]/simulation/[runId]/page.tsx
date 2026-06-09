'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Download, TrendingUp, Package, Truck, ShoppingCart, AlertCircle, Loader2 } from 'lucide-react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
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
  const map = new Map<string, { demand: number; sales: number; lost: number; revenue: number }>()
  for (const r of pos) {
    const c = map.get(r.pos_week) ?? { demand: 0, sales: 0, lost: 0, revenue: 0 }
    map.set(r.pos_week, {
      demand: c.demand + Number(r.demand_qty),
      sales: c.sales + Number(r.sales_qty),
      lost: c.lost + Number(r.lost_sales_qty),
      revenue: c.revenue + Number(r.sales_amount),
    })
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
    week,
    demand_qty: v.demand,
    sales_qty: v.sales,
    lost_sales_qty: v.lost,
    sales_amount: v.revenue,
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
  const dcMap  = new Map<string, number>()
  const supMap = new Map<string, number>()
  for (const r of dc)  dcMap.set(r.inventory_week,  (dcMap.get(r.inventory_week)  ?? 0) + Number(r.on_hand_quantity))
  for (const r of sup) supMap.set(r.inventory_week, (supMap.get(r.inventory_week) ?? 0) + Number(r.on_hand_quantity))
  const weeks = [...new Set([...dcMap.keys(), ...supMap.keys()])].sort()
  return weeks.map(w => ({
    week: w,
    dc_inventory: dcMap.get(w) ?? 0,
    supplier_dc_inventory: supMap.get(w) ?? 0,
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

// ── Small components ──────────────────────────────────────────────────────────

function KPICard({ label, value, icon: Icon, color }: { label: string; value: string; icon: React.ElementType; color: string }) {
  return (
    <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-charcoal-blue-400">{label}</p>
          <p className="mt-2 text-2xl font-black text-charcoal-blue-950">{value}</p>
        </div>
        <div className={`flex-shrink-0 rounded-2xl p-3 ${color}`}>
          <Icon size={24} className="text-white" />
        </div>
      </div>
    </div>
  )
}

function ChartError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 mb-4">
      <AlertCircle size={16} className="flex-shrink-0 text-rose-500" />
      <p className="text-sm font-medium text-rose-700">{message}</p>
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
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="rounded-xl border border-charcoal-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none"
      >
        <option value="">All</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

function ChartShell({ title, subtitle, filters, error, loading, children }: {
  title: string; subtitle: string; filters?: React.ReactNode
  error: string; loading: boolean; children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-charcoal-blue-950">{title}</h3>
          <p className="text-xs text-charcoal-blue-400">{subtitle}</p>
        </div>
        {filters && <div className="flex flex-wrap gap-2">{filters}</div>}
      </div>
      {error && <ChartError message={error} />}
      {loading
        ? <div className="flex h-64 items-center justify-center"><Loader2 size={28} className="animate-spin text-majorelle-blue-400" /></div>
        : children}
    </div>
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

  // Chart 4 — DC inventory
  const [dcInvData, setDcInvData] = useState<any[]>([])
  const [dcInvError, setDcInvError] = useState('')
  const [dcInvLoading, setDcInvLoading] = useState(false)
  const [dcItemFilter, setDcItemFilter] = useState('')
  const [dcFilter, setDcFilter] = useState('')

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

  const fetchShipFiltered = useCallback(async (itemId: string) => {
    setShipLoading(true); setShipError('')
    try {
      const data = await getSupplierSales(simulationId, { item_id: itemId || undefined })
      setShipData(aggShipments(data.weekly_shipments ?? []))
    } catch (e: any) { setShipError(e?.message ?? 'Failed') }
    finally { setShipLoading(false) }
  }, [simulationId])

  const fetchDCInvFiltered = useCallback(async (itemId: string, dcId: string) => {
    setDcInvLoading(true); setDcInvError('')
    try {
      const data = await getDCInventory(simulationId, { item_id: itemId || undefined, dc_id: dcId || undefined })
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

  const itemOptions  = (meta?.items_meta  ?? []).map((m: any) => ({ value: m.item_id,  label: m.item_code  }))
  const storeOptions = (meta?.stores_meta ?? []).map((m: any) => ({ value: m.store_id, label: m.store_code }))
  const dcOptions    = (meta?.dcs_meta    ?? []).map((m: any) => ({ value: m.dc_id,    label: m.dc_code    }))

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
      <div className="mx-auto max-w-7xl">

        {/* Header */}
        <div className="mb-8 flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-4xl font-black tracking-tight text-charcoal-blue-950">{simName}</h1>
            {meta && (
              <p className="mt-2 text-base font-medium text-charcoal-blue-400">
                {meta.items_meta.length} items · {meta.stores_meta.length} stores · {meta.dcs_meta.length} DCs
              </p>
            )}
          </div>
          <button className="inline-flex items-center gap-2 whitespace-nowrap rounded-2xl bg-majorelle-blue-500 px-6 py-3 font-bold text-white transition-all hover:bg-majorelle-blue-600">
            <Download size={16} /> Export
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-8 flex gap-2 border-b border-charcoal-blue-200">
          {['dashboard', 'narrative'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-semibold transition-all border-b-2 capitalize ${
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
            <div className="mb-8 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <KPICard label="Total Sales (units)" value={kpis.totalSales.toLocaleString()} icon={ShoppingCart} color="bg-blue-500" />
              <KPICard label="Total Revenue" value={`$${(kpis.totalRevenue / 1000).toFixed(1)}K`} icon={Package} color="bg-emerald-500" />
              <KPICard label="Avg Fill Rate" value={`${kpis.fillRate.toFixed(1)}%`} icon={Truck} color="bg-majorelle-blue-500" />
              <KPICard label="Stockout Rate" value={`${kpis.stockoutRate.toFixed(1)}%`} icon={AlertCircle} color="bg-rose-500" />
            </div>

            <div className="mb-6 grid gap-6 grid-cols-1 lg:grid-cols-2">

              {/* Chart 1 — POS Store Sales */}
              <ChartShell
                title="POS — Store Sales"
                subtitle="Weekly demand, sales and lost sales across all stores"
                error={posError} loading={posLoading}
                filters={<>
                  <FilterSelect label="Item" value={posItemFilter} options={itemOptions}
                    onChange={v => { setPosItemFilter(v); (v || posStoreFilter) ? fetchPOSFiltered(v, posStoreFilter) : resetToSummary('pos') }} />
                  <FilterSelect label="Store" value={posStoreFilter} options={storeOptions}
                    onChange={v => { setPosStoreFilter(v); (posItemFilter || v) ? fetchPOSFiltered(posItemFilter, v) : resetToSummary('pos') }} />
                </>}
              >
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={posData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" {...xAxisProps} />
                    <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                    <Legend />
                    <Bar dataKey="demand_qty" fill="#8b5cf6" name="Demand" />
                    <Bar dataKey="sales_qty" fill="#10b981" name="Sales" />
                    <Bar dataKey="lost_sales_qty" fill="#ef4444" name="Lost Sales" />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartShell>

              {/* Chart 2 — Store Inventory */}
              <ChartShell
                title="Store Inventory"
                subtitle="Weekly on-hand, available and on-order inventory at stores"
                error={storeInvError} loading={storeInvLoading}
                filters={<>
                  <FilterSelect label="Item" value={invItemFilter} options={itemOptions}
                    onChange={v => { setInvItemFilter(v); (v || invStoreFilter) ? fetchStoreInvFiltered(v, invStoreFilter) : resetToSummary('inv') }} />
                  <FilterSelect label="Store" value={invStoreFilter} options={storeOptions}
                    onChange={v => { setInvStoreFilter(v); (invItemFilter || v) ? fetchStoreInvFiltered(invItemFilter, v) : resetToSummary('inv') }} />
                </>}
              >
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={storeInvData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" {...xAxisProps} />
                    <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                    <Legend />
                    <Line dataKey="on_hand_quantity" stroke="#0ea5e9" name="On Hand" type="monotone" strokeWidth={2} dot={false} />
                    <Line dataKey="available_quantity" stroke="#10b981" name="Available" type="monotone" strokeWidth={2} dot={false} />
                    <Line dataKey="on_order_quantity" stroke="#f59e0b" name="On Order" type="monotone" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartShell>

              {/* Chart 3 — Supply Chain Shipments */}
              <ChartShell
                title="Supply Chain Shipments"
                subtitle="Supplier DC → Retailer DC ordered vs shipped and fill rate"
                error={shipError} loading={shipLoading}
                filters={
                  <FilterSelect label="Item" value={shipItemFilter} options={itemOptions}
                    onChange={v => { setShipItemFilter(v); v ? fetchShipFiltered(v) : resetToSummary('ship') }} />
                }
              >
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={shipData} margin={{ top: 5, right: 40, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" {...xAxisProps} />
                    <YAxis yAxisId="left" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                    <YAxis yAxisId="right" orientation="right" domain={[0, 1]} tickFormatter={v => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip formatter={(v, name) => String(name).includes('Fill') ? `${(Number(v) * 100).toFixed(1)}%` : Number(v).toLocaleString()} />
                    <Legend />
                    <Bar yAxisId="left" dataKey="ordered_qty" fill="#3b82f6" name="Ordered" />
                    <Bar yAxisId="left" dataKey="shipped_qty" fill="#60a5fa" name="Shipped" />
                    <Line yAxisId="right" dataKey="avg_fill_rate" stroke="#f59e0b" name="Fill Rate" type="monotone" strokeWidth={2} dot={false} />
                    <ReferenceLine yAxisId="right" y={0.95} stroke="#d1d5db" strokeDasharray="5 5" />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartShell>

              {/* Chart 4 — DC Inventory */}
              <ChartShell
                title="DC Inventory"
                subtitle="Weekly on-hand inventory at Retailer DCs and Supplier DCs"
                error={dcInvError} loading={dcInvLoading}
                filters={<>
                  <FilterSelect label="Item" value={dcItemFilter} options={itemOptions}
                    onChange={v => { setDcItemFilter(v); (v || dcFilter) ? fetchDCInvFiltered(v, dcFilter) : resetToSummary('dc') }} />
                  <FilterSelect label="DC" value={dcFilter} options={dcOptions}
                    onChange={v => { setDcFilter(v); (dcItemFilter || v) ? fetchDCInvFiltered(dcItemFilter, v) : resetToSummary('dc') }} />
                </>}
              >
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={dcInvData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" {...xAxisProps} />
                    <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v) => Number(v).toLocaleString()} />
                    <Legend />
                    <Line dataKey="dc_inventory" stroke="#6366f1" name="Retailer DC" type="monotone" strokeWidth={2} dot={false} />
                    <Line dataKey="supplier_dc_inventory" stroke="#ec4899" name="Supplier DC" type="monotone" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </ChartShell>

            </div>
          </>
        )}

        {activeTab === 'narrative' && (
          <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-8 text-center shadow-sm">
            <TrendingUp size={48} className="mx-auto mb-4 text-charcoal-blue-300" />
            <h3 className="text-xl font-bold text-charcoal-blue-950">Guided Narrative</h3>
            <p className="mt-2 text-charcoal-blue-400">AI-generated story of your simulation will appear here.</p>
          </div>
        )}
      </div>
    </div>
  )
}
