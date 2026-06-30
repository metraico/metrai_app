'use client'

import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'

export default function RetailerLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar on left - full height */}
      <Sidebar />

      {/* Right side - TopBar and Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-gradient-to-br from-charcoal-blue-50 via-charcoal-blue-50 to-white">
          {children}
        </main>
      </div>
    </div>
  )
}
