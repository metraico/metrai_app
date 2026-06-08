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
  ReferenceLine,
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
function aggregateStoreSales(data: StoreSalesResponse) {
  const posMap = new Map<string, { demand: number; sales: number; lost: number; revenue: number }>()
  for (const r of data.weekly_pos) {
    const cur = posMap.get(r.pos_week) ?? { demand: 0, sales: 0, lost: 0, revenue: 0 }
    posMap.set(r.pos_week, {
      demand: cur.demand + parseInt(r.demand_qty),
      sales: cur.sales + parseInt(r.sales_qty),
      lost: cur.lost + parseInt(r.lost_sales_qty),
      revenue: cur.revenue + parseFloat(r.sales_amount),
    })
  }
  const invMap = new Map<string, number>()
  for (const r of data.store_inventory) {
    invMap.set(r.inventory_week, (invMap.get(r.inventory_week) ?? 0) + parseInt(r.on_hand_quantity))
  }
  const weeks = [...new Set([...posMap.keys(), ...invMap.keys()])].sort()
  return weeks.map(w => ({
    week: w,
    demand_qty: posMap.get(w)?.demand ?? 0,
    sales_qty: posMap.get(w)?.sales ?? 0,
    lost_sales_qty: posMap.get(w)?.lost ?? 0,
    sales_amount: posMap.get(w)?.revenue ?? 0,
    store_inventory: invMap.get(w) ?? 0,
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
  const [posChartData, setPosChartData] = useState<ReturnType<typeof aggregateStoreSales>>([])
  const [shipChartData, setShipChartData] = useState<ReturnType<typeof aggregateShipments>>([])
  const [upstreamChartData, setUpstreamChartData] = useState<ReturnType<typeof aggregateUpstream>>([])
  const [kpis, setKpis] = useState({ totalSales: 0, totalRevenue: 0, fillRate: 0, stockoutRate: 0 })

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
        setPosChartData(aggregateStoreSales(storeSales))
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

  return (
    <div className="w-full min-h-screen bg-gradient-to-br from-charcoal-blue-50 via-white to-charcoal-blue-50 px-6 py-6">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
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
        <div className="mb-8 flex gap-2 border-b border-charcoal-blue-200">
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
            <div className="mb-8 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <KPICard label="Total Sales (units)" value={kpis.totalSales.toLocaleString()} icon={ShoppingCart} color="bg-blue-500" />
              <KPICard label="Total Revenue" value={`$${(kpis.totalRevenue / 1000).toFixed(1)}K`} icon={Package} color="bg-emerald-500" />
              <KPICard label="Avg Fill Rate" value={`${kpis.fillRate.toFixed(1)}%`} icon={Truck} color="bg-majorelle-blue-500" />
              <KPICard label="Stockout Rate" value={`${kpis.stockoutRate.toFixed(1)}%`} icon={AlertCircle} color="bg-rose-500" />
            </div>

            <div className="mb-8 grid gap-6 grid-cols-1 lg:grid-cols-2">
              {/* POS Chart */}
              <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
                <h3 className="mb-1 text-lg font-bold text-charcoal-blue-950">POS — Store Sales</h3>
                <p className="mb-4 text-xs text-charcoal-blue-400">Weekly demand, sales, and lost sales across all stores</p>
                <ResponsiveContainer width="100%" height={380}>
                  <ComposedChart data={posChartData} margin={{ top: 5, right: 30, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" angle={-45} textAnchor="end" height={100} tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="left" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                    <YAxis yAxisId="right" orientation="right" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v) => (v != null ? Number(v).toLocaleString() : '')} />
                    <Legend />
                    <Bar yAxisId="left" dataKey="demand_qty" fill="#8b5cf6" name="Demand" />
                    <Bar yAxisId="left" dataKey="sales_qty" fill="#10b981" name="Sales" />
                    <Bar yAxisId="left" dataKey="lost_sales_qty" fill="#ef4444" name="Lost Sales" />
                    <Line yAxisId="right" dataKey="store_inventory" stroke="#0ea5e9" name="Store Inventory" type="monotone" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>

              {/* Shipments Chart */}
              <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
                <h3 className="mb-1 text-lg font-bold text-charcoal-blue-950">Supply Chain Shipments</h3>
                <p className="mb-4 text-xs text-charcoal-blue-400">Supplier DC → Retailer DC ordered vs shipped with fill rate</p>
                <ResponsiveContainer width="100%" height={380}>
                  <ComposedChart data={shipChartData} margin={{ top: 5, right: 30, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" angle={-45} textAnchor="end" height={100} tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="left" tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                    <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tickFormatter={v => `${v}%`} />
                    <Tooltip formatter={(v, name) => v != null ? (name === 'Fill Rate %' ? `${Number(v)}%` : Number(v).toLocaleString()) : ''} />
                    <Legend />
                    <Bar yAxisId="left" dataKey="ordered_qty" fill="#3b82f6" name="Ordered" />
                    <Bar yAxisId="left" dataKey="shipped_qty" fill="#60a5fa" name="Shipped" />
                    <Line yAxisId="right" dataKey="fill_rate" stroke="#f59e0b" name="Fill Rate %" type="monotone" strokeWidth={2} dot={false} />
                    <ReferenceLine yAxisId="right" y={95} stroke="#d1d5db" strokeDasharray="5 5" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Upstream Inventory */}
            <div className="mb-8">
              <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm">
                <h3 className="mb-1 text-lg font-bold text-charcoal-blue-950">Upstream Inventory</h3>
                <p className="mb-4 text-xs text-charcoal-blue-400">Weekly on-hand inventory at Retailer DCs and Supplier DCs</p>
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={upstreamChartData} margin={{ top: 5, right: 30, left: 0, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="week" angle={-45} textAnchor="end" height={100} tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}K`} />
                    <Tooltip formatter={(v) => (v != null ? Number(v).toLocaleString() : '')} />
                    <Legend />
                    <Line dataKey="dc_inventory" stroke="#6366f1" name="Retailer DC Inventory" type="monotone" strokeWidth={2} dot={false} />
                    <Line dataKey="supplier_dc_inventory" stroke="#ec4899" name="Supplier DC Inventory" type="monotone" strokeWidth={2} dot={false} />
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
