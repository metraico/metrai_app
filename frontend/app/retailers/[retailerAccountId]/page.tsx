'use client'

import { useParams, useRouter } from 'next/navigation'
import { SCENARIOS, NO_SCENARIO } from '@/lib/scenarios'

export default function RetailerLandingPage() {
  const params = useParams()
  const router = useRouter()
  const retailerAccountId = params.retailerAccountId as string

  const allCards = [
    ...SCENARIOS.map((s, i) => ({ ...s, index: i + 1, total: SCENARIOS.length + 1, isPlain: false })),
    { ...NO_SCENARIO, index: SCENARIOS.length + 1, total: SCENARIOS.length + 1, isPlain: true },
  ]

  return (
    <div className="w-full px-6 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-charcoal-blue-950">Select a Scenario</h1>
        <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">
          Select a scenario to view its runs
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {allCards.map((card) => {
          const Icon = card.icon
          const { isPlain } = card
          const isReady = isPlain || card.id === 'promo_forecast' || card.id === 'hidden_lost_sales'

          return (
            <div
              key={card.id}
              onClick={() => isReady && router.push(`/retailers/${retailerAccountId}/runs?scenario=${card.id}`)}
              className={`group relative overflow-hidden rounded-xl border bg-white text-left shadow-sm transition-all duration-200 ${
                isReady
                  ? 'cursor-pointer hover:-translate-y-0.5 hover:border-majorelle-blue-400 hover:shadow-lg hover:shadow-majorelle-blue-500/15'
                  : 'cursor-default opacity-70'
              }`}
            >
              {/* Top accent bar — same colour for all cards */}
              <div className="h-1 w-full bg-majorelle-blue-400" />

              <div className="p-4">
                {/* Icon + badge row */}
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-majorelle-blue-50">
                    <Icon size={18} className="text-majorelle-blue-500" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full border border-majorelle-blue-200 px-2 py-0.5 text-[10px] font-semibold text-majorelle-blue-400">
                      {card.badge}
                    </span>
                    <span className="text-[10px] font-semibold text-charcoal-blue-300">
                      {card.index}/{card.total}
                    </span>
                  </div>
                </div>

                {/* Title + question */}
                <h3 className="mb-1.5 text-sm font-black text-charcoal-blue-950">{card.title}</h3>
                <p className="mb-4 text-xs leading-relaxed text-charcoal-blue-500">{card.question}</p>

                {/* CTA */}
                {isReady ? (
                  <span className="text-xs font-semibold text-majorelle-blue-500 group-hover:text-majorelle-blue-700 transition-all">
                    View runs →
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-charcoal-blue-50 px-2.5 py-1 text-[10px] font-semibold text-charcoal-blue-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    Coming soon
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
