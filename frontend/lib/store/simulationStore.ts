import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SimulationSummary } from '@/lib/api/types'

interface SimulationCache {
  simulationId: string
  simulationName: string
  summary: SimulationSummary
}

interface SimulationState {
  cache: SimulationCache | null
  setCache: (c: SimulationCache) => void
  clearCache: () => void
}

export const useSimulationStore = create<SimulationState>()(
  persist(
    (set) => ({
      cache: null,
      setCache: (c) => set({ cache: c }),
      clearCache: () => set({ cache: null }),
    }),
    { name: 'simulation-cache' }
  )
)
