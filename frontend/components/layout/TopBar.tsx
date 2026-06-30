'use client'

import { usePathname } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'

export function TopBar() {
  const pathname = usePathname()
  const { fullName, email } = useAuthStore()

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
        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-xs font-semibold text-charcoal-blue-950">{fullName || 'User'}</p>
            {email && <p className="text-[10px] text-charcoal-blue-400">{email}</p>}
          </div>
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-majorelle-blue-500 text-xs font-bold text-white">
            {(fullName || 'U')[0].toUpperCase()}
          </div>
        </div>
      </div>
    </header>
  )
}
