'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Download, TrendingUp, Package, Truck, ShoppingCart, AlertCircle, Loader2 } from 'lucide-react'
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { getAnalyticsMeta, getStoreSales, getSupplyChainSales, getUpstreamInventory } from '@/lib/api/analytics'
import { getRunConfig } from '@/lib/api/simulation'
import type {
  AnalyticsMeta,
  StoreSalesResponse,
  SupplyChainSalesResponse,
  UpstreamInventoryResponse,
} from '@/lib/api/types'

// Aggregate per-row ClickHouse data by week
function aggregatePOS(data: StoreSalesResponse) {
  const posMap = new Map<string, { demand: number; sales: number; lost: number }>()
  for (const r of data.weekly_pos) {
    const cur = posMap.get(r.pos_week) ?? { demand: 0, sales: 0, lost: 0 }
    posMap.set(r.pos_week, {
      demand: cur.demand + parseInt(r.demand_qty),
      sales: cur.sales + parseInt(r.sales_qty),
      lost: cur.lost + parseInt(r.lost_sales_qty),
    })
  }
  return [...posMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
    week,
    demand_qty: v.demand,
    sales_qty: v.sales,
    lost_sales_qty: v.lost,
  }))
}

function aggregateStoreInventory(data: StoreSalesResponse) {
  const map = new Map<string, { on_hand: number; available: number; on_order: number }>()
  for (const r of data.store_inventory) {
    const cur = map.get(r.inventory_week) ?? { on_hand: 0, available: 0, on_order: 0 }
    map.set(r.inventory_week, {
      on_hand: cur.on_hand + parseInt(r.on_hand_quantity),
      available: cur.available + parseInt(r.available_quantity),
      on_order: cur.on_order + parseInt(r.on_order_quantity),
    })
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
    week,
    on_hand: v.on_hand,
    available: v.available,
    on_order: v.on_order,
  }))
}

function aggregateShipments(data: SupplyChainSalesResponse) {
  const map = new Map<string, { ordered: number; shipped: number; fill_sum: number; fill_count: number }>()
  for (const r of data.weekly_shipments) {
    const cur = map.get(r.shipment_week) ?? { ordered: 0, shipped: 0, fill_sum: 0, fill_count: 0 }
    map.set(r.shipment_week, {
      ordered: cur.ordered + parseInt(r.ordered_qty),
      shipped: cur.shipped + parseInt(r.shipped_qty),
      fill_sum: cur.fill_sum + parseFloat(r.fill_rate),
      fill_count: cur.fill_count + 1,
    })
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({
    week,
    ordered_qty: v.ordered,
    shipped_qty: v.shipped,
    fill_rate: v.fill_count > 0 ? Math.round((v.fill_sum / v.fill_count) * 100) : 0,
  }))
}

function aggregateUpstream(data: UpstreamInventoryResponse) {
  const dcMap = new Map<string, number>()
  for (const r of data.dc_inventory) {
    dcMap.set(r.inventory_week, (dcMap.get(r.inventory_week) ?? 0) + parseInt(r.on_hand_quantity))
  }
  const supMap = new Map<string, number>()
  for (const r of data.supplier_dc_inventory) {
    supMap.set(r.inventory_week, (supMap.get(r.inventory_week) ?? 0) + parseInt(r.on_hand_quantity))
  }
  const weeks = [...new Set([...dcMap.keys(), ...supMap.keys()])].sort()
  return weeks.map(w => ({
    week: w,
    dc_inventory: dcMap.get(w) ?? 0,
    supplier_dc_inventory: supMap.get(w) ?? 0,
  }))
}

function kpiSummary(posRows: StoreSalesResponse['weekly_pos'], shipRows: SupplyChainSalesResponse['weekly_shipments']) {
  const totalSales = posRows.reduce((s, r) => s + parseInt(r.sales_qty), 0)
  const totalLost = posRows.reduce((s, r) => s + parseInt(r.lost_sales_qty), 0)
  const totalRevenue = posRows.reduce((s, r) => s + parseFloat(r.sales_amount), 0)
  const fillSum = shipRows.reduce((s, r) => s + parseFloat(r.fill_rate), 0)
  const fillRate = shipRows.length > 0 ? (fillSum / shipRows.length) * 100 : 0
  const stockoutRate = totalSales + totalLost > 0 ? (totalLost / (totalSales + totalLost)) * 100 : 0
  return { totalSales, totalRevenue, fillRate, stockoutRate }
}

