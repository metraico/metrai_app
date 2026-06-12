import { TrendingUp, AlertTriangle, BarChart2, Clock, PlayCircle } from 'lucide-react'

export const SCENARIOS = [
  {
    id: 'promo_forecast',
    title: 'Promo Forecast Behavior',
    question: 'Does the system distinguish an execution failure from a demand decline?',
    badge: 'PO / Non-DSD',
    icon: TrendingUp,
  },
  {
    id: 'hidden_lost_sales',
    title: 'Hidden Lost Sales',
    question: 'Does the system recognize supply-constrained zeros as availability failures?',
    badge: 'PO / Non-DSD',
    icon: AlertTriangle,
  },
  {
    id: 'competitive_void',
    title: 'Competitive Void',
    question: 'Does the system flag a competitor-driven spike as anomalous — or chase it?',
    badge: 'DSD + Non-DSD',
    icon: BarChart2,
  },
  {
    id: 'late_promo_change',
    title: 'Late Promo Change',
    question: 'When the promo is cancelled, does the system act on what it knows — or wait for proof?',
    badge: 'DSD + Non-DSD',
    icon: Clock,
  },
] as const

export const NO_SCENARIO = {
  id: 'no_scenario',
  title: 'No Scenario',
  question: 'Run with baseline demand only — no scenario applied.',
  badge: 'All Runs',
  icon: PlayCircle,
} as const

export type ScenarioId = typeof SCENARIOS[number]['id'] | 'no_scenario'

export function getScenario(id: string) {
  if (id === 'no_scenario') return NO_SCENARIO
  return SCENARIOS.find(s => s.id === id) ?? null
}
