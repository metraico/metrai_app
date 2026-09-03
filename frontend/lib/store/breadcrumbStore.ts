import { useEffect } from 'react'
import { create } from 'zustand'

export interface BreadcrumbCrumb { label: string; href?: string }

interface BreadcrumbState {
  // Trailing crumbs after "Retailers / Account" — set by the current page once it knows
  // real names (simulation name, extension name, scenario, etc.), cleared on unmount so a
  // stale trail never survives a navigation to a page that doesn't set one.
  trail: BreadcrumbCrumb[]
  setTrail: (trail: BreadcrumbCrumb[]) => void
  clearTrail: () => void
}

export const useBreadcrumbStore = create<BreadcrumbState>((set) => ({
  trail: [],
  setTrail: (trail) => set({ trail }),
  clearTrail: () => set({ trail: [] }),
}))

/** Publish this page's trailing breadcrumb(s) while mounted; auto-clears on unmount. Pass
 *  `null` (or an empty array) while data is still loading so the bar doesn't flash a wrong
 *  label — it'll fill in once the real crumbs are ready. */
export function useBreadcrumb(trail: BreadcrumbCrumb[] | null) {
  const setTrail = useBreadcrumbStore(s => s.setTrail)
  const clearTrail = useBreadcrumbStore(s => s.clearTrail)
  const key = trail ? JSON.stringify(trail) : null
  useEffect(() => {
    if (trail && trail.length > 0) setTrail(trail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => () => clearTrail(), [clearTrail])
}
