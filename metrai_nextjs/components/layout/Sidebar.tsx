'use client'

import Link from 'next/link'
import { useRouter, useParams } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { logout } from '@/lib/api/auth'
import { LogOut, Home, BarChart3, Settings } from 'lucide-react'

export function Sidebar() {
  const router = useRouter()
  const params = useParams()
  const { clearAuth, fullName, refreshToken } = useAuthStore()
  const retailerAccountId = params.retailerAccountId as string

  const handleLogout = async () => {
    if (refreshToken) {
      logout({ refresh_token: refreshToken }).catch(() => {})
    }
    clearAuth()
    router.push('/login')
  }

  const navItems = [
    {
      label: 'Retailers',
      href: '/retailers',
      icon: Home,
      current: !retailerAccountId,
    },
    retailerAccountId && {
      label: 'Runs',
      href: `/retailers/${retailerAccountId}/runs`,
      icon: BarChart3,
      current: params.section === 'runs',
    },
    retailerAccountId && {
      label: 'New Simulation',
      href: `/retailers/${retailerAccountId}/simulation/new`,
      icon: BarChart3,
      current: params.section === 'simulation',
    },
    retailerAccountId && {
      label: 'Scenario Setup',
      href: `/retailers/${retailerAccountId}/scenario`,
      icon: Settings,
      current: params.section === 'scenario',
    },
  ].filter(Boolean)

  return (
    <aside className="w-64 overflow-y-auto bg-gradient-to-b from-charcoal-blue-900 to-charcoal-blue-950 flex flex-col">
      {/* Logo/Brand */}
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-6">
        <div className="flex flex-1 items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-majorelle-blue-500 to-majorelle-blue-700 text-base font-bold text-white shadow-lg">
            M
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">METRAI</h1>
            <p className="text-xs font-medium text-charcoal-blue-400">Simulation</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-1 flex-1 overflow-y-auto px-3 py-8">
        {navItems.map((item: any) => {
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ${
                item.current
                  ? 'bg-majorelle-blue-500 text-white'
                  : 'text-charcoal-blue-300 hover:bg-majorelle-blue-500/15 hover:text-white'
              }`}
            >
              <Icon size={20} className="flex-shrink-0" />
              <span>{item.label}</span>
              {item.current && (
                <div className="ml-auto h-2 w-2 rounded-full bg-white" />
              )}
            </Link>
          )
        })}
      </nav>

      {/* User Info & Logout */}
      <div className="border-t border-white/10 px-4 py-6">
        <div className="mb-4 rounded-2xl bg-majorelle-blue-500/15 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-charcoal-blue-400">
            Signed In As
          </p>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-2xl bg-majorelle-blue-500 text-sm font-bold text-white">
              {(fullName || 'U').charAt(0).toUpperCase()}
            </div>
            <p className="truncate text-sm font-medium text-white">
              {fullName || 'User'}
            </p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-charcoal-blue-400/30 bg-transparent px-4 py-2 text-sm font-semibold text-charcoal-blue-300 transition-all duration-200 hover:border-red-500/50 hover:bg-red-500/15 hover:text-red-400"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  )
}
