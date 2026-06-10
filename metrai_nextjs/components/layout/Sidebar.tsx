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
      logout().catch(() => {})
    }
    clearAuth()
    router.push('/login')
  }

  const navItems = [
    { label: 'Retailers', href: '/retailers', icon: Home, current: !retailerAccountId },
    retailerAccountId && { label: 'Runs', href: `/retailers/${retailerAccountId}/runs`, icon: BarChart3, current: params.section === 'runs' },
    retailerAccountId && { label: 'New Simulation', href: `/retailers/${retailerAccountId}/simulation/new`, icon: BarChart3, current: params.section === 'simulation' },
    retailerAccountId && { label: 'Scenario Setup', href: `/retailers/${retailerAccountId}/scenario`, icon: Settings, current: params.section === 'scenario' },
  ].filter(Boolean)

  return (
    <aside className="w-52 overflow-y-auto bg-gradient-to-b from-charcoal-blue-900 to-charcoal-blue-950 flex flex-col">
      {/* Logo */}
      <div className="flex h-[56px] flex-shrink-0 items-center gap-2.5 border-b border-white/10 px-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-majorelle-blue-500 to-majorelle-blue-700 text-sm font-bold text-white">
          M
        </div>
        <div>
          <h1 className="text-sm font-bold text-white leading-none">METRAI</h1>
          <p className="text-[10px] font-medium text-charcoal-blue-400 mt-0.5">Simulation</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-0.5 flex-1 overflow-y-auto px-2 py-4">
        {navItems.map((item: any) => {
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all duration-200 ${
                item.current
                  ? 'bg-majorelle-blue-500 text-white'
                  : 'text-charcoal-blue-300 hover:bg-majorelle-blue-500/15 hover:text-white'
              }`}
            >
              <Icon size={15} className="flex-shrink-0" />
              <span>{item.label}</span>
              {item.current && <div className="ml-auto h-1.5 w-1.5 rounded-full bg-white" />}
            </Link>
          )
        })}
      </nav>

      {/* User / Logout */}
      <div className="border-t border-white/10 px-3 py-3">
        <div className="mb-2 rounded-xl bg-majorelle-blue-500/15 px-3 py-2">
          <p className="mb-1 text-[9px] font-bold uppercase tracking-wide text-charcoal-blue-400">Signed In As</p>
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-majorelle-blue-500 text-xs font-bold text-white">
              {(fullName || 'U').charAt(0).toUpperCase()}
            </div>
            <p className="truncate text-xs font-medium text-white">{fullName || 'User'}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-charcoal-blue-400/30 px-3 py-1.5 text-xs font-semibold text-charcoal-blue-300 transition-all hover:border-red-500/50 hover:bg-red-500/15 hover:text-red-400"
        >
          <LogOut size={13} />
          Sign Out
        </button>
      </div>
    </aside>
  )
}
