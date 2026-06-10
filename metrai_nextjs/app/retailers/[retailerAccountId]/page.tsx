'use client'

import { useParams, useRouter } from 'next/navigation'
import { TrendingUp, AlertTriangle, BarChart2, Clock, PlayCircle } from 'lucide-react'

const SCENARIOS = [
  {
    id: 'promo_forecast',
    title: 'Promo Forecast Behavior',
    question: 'Does the system distinguish an execution failure from a demand decline?',
    badge: 'PO / Non-DSD',
    icon: TrendingUp,
    href: 'scenario',
  },
  {
    id: 'hidden_lost_sales',
    title: 'Hidden Lost Sales',
    question: 'Does the system recognize supply-constrained zeros as availability failures?',
    badge: 'PO / Non-DSD',
    icon: AlertTriangle,
    href: 'scenario',
  },
  {
    id: 'competitive_void',
    title: 'Competitive Void',
    question: 'Does the system flag a competitor-driven spike as anomalous — or chase it?',
    badge: 'DSD + Non-DSD',
    icon: BarChart2,
    href: 'scenario',
  },
  {
    id: 'late_promo_change',
    title: 'Late Promo Change',
    question: 'When the promo is cancelled, does the system act on what it knows — or wait for proof?',
    badge: 'DSD + Non-DSD',
    icon: Clock,
    href: 'scenario',
  },
]

export default function RetailerLandingPage() {
  const params = useParams()
  const router = useRouter()
  const retailerAccountId = params.retailerAccountId as string

  const allCards = [
    ...SCENARIOS.map((s, i) => ({ ...s, index: i + 1, total: SCENARIOS.length + 1 })),
    {
      id: 'no_scenario',
      title: 'No Scenario Yet',
      question: 'View all simulation runs without a specific scenario applied.',
      badge: 'All Runs',
      icon: PlayCircle,
      href: 'runs',
      index: SCENARIOS.length + 1,
      total: SCENARIOS.length + 1,
      isPlain: true,
    },
  ]

  return (
    <div className="w-full px-6 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-charcoal-blue-950">Choose a Scenario</h1>
        <p className="mt-0.5 text-xs font-medium text-charcoal-blue-400">
          Select a scenario to explore or view all existing runs
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {allCards.map((card) => {
          const Icon = card.icon
          const isPlain = 'isPlain' in card && card.isPlain

          return (
            <button
              key={card.id}
              onClick={() => router.push(`/retailers/${retailerAccountId}/${card.href}`)}
              className={`group relative overflow-hidden rounded-xl border bg-white text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg ${
                isPlain
                  ? 'border-charcoal-blue-200 hover:border-charcoal-blue-400 hover:shadow-charcoal-blue-100'
                  : 'border-charcoal-blue-200 hover:border-majorelle-blue-400 hover:shadow-majorelle-blue-500/10'
              }`}
            >
              {/* Top accent bar */}
              <div className={`h-1 w-full ${isPlain ? 'bg-charcoal-blue-300' : 'bg-majorelle-blue-500'}`} />

              <div className="p-4">
                {/* Icon + badge row */}
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${isPlain ? 'bg-charcoal-blue-100' : 'bg-majorelle-blue-50'}`}>
                    <Icon size={18} className={isPlain ? 'text-charcoal-blue-500' : 'text-majorelle-blue-500'} />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      isPlain
                        ? 'border-charcoal-blue-200 text-charcoal-blue-400'
                        : 'border-majorelle-blue-200 text-majorelle-blue-500'
                    }`}>
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
                <span className={`text-xs font-semibold transition-all ${
                  isPlain
                    ? 'text-charcoal-blue-500 group-hover:text-charcoal-blue-700'
                    : 'text-majorelle-blue-500 group-hover:text-majorelle-blue-700'
                }`}>
                  {isPlain ? 'View all runs →' : 'View scenario →'}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
