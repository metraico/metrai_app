import { create } from 'zustand'

type Status = 'PENDING' | 'READY' | 'FAILED' | null

interface AnalyticsStatusState {
  analyticsStatus: Status
  setAnalyticsStatus: (s: Status) => void
  resetAnalyticsStatus: () => void
}

export const useAnalyticsStatusStore = create<AnalyticsStatusState>((set) => ({
  analyticsStatus: null,
  setAnalyticsStatus: (analyticsStatus) => set({ analyticsStatus }),
  resetAnalyticsStatus: () => set({ analyticsStatus: null }),
}))
