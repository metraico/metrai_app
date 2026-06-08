'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { getRetailers } from '@/lib/api/retailers'
import type { RetailerAccount } from '@/lib/api/types'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { ArrowRight, Building2, Plus, Calendar, Users } from 'lucide-react'

export default function RetailersPage() {
  const router = useRouter()
  const { setAuth } = useAuthStore()
  const [accounts, setAccounts] = useState<RetailerAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getRetailers()
      .then(setAccounts)
      .catch(err => setError(err?.response?.data?.detail ?? 'Failed to load accounts'))
      .finally(() => setLoading(false))
  }, [])

  const handleSelectAccount = (account: RetailerAccount) => {
    setAuth({ retailerAccountId: account.retailer_account_id })
    router.push(`/retailers/${account.retailer_account_id}/runs`)
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar />
          <main className="flex-1 overflow-y-auto bg-gradient-to-br from-charcoal-blue-50 via-majorelle-blue-50 to-charcoal-blue-50">
            <div className="w-full px-10 py-10">
              <div className="mx-auto max-w-7xl">
                {/* Header */}
                <div className="mb-10 flex items-center justify-between gap-8">
                  <div className="flex-1">
                    <h1 className="mb-3 text-4xl font-black tracking-tight text-charcoal-blue-950">
                      Retailer Accounts
                    </h1>
                    <p className="text-base font-medium text-charcoal-blue-400">
                      Manage and access your retailer accounts for simulation management
                    </p>
                  </div>
                  <button
                    onClick={() => alert('Create account feature coming soon')}
                    className="inline-flex items-center gap-2 whitespace-nowrap rounded-2xl bg-majorelle-blue-500 px-7 py-3 font-bold text-white transition-all duration-200 hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30 hover:-translate-y-0.5"
                  >
                    <Plus size={20} />
                    New Account
                  </button>
                </div>

                {/* States */}
                {loading && (
                  <div className="flex items-center justify-center py-24">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-majorelle-blue-500 border-t-transparent" />
                  </div>
                )}

                {error && (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-700">
                    {error}
                  </div>
                )}

                {!loading && !error && accounts.length === 0 && (
                  <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-20 text-center shadow-sm">
                    <Building2 size={48} className="mx-auto mb-4 text-charcoal-blue-300" />
                    <h2 className="text-2xl font-black text-charcoal-blue-950">No accounts yet</h2>
                    <p className="mx-auto mt-3 max-w-xs text-base text-charcoal-blue-400">
                      Create your first retailer account to start running simulations.
                    </p>
                  </div>
                )}

                {/* Accounts Grid */}
                {!loading && !error && accounts.length > 0 && (
                  <div className="grid gap-8 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
                    {accounts.map((account) => (
                      <div
                        key={account.retailer_account_id}
                        onClick={() => handleSelectAccount(account)}
                        className="cursor-pointer rounded-2xl border border-charcoal-blue-200 bg-white p-8 shadow-sm transition-all duration-300 hover:-translate-y-2 hover:border-majorelle-blue-500 hover:shadow-2xl hover:shadow-majorelle-blue-500/20"
                      >
                        {/* Card Header */}
                        <div className="mb-7 flex gap-5">
                          <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-majorelle-blue-500 to-majorelle-blue-700 text-white shadow-md">
                            <Building2 size={32} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="mb-2 text-lg font-black tracking-tight text-charcoal-blue-950">
                              {account.retailer_account_name}
                            </h3>
                            <p className="text-sm font-medium text-charcoal-blue-400">
                              {account.retailer_account_code}
                            </p>
                          </div>
                        </div>

                        {/* Card Info */}
                        <div className="mb-7 grid grid-cols-2 gap-6 border-b border-charcoal-blue-200 pb-7">
                          <div>
                            <div className="mb-2 flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-charcoal-blue-400">
                              <Calendar size={14} />
                              <span>Joined</span>
                            </div>
                            <p className="text-sm font-semibold text-charcoal-blue-950">
                              {new Date(account.joined_at).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })}
                            </p>
                          </div>
                          <div>
                            <div className="mb-2 flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-charcoal-blue-400">
                              <Users size={14} />
                              <span>Status</span>
                            </div>
                            <p className="flex items-center gap-2 text-sm font-semibold text-emerald-600">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                              {account.is_active ? 'Active' : 'Inactive'}
                            </p>
                          </div>
                        </div>

                        {/* Card Footer */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleSelectAccount(account)
                          }}
                          className="w-full rounded-2xl bg-majorelle-blue-50 px-4 py-3 text-sm font-semibold text-majorelle-blue-500 transition-all duration-200 hover:bg-majorelle-blue-500 hover:text-white"
                        >
                          <div className="flex items-center justify-center gap-2">
                            View Account
                            <ArrowRight size={18} />
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