function FilterSelect({
  value, onChange, options, placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: { id: string; label: string }[]
  placeholder: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="text-xs rounded-lg border border-charcoal-blue-200 bg-white px-2 py-1 text-charcoal-blue-700 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-400"
    >
      <option value="">{placeholder}</option>
      {options.map(o => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  )
}

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

type LoadState = 'loading' | 'polling' | 'ready' | 'error'

export default function SimulationResultsPage() {
  const params = useParams()
  const simulationId = params.runId as string

  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const [simulationName, setSimulationName] = useState('Simulation Results')
  const [activeTab, setActiveTab] = useState('dashboard')

  const [meta, setMeta] = useState<AnalyticsMeta | null>(null)
  const [posChartData, setPosChartData] = useState<ReturnType<typeof aggregatePOS>>([])
  const [storeInvChartData, setStoreInvChartData] = useState<ReturnType<typeof aggregateStoreInventory>>([])
  const [shipChartData, setShipChartData] = useState<ReturnType<typeof aggregateShipments>>([])
  const [upstreamChartData, setUpstreamChartData] = useState<ReturnType<typeof aggregateUpstream>>([])
  const [kpis, setKpis] = useState({ totalSales: 0, totalRevenue: 0, fillRate: 0, stockoutRate: 0 })

  const [posItemFilter, setPosItemFilter] = useState('')
  const [posStoreFilter, setPosStoreFilter] = useState('')
  const [posLoading, setPosLoading] = useState(false)

  const [shipItemFilter, setShipItemFilter] = useState('')
  const [shipDcFilter, setShipDcFilter] = useState('')
  const [shipLoading, setShipLoading] = useState(false)

  const [dcItemFilter, setDcItemFilter] = useState('')
  const [dcDcFilter, setDcDcFilter] = useState('')
  const [dcLoading, setDcLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout>

    const loadAnalytics = async () => {
      try {
        const [metaData, storeSales, supplyChain, upstream] = await Promise.all([
          getAnalyticsMeta(simulationId),
          getStoreSales(simulationId),
          getSupplyChainSales(simulationId),
          getUpstreamInventory(simulationId),
        ])
        if (cancelled) return
        setMeta(metaData)
        setPosChartData(aggregatePOS(storeSales))
        setStoreInvChartData(aggregateStoreInventory(storeSales))
        setShipChartData(aggregateShipments(supplyChain))
        setUpstreamChartData(aggregateUpstream(upstream))
        setKpis(kpiSummary(storeSales.weekly_pos, supplyChain.weekly_shipments))
        setLoadState('ready')
      } catch (err: unknown) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Failed to load analytics'
        setErrorMsg(msg)
        setLoadState('error')
      }
    }

    const checkStatus = async () => {
      try {
        const config = await getRunConfig(simulationId)
        setSimulationName(config.full_config ? String((config.full_config as Record<string, Record<string, unknown>>)?.run?.simulation_name ?? 'Simulation Results') : 'Simulation Results')
        if (config.status === 'COMPLETED') {
          await loadAnalytics()
        } else if (config.status === 'FAILED') {
          if (!cancelled) { setErrorMsg('Simulation failed.'); setLoadState('error') }
        } else {
          if (!cancelled) {
            setLoadState('polling')
            pollTimer = setTimeout(checkStatus, 4000)
          }
        }
      } catch (err: unknown) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Failed to check simulation status'
        setErrorMsg(msg)
        setLoadState('error')
      }
    }

    checkStatus()
    return () => { cancelled = true; clearTimeout(pollTimer) }
  }, [simulationId])

  useEffect(() => {
    if (loadState !== 'ready') return
    setPosLoading(true)
    getStoreSales(simulationId, {
      item_id: posItemFilter || undefined,
      store_id: posStoreFilter || undefined,
    }).then(data => {
      setPosChartData(aggregatePOS(data))
      setStoreInvChartData(aggregateStoreInventory(data))
    }).catch(() => {}).finally(() => setPosLoading(false))
  }, [posItemFilter, posStoreFilter, loadState, simulationId])

  useEffect(() => {
    if (loadState !== 'ready') return
    setShipLoading(true)
    getSupplyChainSales(simulationId, {
      item_id: shipItemFilter || undefined,
      retailer_dc_id: shipDcFilter || undefined,
    }).then(data => setShipChartData(aggregateShipments(data)))
      .catch(() => {}).finally(() => setShipLoading(false))
  }, [shipItemFilter, shipDcFilter, loadState, simulationId])

  useEffect(() => {
    if (loadState !== 'ready') return
    setDcLoading(true)
    getUpstreamInventory(simulationId, {
      item_id: dcItemFilter || undefined,
      dc_id: dcDcFilter || undefined,
    }).then(data => setUpstreamChartData(aggregateUpstream(data)))
      .catch(() => {}).finally(() => setDcLoading(false))
  }, [dcItemFilter, dcDcFilter, loadState, simulationId])

  if (loadState === 'loading' || loadState === 'polling') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 py-32">
        <Loader2 size={40} className="animate-spin text-majorelle-blue-500" />
        <p className="text-lg font-semibold text-charcoal-blue-600">
          {loadState === 'polling' ? 'Simulation is running…' : 'Loading results…'}
        </p>
        {loadState === 'polling' && (
          <p className="text-sm text-charcoal-blue-400">This page will update automatically when done.</p>
        )}
      </div>
    )
  }

  if (loadState === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 py-32">
        <AlertCircle size={40} className="text-rose-500" />
        <p className="text-lg font-semibold text-charcoal-blue-950">Failed to load results</p>
        <p className="text-sm text-charcoal-blue-400">{errorMsg}</p>
      </div>
    )
  }

  const itemOptions = (meta?.items_meta ?? []).map(i => ({ id: i.item_id, label: i.item_name }))
  const storeOptions = (meta?.stores_meta ?? []).map(s => ({ id: s.store_id, label: s.store_code }))
  const retailerDcOptions = (meta?.dcs_meta ?? [])
    .filter(d => d.dc_role !== 'SUPPLIER_DC')
    .map(d => ({ id: d.dc_id, label: d.dc_code }))

  return (
    <div className="w-full min-h-screen bg-gradient-to-br from-charcoal-blue-50 via-white to-charcoal-blue-50 px-4 py-4">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-4 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-4xl font-black tracking-tight text-charcoal-blue-950">{simulationName}</h1>
            {meta && (
              <p className="mt-2 text-base font-medium text-charcoal-blue-400">
                {meta.items_meta.length} items · {meta.stores_meta.length} stores · {meta.dcs_meta.length} DCs
              </p>
            )}
          </div>
          <button className="inline-flex items-center gap-2 whitespace-nowrap rounded-2xl bg-majorelle-blue-500 px-6 py-3 font-bold text-white transition-all duration-200 hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30 hover:-translate-y-0.5">
            <Download size={16} />
            Export
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-2 border-b border-charcoal-blue-200">
          {['dashboard', 'narrative'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
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
            <div className="mb-4 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <KPICard label="Total Sales (units)" value={kpis.totalSales.toLocaleString()} icon={ShoppingCart} color="bg-blue-500" />
              <KPICard label="Total Revenue" value={`$${(kpis.totalRevenue / 1000).toFixed(1)}K`} icon={Package} color="bg-emerald-500" />
              <KPICard label="Avg Fill Rate" value={`${kpis.fillRate.toFixed(1)}%`} icon={Truck} color="bg-majorelle-blue-500" />
              <KPICard label="Stockout Rate" value={`${kpis.stockoutRate.toFixed(1)}%`} icon={AlertCircle} color="bg-rose-500" />
            </div>

            <div className="mb-4 grid gap-4 grid-cols-1">
              {/* POS — Store Sales */}
              <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-bold text-charcoal-blue-950">POS — Store Sales</h3>
                    <p className="text-xs text-charcoal-blue-400">Weekly demand, sales and lost sales across all stores</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {posLoading && <Loader2 size={14} className="animate-spin text-charcoal-blue-400" />}
                    <FilterSelect value={posItemFilter} onChange={setPosItemFilter} options={itemOptions} placeholder="All Items" />
                    <FilterSelect value={posStoreFilter} onChange={setPosStoreFilter} options={storeOptions} placeholder="All Stores" />
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={420}>
                  <ComposedChart data={posChartData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" angle={-45} textAnchor="end" height={100} tick={{ fontSize: 10 }} />
                    <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => (v != null ? Number(v).toLocaleString() : '')} />
                    <Legend />
                    <Bar dataKey="demand_qty" fill="#8b5cf6" name="Demand" />
                    <Bar dataKey="lost_sales_qty" fill="#ef4444" name="Lost Sales" />
                    <Bar dataKey="sales_qty" fill="#10b981" name="Sales" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Store Inventory */}
              <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-bold text-charcoal-blue-950">Store Inventory</h3>
                    <p className="text-xs text-charcoal-blue-400">Weekly on-hand, available and on-order inventory at stores</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {posLoading && <Loader2 size={14} className="animate-spin text-charcoal-blue-400" />}
                    <FilterSelect value={posItemFilter} onChange={setPosItemFilter} options={itemOptions} placeholder="All Items" />
                    <FilterSelect value={posStoreFilter} onChange={setPosStoreFilter} options={storeOptions} placeholder="All Stores" />
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={420}>
                  <ComposedChart data={storeInvChartData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" angle={-45} textAnchor="end" height={100} tick={{ fontSize: 10 }} />
                    <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => (v != null ? Number(v).toLocaleString() : '')} />
                    <Legend />
                    <Line dataKey="available" stroke="#10b981" name="Available" type="monotone" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                    <Line dataKey="on_hand" stroke="#0ea5e9" name="On Hand" type="monotone" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                    <Line dataKey="on_order" stroke="#f59e0b" name="On Order" type="monotone" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Supply Chain Shipments */}
              <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-bold text-charcoal-blue-950">Supply Chain Shipments</h3>
                    <p className="text-xs text-charcoal-blue-400">Supplier DC → Retailer DC ordered vs shipped and fill rate</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {shipLoading && <Loader2 size={14} className="animate-spin text-charcoal-blue-400" />}
                    <FilterSelect value={shipItemFilter} onChange={setShipItemFilter} options={itemOptions} placeholder="All Items" />
                    <FilterSelect value={shipDcFilter} onChange={setShipDcFilter} options={retailerDcOptions} placeholder="All DCs" />
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={420}>
                  <ComposedChart data={shipChartData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" angle={-45} textAnchor="end" height={100} tick={{ fontSize: 10 }} />
                    <YAxis yAxisId="left" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tickFormatter={v => `${v}%`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v, name) => v != null ? (name === 'Fill Rate' ? `${Number(v)}%` : Number(v).toLocaleString()) : ''} />
                    <Legend />
                    <Bar yAxisId="left" dataKey="ordered_qty" fill="#3b82f6" name="Ordered" />
                    <Bar yAxisId="left" dataKey="shipped_qty" fill="#60a5fa" name="Shipped" />
                    <Line yAxisId="right" dataKey="fill_rate" stroke="#f59e0b" name="Fill Rate" type="monotone" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* DC Inventory */}
              <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-lg font-bold text-charcoal-blue-950">DC Inventory</h3>
                    <p className="text-xs text-charcoal-blue-400">Weekly on-hand inventory at Retailer DCs and Supplier DCs</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {dcLoading && <Loader2 size={14} className="animate-spin text-charcoal-blue-400" />}
                    <FilterSelect value={dcItemFilter} onChange={setDcItemFilter} options={itemOptions} placeholder="All Items" />
                    <FilterSelect value={dcDcFilter} onChange={setDcDcFilter} options={retailerDcOptions} placeholder="All DCs" />
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={420}>
                  <ComposedChart data={upstreamChartData} margin={{ top: 5, right: 20, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" angle={-45} textAnchor="end" height={100} tick={{ fontSize: 10 }} />
                    <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v) => (v != null ? Number(v).toLocaleString() : '')} />
                    <Legend />
                    <Line dataKey="dc_inventory" stroke="#6366f1" name="Retailer DC" type="monotone" strokeWidth={2} dot={false} />
                    <Line dataKey="supplier_dc_inventory" stroke="#ec4899" name="Supplier DC" type="monotone" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}

        {activeTab === 'narrative' && (
          <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-8 text-center shadow-sm">
            <TrendingUp size={48} className="mx-auto mb-4 text-charcoal-blue-300" />
            <h3 className="text-xl font-bold text-charcoal-blue-950">Guided Narrative</h3>
            <p className="mt-2 text-charcoal-blue-400">
              AI-generated story of your simulation will appear here.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
