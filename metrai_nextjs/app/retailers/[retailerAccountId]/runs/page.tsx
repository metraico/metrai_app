'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getRuns, deleteSimulation } from '@/lib/api/simulation'
import type { SimulationRun } from '@/lib/api/types'
import { Plus, Zap, Trash2 } from 'lucide-react'

const STATUS_STYLES: Record<string, string> = {
  COMPLETED: 'bg-green-100 text-green-700',
  RUNNING: 'bg-yellow-100 text-yellow-700',
  FAILED: 'bg-rose-100 text-rose-700',
}

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: '✓ Completed',
  RUNNING: '⟳ Running',
  FAILED: '✗ Failed',
}

export default function RunsPage() {
  const params = useParams()
  const router = useRouter()
  const retailerAccountId = params.retailerAccountId as string

  const [runs, setRuns] = useState<SimulationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const fetchRuns = () => {
    setLoading(true)
    getRuns(retailerAccountId)
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
    } catch {
      alert('Failed to delete simulation.')
    } finally {
      setDeleting(null)
    }
  }

  const handleNewSimulation = () => {
    router.push(`/retailers/${retailerAccountId}/simulation/new`)
  }

  return (
    <div className="w-full px-6 py-6">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-8 flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-4xl font-black tracking-tight text-charcoal-blue-950">
              Simulation Runs
            </h1>
            <p className="mt-2 text-base font-medium text-charcoal-blue-400">
              View and manage your simulation runs
            </p>
          </div>
          <button
            onClick={handleNewSimulation}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-2xl bg-majorelle-blue-500 px-6 py-3 font-bold text-white transition-all duration-200 hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30 hover:-translate-y-0.5"
          >
            <Plus size={20} />
            New Simulation
          </button>
        </div>

        {/* States */}
        {loading && (
          <div className="flex items-center justify-center py-24">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-majorelle-blue-500 border-t-transparent" />
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-700">{error}</div>
        )}

        {!loading && !error && runs.length === 0 && (
          <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-20 text-center shadow-sm">
            <div className="mb-4 text-5xl">⚡</div>
            <h2 className="text-2xl font-black text-charcoal-blue-950">No simulation runs yet</h2>
            <p className="mx-auto mt-3 max-w-xs text-base text-charcoal-blue-400">
              Create your first simulation to analyse supply chain performance and forecast demand.
            </p>
            <button
              onClick={handleNewSimulation}
              className="mt-8 inline-flex items-center gap-2 rounded-2xl bg-majorelle-blue-500 px-7 py-3 font-bold text-white transition-all duration-200 hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30 hover:-translate-y-0.5"
            >
              <Zap size={18} />
              Create First Simulation
            </button>
          </div>
        )}

        {!loading && !error && runs.length > 0 && (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {runs.map((run) => (
              <div
                key={run.simulation_id}
                onClick={() =>
                  run.simulation_status === 'COMPLETED' &&
                  router.push(`/retailers/${retailerAccountId}/simulation/${run.simulation_id}`)
                }
                className={`relative rounded-2xl border border-charcoal-blue-200 bg-white p-6 shadow-sm transition-all duration-300 ${
                  run.simulation_status === 'COMPLETED'
                    ? 'cursor-pointer hover:-translate-y-1.5 hover:border-majorelle-blue-500 hover:shadow-2xl hover:shadow-majorelle-blue-500/20'
                    : 'cursor-default'
                }`}
              >
                {/* Delete button */}
                <button
                  onClick={(e) => handleDelete(e, run.simulation_id)}
                  disabled={deleting === run.simulation_id}
                  className="absolute right-4 top-4 rounded-xl p-1.5 text-charcoal-blue-300 transition hover:bg-rose-50 hover:text-rose-500"
                >
                  <Trash2 size={16} />
                </button>

                {/* Status Badge */}
                <div className="mb-4">
                  <span
                    className={`inline-block rounded-2xl px-3 py-1.5 text-xs font-bold uppercase tracking-wide ${
                      STATUS_STYLES[run.simulation_status] ?? 'bg-charcoal-blue-100 text-charcoal-blue-600'
                    }`}
                  >
                    {STATUS_LABELS[run.simulation_status] ?? run.simulation_status}
                  </span>
                </div>

                <h3 className="mb-3 pr-6 text-lg font-black text-charcoal-blue-950">
                  {run.simulation_name}
                </h3>

                <div className="mb-4 border-b border-charcoal-blue-200 pb-4">
                  <p className="mb-1 text-sm font-medium text-charcoal-blue-400">
                    <span className="font-bold text-charcoal-blue-950">Period:</span>{' '}
                    {run.start_week} → {run.end_week}
                  </p>
                  <p className="text-sm font-medium text-charcoal-blue-400">
                    <span className="font-bold text-charcoal-blue-950">Created:</span>{' '}
                    {new Date(run.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-charcoal-blue-400">
                    Seed:{' '}
                    <span className="font-bold text-majorelle-blue-500">{run.random_seed}</span>
                  </span>
                  {run.simulation_status === 'COMPLETED' && (
                    <span className="text-2xl">→</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
