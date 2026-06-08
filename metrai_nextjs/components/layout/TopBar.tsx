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
      if (segments[1]) {
        crumbs.push({ label: 'Account', href: `/retailers/${segments[1]}` })
      }
      if (segments[2]) {
        const sectionLabels: Record<string, string> = {
          runs: 'Simulation Runs',
          simulation: 'Simulation',
          scenario: 'Scenario Setup',
        }
        crumbs.push({
          label: sectionLabels[segments[2]] || segments[2],
          href: ``,
        })
      }
    }

    return crumbs
  }

  const crumbs = getBreadcrumbs()

  return (
    <header className="border-b border-charcoal-blue-200 bg-white shadow-sm">
      <div className="flex items-center justify-between px-6 py-4">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-2 text-sm">
          {crumbs.map((crumb, idx) => (
            <div key={idx} className="flex items-center gap-2">
              {idx > 0 && <span className="text-charcoal-blue-300">/</span>}
              {crumb.href ? (
                <a
                  href={crumb.href}
                  className="font-medium text-majorelle-blue-500 transition-all duration-200 hover:underline"
                >
                  {crumb.label}
                </a>
              ) : (
                <span className="font-semibold text-charcoal-blue-950">
                  {crumb.label}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* User Info */}
        <div className="flex items-center gap-4">
          <div className="hidden text-right text-sm sm:block">
            <p className="font-semibold text-charcoal-blue-950">
              {fullName || 'User'}
            </p>
            <p className="text-xs text-charcoal-blue-400">{email || ''}</p>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-majorelle-blue-500 text-base font-bold text-white shadow-md">
            {(fullName || 'U')[0].toUpperCase()}
          </div>
        </div>
      </div>
    </header>
  )
}
