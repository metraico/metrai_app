'use client'

import { AlertCircle } from 'lucide-react'

export default function ScenarioPage() {
  return (
    <div className="w-full px-10 py-10">
      <div className="mx-auto max-w-5xl">
                {/* Header */}
                <div className="mb-10">
                  <h1 className="mb-3 text-4xl font-black tracking-tight text-charcoal-blue-950">
                    Scenario Setup
                  </h1>
                  <p className="text-base font-medium text-charcoal-blue-400">
                    Create and manage simulation scenarios
                  </p>
                </div>

                {/* Card */}
                <div className="rounded-2xl border border-charcoal-blue-200 bg-white p-8 shadow-sm">
                  {/* Card Header */}
                  <div className="mb-8 border-b border-charcoal-blue-200 pb-8">
                    <div className="mb-3 flex items-center gap-3">
                      <AlertCircle className="h-6 w-6 text-majorelle-blue-500" />
                      <h2 className="text-xl font-bold text-charcoal-blue-950">
                        Scenario Management
                      </h2>
                    </div>
                    <p className="text-sm font-medium text-charcoal-blue-400">
                      Define supplier disruptions, DC issues, and promotional windows
                    </p>
                  </div>

                  {/* Card Content */}
                  <div className="text-center">
                    <p className="mb-8 text-base font-medium text-charcoal-blue-400">
                      Scenario configuration interface coming soon
                    </p>
                    <button className="inline-flex items-center rounded-2xl border border-charcoal-blue-200 bg-white px-6 py-3 font-semibold text-charcoal-blue-950 transition-all duration-200 hover:bg-charcoal-blue-50 hover:border-majorelle-blue-500">
                      Create Scenario
                    </button>
                  </div>
                </div>
              </div>
    </div>
  )
}
