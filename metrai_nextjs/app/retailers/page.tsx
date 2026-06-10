'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { getRetailers, switchAccount } from '@/lib/api/retailers'
import type { RetailerAccount } from '@/lib/api/types'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { ArrowRight, Building2, Plus, Calendar, Users, Loader2 } from 'lucide-react'

export default function RetailersPage() {
  const router = useRouter()
  const { setAuth } = useAuthStore()
  const [accounts, setAccounts] = useState<RetailerAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  useEffect(() => {
    getRetailers()
      .then(setAccounts)
      .catch(err => setError(err?.response?.data?.detail ?? 'Failed to load accounts'))
      .finally(() => setLoading(false))
  }, [])

  const handleSelectAccount = async (account: RetailerAccount) => {
    setSwitching(account.retailer_account_id)
    try {
      const data = await switchAccount(account.retailer_account_id)
      setAuth({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        retailerAccountId: data.retailer_account_id,
      })
      router.push(`/retailers/${account.retailer_account_id}`)
    } catch {
      // Fallback: update local state only if switch-account fails
      setAuth({ retailerAccountId: account.retailer_account_id })
      router.push(`/retailers/${account.retailer_account_id}`)
    } finally {
      setSwitching(null)
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar />
          <main className="flex-1 overflow-y-auto bg-charcoal-blue-50">
            <div className="w-full px-6 py-6">
              <div className="w-full">
                {/* Header */}
                <div className="mb-6 flex items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-black tracking-tight text-charcoal-blue-950">Retailer Accounts</h1>
                    <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">
                      Manage and access your retailer accounts for simulation management
                    </p>
                  </div>
                  <button
                    onClick={() => alert('Create account feature coming soon')}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-majorelle-blue-500 px-4 py-2 text-xs font-bold text-white transition-all hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30"
                  >
                    <Plus size={14} />
                    New Account
                  </button>
                </div>

                {loading && (
                  <div className="flex items-center justify-center py-16">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-majorelle-blue-500 border-t-transparent" />
                  </div>
                )}

                {error && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">{error}</div>
                )}

                {!loading && !error && accounts.length === 0 && (
                  <div className="rounded-xl border border-charcoal-blue-200 bg-white p-12 text-center shadow-sm">
                    <Building2 size={36} className="mx-auto mb-3 text-charcoal-blue-300" />
                    <h2 className="text-lg font-black text-charcoal-blue-950">No accounts yet</h2>
                    <p className="mx-auto mt-2 max-w-xs text-xs text-charcoal-blue-400">
                      Create your first retailer account to start running simulations.
                    </p>
                  </div>
                )}

                {!loading && !error && accounts.length > 0 && (
                  <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
                    {accounts.map((account) => (
                      <div
                        key={account.retailer_account_id}
                        onClick={() => handleSelectAccount(account)}
                        className="cursor-pointer rounded-xl border border-charcoal-blue-200 bg-white p-5 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-majorelle-blue-500 hover:shadow-lg hover:shadow-majorelle-blue-500/15"
                      >
                        <div className="mb-4 flex gap-3">
                          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-majorelle-blue-500 to-majorelle-blue-700 text-white shadow-sm">
                            <Building2 size={20} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-black tracking-tight text-charcoal-blue-950">
                              {account.retailer_account_name}
                            </h3>
                            <p className="text-xs font-medium text-charcoal-blue-400">{account.retailer_account_code}</p>
                          </div>
                        </div>

                        <div className="mb-4 grid grid-cols-2 gap-3 border-b border-charcoal-blue-100 pb-4">
                          <div>
                            <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-charcoal-blue-400">
                              <Calendar size={11} /><span>Joined</span>
                            </div>
                            <p className="text-xs font-semibold text-charcoal-blue-950">
                              {new Date(account.joined_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </p>
                          </div>
                          <div>
                            <div className="mb-1 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-charcoal-blue-400">
                              <Users size={11} /><span>Status</span>
                            </div>
                            <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              {account.is_active ? 'Active' : 'Inactive'}
                            </p>
                          </div>
                        </div>

                        <button
                          onClick={(e) => { e.stopPropagation(); handleSelectAccount(account) }}
                          disabled={switching === account.retailer_account_id}
                          className="w-full rounded-xl bg-majorelle-blue-50 px-3 py-2 text-xs font-semibold text-majorelle-blue-500 transition-all hover:bg-majorelle-blue-500 hover:text-white disabled:opacity-60"
                        >
                          <div className="flex items-center justify-center gap-1.5">
                            {switching === account.retailer_account_id
                              ? <><Loader2 size={13} className="animate-spin" /> Switching…</>
                              : <><span>View Account</span><ArrowRight size={14} /></>}
                          </div>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
