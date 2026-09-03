'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { getScopedExtensions, createScopedExtension, deleteScopedExtension, getRunConfig } from '@/lib/api/simulation'
import { getPromoGroups } from '@/lib/api/promos'
import { getEntities } from '@/lib/api/entities'
import type { ScopedExtension, PromoGroupResponse, EntityItem } from '@/lib/api/types'
import {
  Plus, ChevronLeft, ChevronRight, Layers, Loader2, CheckCircle, XCircle, Search, X, Trash2,
} from 'lucide-react'
import { formatDateDisplay } from '@/lib/utils'
import { useBreadcrumb } from '@/lib/store/breadcrumbStore'

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

export default function ScopedExtensionsPage() {
  const params = useParams()
  const router = useRouter()
  const retailerAccountId = params.retailerAccountId as string
  const baseSimulationId = params.runId as string

  const [extensions, setExtensions] = useState<ScopedExtension[]>([])
  const [baseName, setBaseName] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const fetchExtensions = () => {
    setLoading(true)
    getScopedExtensions(baseSimulationId)
      .then(setExtensions)
      .catch(err => setError(err?.response?.data?.detail ?? 'Failed to load extensions'))
      .finally(() => setLoading(false))
  }

  const [scenarioType, setScenarioType] = useState('no_scenario')

  useEffect(() => {
    fetchExtensions()
    getRunConfig(baseSimulationId)
      .then(cfg => {
        setBaseName(String((cfg.full_config as any)?.simulation_name ?? (cfg.full_config as any)?.run?.simulation_name ?? 'Base simulation'))
        setScenarioType(String((cfg.full_config as any)?.scenario_type ?? 'no_scenario'))
      })
      .catch(() => null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSimulationId])

  useBreadcrumb(baseName ? [
    { label: 'Runs', href: `/retailers/${retailerAccountId}/runs?scenario=${scenarioType}` },
    { label: baseName, href: `/retailers/${retailerAccountId}/simulation/${baseSimulationId}` },
    { label: 'Extensions' },
  ] : null)

  const handleDelete = async (e: React.MouseEvent, childId: string) => {
    e.stopPropagation()
    if (!confirm('Delete this extension? This cannot be undone.')) return
    setDeleting(childId)
    try {
      await deleteScopedExtension(baseSimulationId, childId)
      setExtensions(prev => prev.filter(ext => ext.child_simulation_id !== childId))
    } catch { alert('Failed to delete extension.') }
    finally { setDeleting(null) }
  }

  return (
    <div className="w-full px-6 py-6">
      <div className="w-full">
        <button
          onClick={() => router.push(`/retailers/${retailerAccountId}/simulation/${baseSimulationId}`)}
          className="mb-4 inline-flex items-center gap-1 rounded-full border border-charcoal-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-charcoal-blue-500 shadow-sm transition-all hover:border-charcoal-blue-400 hover:text-charcoal-blue-800"
        >
          <ChevronLeft size={13} /> Back to simulation
        </button>

        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-majorelle-blue-50">
              <Layers size={20} className="text-majorelle-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-charcoal-blue-950">Extensions</h1>
              <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">
                Independent scoped rolling forecasts off <span className="font-bold text-charcoal-blue-600">{baseName || '…'}</span>
              </p>
            </div>
          </div>
          <button onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30">
            <Plus size={14} /> New extension
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
          </div>
        )}

        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">{error}</div>}

        {!loading && !error && extensions.length === 0 && (
          <div className="rounded-xl border border-charcoal-blue-200 bg-white p-12 text-center shadow-sm">
            <Layers size={36} className="mx-auto mb-3 text-majorelle-blue-300" />
            <h2 className="text-lg font-black text-charcoal-blue-950">No extensions yet</h2>
            <p className="mx-auto mt-2 max-w-sm text-xs text-charcoal-blue-400">
              Create a scoped extension to run a rolling forecast on just a promo group or a handful
              of items — far cheaper than re-simulating every item.
            </p>
            <button onClick={() => setShowModal(true)}
              className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600">
              <Plus size={13} /> New extension
            </button>
          </div>
        )}

        {!loading && !error && extensions.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {extensions.map(ext => (
              <div
                key={ext.child_simulation_id}
                onClick={() => ext.simulation_status === 'COMPLETED' && router.push(`/retailers/${retailerAccountId}/simulation/${ext.child_simulation_id}`)}
                className={`relative rounded-xl border border-charcoal-blue-200 bg-white p-4 shadow-sm transition-all duration-200 ${
                  ext.simulation_status === 'COMPLETED'
                    ? 'cursor-pointer hover:-translate-y-0.5 hover:border-majorelle-blue-500 hover:shadow-lg hover:shadow-majorelle-blue-500/15'
                    : 'cursor-default'
                }`}
              >
                <button
                  onClick={(e) => handleDelete(e, ext.child_simulation_id)}
                  disabled={deleting === ext.child_simulation_id}
                  className="absolute right-3 top-3 rounded-full p-1 text-charcoal-blue-300 transition hover:bg-rose-50 hover:text-rose-500"
                >
                  {deleting === ext.child_simulation_id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>

                <div className="mb-3 flex items-center gap-1.5 flex-wrap pr-5">
                  <span className={`inline-block rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[ext.simulation_status] ?? 'bg-charcoal-blue-100 text-charcoal-blue-600'}`}>
                    {STATUS_ICONS[ext.simulation_status]}
                    {ext.simulation_status}
                  </span>
                  <span className="inline-block rounded-full border border-majorelle-blue-200 bg-majorelle-blue-50 px-2 py-0.5 text-[9px] font-bold text-majorelle-blue-600">
                    {ext.scope_label} · {ext.item_count} item{ext.item_count === 1 ? '' : 's'}
                  </span>
                </div>

                <h3 className="mb-2 pr-5 text-sm font-black text-charcoal-blue-950">{ext.simulation_name || 'Untitled extension'}</h3>

                <div className="mb-3 border-b border-charcoal-blue-100 pb-3 space-y-0.5">
                  <p className="text-xs text-charcoal-blue-400">
                    <span className="font-bold text-charcoal-blue-700">Period:</span> {formatDateDisplay(ext.start_week ?? '')} → {formatDateDisplay(ext.end_week ?? '')}
                  </p>
                  {ext.created_at && (
                    <p className="text-xs text-charcoal-blue-400">
                      <span className="font-bold text-charcoal-blue-700">Created:</span> {formatDateDisplay(ext.created_at.slice(0, 10))}
                    </p>
                  )}
                </div>

                {ext.simulation_status === 'COMPLETED' && (
                  <div className="flex justify-end">
                    <span className="text-xs font-semibold text-majorelle-blue-500">Open →</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showModal && (
        <NewExtensionModal
          retailerAccountId={retailerAccountId}
          baseSimulationId={baseSimulationId}
          onClose={() => setShowModal(false)}
          onCreated={(childId) => router.push(`/retailers/${retailerAccountId}/simulation/${childId}`)}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// New-extension modal — pick a name and a scope (promo group or explicit item codes)
// ─────────────────────────────────────────────────────────────────────────────

function NewExtensionModal({
  retailerAccountId, baseSimulationId, onClose, onCreated,
}: {
  retailerAccountId: string
  baseSimulationId: string
  onClose: () => void
  onCreated: (childId: string) => void
}) {
  const [mode, setMode] = useState<'promo_group' | 'items'>('promo_group')
  const [name, setName] = useState('')
  const [groups, setGroups] = useState<PromoGroupResponse[]>([])
  const [groupSearch, setGroupSearch] = useState('')
  const [selectedGroup, setSelectedGroup] = useState<PromoGroupResponse | null>(null)
  const [itemCatalog, setItemCatalog] = useState<EntityItem[]>([])
  const [itemSearch, setItemSearch] = useState('')
  const [selectedItems, setSelectedItems] = useState<EntityItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getPromoGroups(retailerAccountId).then(setGroups).catch(() => setGroups([]))
    getEntities().then(r => setItemCatalog(r.items)).catch(() => setItemCatalog([]))
  }, [retailerAccountId])

  const filteredGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase()
    if (!q) return groups
    return groups.filter(g =>
      [g.promo_group_name, g.category, g.brand, g.description].filter(Boolean).some(v => v.toLowerCase().includes(q)))
  }, [groups, groupSearch])

  const selectedItemIds = useMemo(() => new Set(selectedItems.map(i => i.item_id)), [selectedItems])
  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase()
    return itemCatalog
      .filter(it => !selectedItemIds.has(it.item_id))
      .filter(it => !q || it.item_code.toLowerCase().includes(q) || it.item_description.toLowerCase().includes(q))
      .slice(0, 50)
  }, [itemCatalog, itemSearch, selectedItemIds])

  const itemCodes = useMemo(() => selectedItems.map(i => i.item_code), [selectedItems])

  const canSubmit = mode === 'promo_group' ? !!selectedGroup : itemCodes.length > 0

  // This only creates the scoped child — restricted to the chosen items and to the
  // stores/DCs/suppliers that actually carry them (see filter_static_to_scope on the
  // engine side). It's a plain "ready" simulation with no rolling-forecast session yet, so
  // it opens on its own dashboard with the normal "Rolling Forecast" button — the SAME
  // setup → promo/multiplier config → demand preview → "Run 4 Weeks" flow used on any base
  // simulation, just scoped down. No point reinventing that wizard here.
  const handleSubmit = async () => {
    if (!canSubmit || submitting) return
    setSubmitting(true); setErr(null)
    try {
      const scope = mode === 'promo_group'
        ? { promo_group_id: selectedGroup!.promo_group_id }
        : { item_codes: itemCodes }
      const defaultName = mode === 'promo_group'
        ? `${selectedGroup!.promo_group_name} extension`
        : `${itemCodes.length} item extension`
      const res = await createScopedExtension(baseSimulationId, {
        name: name.trim() || defaultName,
        scope,
      })
      onCreated(res.child_simulation_id)
    } catch (e: any) {
      setErr(e?.response?.data?.detail ?? 'Failed to create extension')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal-blue-950/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-black text-charcoal-blue-950">New extension</h2>
          <button onClick={onClose} className="rounded-full p-1 text-charcoal-blue-400 hover:bg-charcoal-blue-100">
            <X size={18} />
          </button>
        </div>

        <label className="mb-1 block text-xs font-bold text-charcoal-blue-700">Name</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Coke 2L +3 months"
          className="mb-4 w-full rounded-xl border border-charcoal-blue-200 px-3 py-2 text-sm text-charcoal-blue-950 placeholder:text-charcoal-blue-300 focus:border-majorelle-blue-500 focus:outline-none"
        />

        <div className="mb-3 inline-flex rounded-xl border border-charcoal-blue-200 p-0.5 text-xs font-bold">
          <button
            onClick={() => setMode('promo_group')}
            className={`rounded-lg px-3 py-1.5 ${mode === 'promo_group' ? 'bg-majorelle-blue-500 text-white' : 'text-charcoal-blue-500'}`}
          >Promo group</button>
          <button
            onClick={() => setMode('items')}
            className={`rounded-lg px-3 py-1.5 ${mode === 'items' ? 'bg-majorelle-blue-500 text-white' : 'text-charcoal-blue-500'}`}
          >Specific items</button>
        </div>

        {mode === 'promo_group' ? (
          <div>
            {selectedGroup ? (
              <div className="flex items-center justify-between rounded-xl border border-majorelle-blue-200 bg-majorelle-blue-50 px-3 py-2">
                <div>
                  <p className="text-sm font-bold text-charcoal-blue-900">{selectedGroup.promo_group_name}</p>
                  <p className="text-[11px] text-charcoal-blue-500">{selectedGroup.item_ids.length} items · {selectedGroup.brand || selectedGroup.category}</p>
                </div>
                <button onClick={() => setSelectedGroup(null)} className="text-xs font-bold text-majorelle-blue-600 hover:underline">Change</button>
              </div>
            ) : (
              <>
                <div className="relative mb-2">
                  <Search size={14} className="absolute left-3 top-2.5 text-charcoal-blue-300" />
                  <input
                    value={groupSearch}
                    onChange={e => setGroupSearch(e.target.value)}
                    placeholder="Search promo groups…"
                    className="w-full rounded-xl border border-charcoal-blue-200 py-2 pl-9 pr-3 text-sm focus:border-majorelle-blue-500 focus:outline-none"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto rounded-xl border border-charcoal-blue-100">
                  {filteredGroups.length === 0 && (
                    <p className="px-3 py-4 text-center text-xs text-charcoal-blue-400">No promo groups found</p>
                  )}
                  {filteredGroups.map(g => (
                    <button
                      key={g.promo_group_id}
                      onClick={() => setSelectedGroup(g)}
                      className="flex w-full items-center justify-between border-b border-charcoal-blue-50 px-3 py-2 text-left last:border-0 hover:bg-charcoal-blue-50"
                    >
                      <div>
                        <p className="text-sm font-semibold text-charcoal-blue-900">{g.promo_group_name}</p>
                        <p className="text-[11px] text-charcoal-blue-400">{[g.brand, g.category].filter(Boolean).join(' · ')}</p>
                      </div>
                      <span className="text-[11px] font-bold text-charcoal-blue-500">{g.item_ids.length} items</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-xs font-bold text-charcoal-blue-700">Items</label>
            {selectedItems.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {selectedItems.map(it => (
                  <span
                    key={it.item_id}
                    className="inline-flex items-center gap-1 rounded-full border border-majorelle-blue-200 bg-majorelle-blue-50 py-1 pl-2.5 pr-1.5 text-[11px] font-semibold text-majorelle-blue-700"
                  >
                    {it.item_description || it.item_code}
                    <button
                      onClick={() => setSelectedItems(prev => prev.filter(x => x.item_id !== it.item_id))}
                      className="rounded-full p-0.5 hover:bg-majorelle-blue-100"
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="relative mb-2">
              <Search size={14} className="absolute left-3 top-2.5 text-charcoal-blue-300" />
              <input
                value={itemSearch}
                onChange={e => setItemSearch(e.target.value)}
                placeholder="Search items by code or description…"
                className="w-full rounded-xl border border-charcoal-blue-200 py-2 pl-9 pr-3 text-sm focus:border-majorelle-blue-500 focus:outline-none"
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-xl border border-charcoal-blue-100">
              {filteredItems.length === 0 && (
                <p className="px-3 py-4 text-center text-xs text-charcoal-blue-400">
                  {itemCatalog.length === 0 ? 'Loading items…' : 'No items found'}
                </p>
              )}
              {filteredItems.map(it => (
                <button
                  key={it.item_id}
                  onClick={() => { setSelectedItems(prev => [...prev, it]); setItemSearch('') }}
                  className="flex w-full items-center justify-between border-b border-charcoal-blue-50 px-3 py-2 text-left last:border-0 hover:bg-charcoal-blue-50"
                >
                  <div>
                    <p className="text-sm font-semibold text-charcoal-blue-900">{it.item_description || it.item_code}</p>
                    <p className="text-[11px] text-charcoal-blue-400">{it.item_code}</p>
                  </div>
                  <Plus size={13} className="text-majorelle-blue-500 flex-shrink-0" />
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-charcoal-blue-400">{itemCodes.length} item{itemCodes.length === 1 ? '' : 's'} selected</p>
          </div>
        )}

        {err && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={submitting} className="rounded-xl px-4 py-2 text-xs font-bold text-charcoal-blue-500 hover:bg-charcoal-blue-100 disabled:opacity-50">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="inline-flex items-center gap-1.5 rounded-xl bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600 disabled:opacity-50"
          >
            {submitting ? <Loader2 size={13} className="animate-spin" /> : <ChevronRight size={13} />}
            {submitting ? 'Creating…' : 'Create & open'}
          </button>
        </div>
      </div>
    </div>
  )
}
