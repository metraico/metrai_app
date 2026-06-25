'use client'

import React, { useEffect, useState, Suspense } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { getRuns, deleteSimulation } from '@/lib/api/simulation'
import type { SimulationRun } from '@/lib/api/types'
import { useAuthStore } from '@/lib/store/authStore'
import { Plus, Zap, Trash2, CheckCircle, Loader2, XCircle, ChevronLeft } from 'lucide-react'
import { getScenario, NO_SCENARIO } from '@/lib/scenarios'

const STATUS_STYLES: Record<string, string> = {
  COMPLETED: 'bg-emerald-100 text-emerald-700',
  RUNNING: 'bg-yellow-100 text-yellow-700',
  FAILED: 'bg-rose-100 text-rose-700',
}
const STATUS_ICONS: Record<string, React.ReactNode> = {
  COMPLETED: <CheckCircle size={11} className="inline-block mr-1" />,
  RUNNING: <Loader2 size={11} className="inline-block mr-1 animate-spin" />,
  FAILED: <XCircle size={11} className="inline-block mr-1" />,
}
const STATUS_LABELS: Record<string, string> = {
  COMPLETED: 'Completed', RUNNING: 'Running', FAILED: 'Failed',
}

function RunsPageInner() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const retailerAccountId = params.retailerAccountId as string
  const userId = useAuthStore(s => s.userId)

  const scenarioId = searchParams.get('scenario') ?? 'no_scenario'
  const scenario = getScenario(scenarioId) ?? NO_SCENARIO

  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const fetchRuns = () => {
    if (!retailerAccountId || !userId) return
    setLoading(true)
    getRuns(retailerAccountId, userId, scenarioId)
      .then(setRuns)
      .catch(err => setError(err?.response?.data?.detail ?? 'Failed to load runs'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchRuns() }, [retailerAccountId])

  const handleDelete = async (e: React.MouseEvent, simulationId: string) => {
    e.stopPropagation()
    if (!confirm('Delete this simulation? This cannot be undone.')) return
    setDeleting(simulationId)
    try {
      await deleteSimulation(simulationId)
      setRuns(prev => prev.filter(r => r.simulation_id !== simulationId))
    } catch { alert('Failed to delete simulation.') }
    finally { setDeleting(null) }
  }

  const handleNew = () => {
    const dest = `/retailers/${retailerAccountId}/simulation/new`
    router.push(scenarioId && scenarioId !== 'no_scenario' ? `${dest}?scenario=${scenarioId}` : dest)
  }
  const Icon = scenario.icon

  return (
    <div className="w-full px-6 py-6">
      <div className="w-full">

        {/* Back + scenario header */}
        <button
          onClick={() => router.push(`/retailers/${retailerAccountId}`)}
          className="mb-4 inline-flex items-center gap-1 rounded-full border border-charcoal-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-charcoal-blue-500 shadow-sm transition-all hover:border-charcoal-blue-400 hover:text-charcoal-blue-800"
        >
          <ChevronLeft size={13} /> All Scenarios
        </button>

        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-majorelle-blue-50">
              <Icon size={20} className="text-majorelle-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-charcoal-blue-950">{scenario.title}</h1>
              <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">{scenario.question}</p>
            </div>
          </div>
          <button onClick={handleNew}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30">
            <Plus size={14} /> New Simulation
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
          </div>
        )}

        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">{error}</div>}

        {!loading && !error && runs.length === 0 && (
          <div className="rounded-xl border border-charcoal-blue-200 bg-white p-12 text-center shadow-sm">
            <Zap size={36} className="mx-auto mb-3 text-majorelle-blue-300" />
            <h2 className="text-lg font-black text-charcoal-blue-950">No simulation runs yet</h2>
            <p className="mx-auto mt-2 max-w-xs text-xs text-charcoal-blue-400">
              Create your first simulation to analyse supply chain performance.
            </p>
            <button onClick={handleNew}
              className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600">
              <Zap size={13} /> Create First Simulation
            </button>
          </div>
        )}

        {!loading && !error && runs.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {runs.map((run) => (
              <div
                key={run.simulation_id}
                onClick={() => run.simulation_status === 'COMPLETED' && router.push(`/retailers/${retailerAccountId}/simulation/${run.simulation_id}`)}
                className={`relative rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm transition-all duration-200 ${
                  run.simulation_status === 'COMPLETED'
                    ? 'cursor-pointer hover:-translate-y-0.5 hover:border-majorelle-blue-500 hover:shadow-lg hover:shadow-majorelle-blue-500/15'
                    : 'cursor-default'
                }`}
              >
                <button
                  onClick={(e) => handleDelete(e, run.simulation_id)}
                  disabled={deleting === run.simulation_id}
                  className="absolute right-3 top-3 rounded-full p-1 text-charcoal-blue-300 transition hover:bg-rose-50 hover:text-rose-500"
                >
                  <Trash2 size={13} />
                </button>

                <div className="mb-3 flex items-center gap-1.5 flex-wrap">
                  <span className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[run.simulation_status] ?? 'bg-charcoal-blue-100 text-charcoal-blue-600'}`}>
                    {STATUS_ICONS[run.simulation_status]}
                    {STATUS_LABELS[run.simulation_status] ?? run.simulation_status}
                  </span>
                  {run.is_extended && (
                    <span className="inline-block rounded-full border border-majorelle-blue-200 bg-majorelle-blue-50 px-2 py-0.5 text-[9px] font-bold text-majorelle-blue-600">
                      Extended ×{run.extension_count}
                    </span>
                  )}
                </div>

                <h3 className="mb-2 pr-5 text-sm font-black text-charcoal-blue-950">{run.simulation_name}</h3>

                <div className="mb-3 border-b border-charcoal-blue-100 pb-3 space-y-0.5">
                  <p className="text-xs text-charcoal-blue-400">
                    <span className="font-bold text-charcoal-blue-700">Period:</span> {run.start_week} → {run.end_week}
                  </p>
                  <p className="text-xs text-charcoal-blue-400">
                    <span className="font-bold text-charcoal-blue-700">Created:</span>{' '}
                    {new Date(run.created_at).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }).replace(/\//g, '-')}
                  </p>
                </div>

                {run.simulation_status === 'COMPLETED' && (
                  <div className="flex justify-end">
                    <span className="text-xs font-semibold text-majorelle-blue-500">View →</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function RunsPage() {
  return (
    <Suspense>
      <RunsPageInner />
    </Suspense>
  )
}
