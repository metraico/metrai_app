import { TrendingUp, AlertTriangle, BarChart2, Clock, PlayCircle } from 'lucide-react'

export const SCENARIOS = [
  {
    id: 'promo_forecast',
    title: 'Promo Forecast Behavior',
    question: 'Does the system distinguish an execution failure from a demand decline?',
    badge: 'PO / Non-DSD',
    icon: TrendingUp,
    yamlEditorLabel: 'Promo Performance Scenario',
    yamlEditorDescription: 'Set performance_adjustment per promo (0–200%). 0 = no change · 50 = 50% better than forecast · 200 = double the expected uplift.',
    yamlTemplate: [
      'scenario_type: promo_forecast',
      'promos:',
      '  - promo_name: ENTER_PROMO_NAME    # start → end | base: 1.0x',
      '    performance_adjustment: 0    # 0 to 200 (%)',
    ].join('\n'),
  },
  {
    id: 'hidden_lost_sales',
    title: 'Hidden Lost Sales',
    question: 'Does the system recognize supply-constrained zeros as availability failures?',
    badge: 'PO / Non-DSD',
    icon: AlertTriangle,
    yamlEditorLabel: 'DC Disruption Scenario',
    yamlEditorDescription: 'Define DC-level stockouts or outages. mode: stockout | outage | delayed.',
    yamlTemplate: [
      'scenario_type: hidden_lost_sales',
      'disruptions:',
      '  - dc: "DC_CODE"',
      '    items: all',
      '    window_start: "01/01/2024"',
      '    window_end: "01/07/2024"',
      '    mode: stockout    # stockout | outage | delayed',
      '    # fulfillment_pct: 0   # for outage/delayed modes',
      '    # delay_days: 3        # required for delayed mode',
    ].join('\n'),
  },
  {
    id: 'competitive_void',
    title: 'Competitive Void',
    question: 'Does the system flag a competitor-driven spike as anomalous — or chase it?',
    badge: 'DSD + Non-DSD',
    icon: BarChart2,
    yamlEditorLabel: 'Competitive Void Scenario',
    yamlEditorDescription: 'Define a competitor SKU removal event that drives demand lift.',
    yamlTemplate: [
      'scenario_type: competitive_void',
      '# Not yet supported by the simulation engine.',
    ].join('\n'),
  },
  {
    id: 'late_promo_change',
    title: 'Late Promo Change',
    question: 'When the promo is cancelled, does the system act on what it knows — or wait for proof?',
    badge: 'DSD + Non-DSD',
    icon: Clock,
    yamlEditorLabel: 'Late Promo Change Scenario',
    yamlEditorDescription: 'Define a promo cancellation or date shift after inventory was pre-built.',
    yamlTemplate: [
      'scenario_type: late_promo_change',
      '# Not yet supported by the simulation engine.',
    ].join('\n'),
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
