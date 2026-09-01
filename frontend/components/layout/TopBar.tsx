'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { logout } from '@/lib/api/auth'
import { LogOut, ChevronDown } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'

export function TopBar() {
  const pathname = usePathname()
  const router = useRouter()
  const { fullName, email, refreshToken, clearAuth } = useAuthStore()

  const handleLogout = async () => {
    if (refreshToken) logout().catch(() => {})
    clearAuth()
    router.push('/login')
  }

  const getBreadcrumbs = () => {
    const segments = pathname.split('/').filter(Boolean)
    const crumbs = []
    if (segments[0] === 'retailers') {
      crumbs.push({ label: 'Retailers', href: '/retailers' })
      if (segments[1]) crumbs.push({ label: 'Account', href: `/retailers/${segments[1]}` })
      if (segments[2]) {
        const labels: Record<string, string> = { runs: 'Runs', simulation: 'Simulation', scenario: 'Scenario' }
        crumbs.push({ label: labels[segments[2]] || segments[2], href: '' })
      }
    }
    return crumbs
  }

  const crumbs = getBreadcrumbs()

  return (
    <header className="border-b border-charcoal-blue-200 bg-white">
      <div className="flex h-[56px] items-center justify-between px-5">
        <div className="flex items-center gap-1.5 text-xs">
          {crumbs.map((crumb, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              {idx > 0 && <span className="text-charcoal-blue-300">/</span>}
              {crumb.href
                ? <a href={crumb.href} className="font-medium text-majorelle-blue-500 hover:underline">{crumb.label}</a>
                : <span className="font-semibold text-charcoal-blue-950">{crumb.label}</span>}
            </div>
          ))}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <button className="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-charcoal-blue-50">
              <div className="hidden text-right sm:block">
                <p className="text-xs font-semibold text-charcoal-blue-950">{fullName || 'User'}</p>
                {email && <p className="text-[10px] text-charcoal-blue-400">{email}</p>}
              </div>
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-majorelle-blue-500 text-xs font-bold text-white">
                {(fullName || 'U')[0].toUpperCase()}
              </div>
              <ChevronDown
                size={14}
                className="text-charcoal-blue-400 transition-transform duration-200 group-data-[state=open]:rotate-180"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent>
            <div className="px-2.5 py-2">
              <p className="mb-1 text-[9px] font-bold uppercase tracking-wide text-charcoal-blue-400">Signed In As</p>
              <p className="truncate text-xs font-semibold text-charcoal-blue-950">{fullName || 'User'}</p>
              {email && <p className="truncate text-[10px] text-charcoal-blue-400">{email}</p>}
            </div>
            <div className="my-1 h-px bg-charcoal-blue-100" />
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold text-charcoal-blue-700 transition-colors hover:bg-red-50 hover:text-red-600"
            >
              <LogOut size={13} />
              Sign Out
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  )
}
