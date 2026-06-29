'use client'

import Link from 'next/link'
import { useRouter, useParams, usePathname } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { useFilterStore } from '@/lib/store/filterStore'
import { logout } from '@/lib/api/auth'
import { LogOut, Home, BarChart3, Plus, Settings, SlidersHorizontal, ChevronLeft, RotateCcw } from 'lucide-react'
import { FilterSelect } from '@/components/ui/filter-select'

export function Sidebar() {
  const router = useRouter()
  const params = useParams()
  const pathname = usePathname()
  const { clearAuth, fullName, refreshToken } = useAuthStore()
  const {
    globalItem, globalStore, globalSdc, globalRdc,
    globalCategory, globalSubcategory, globalBrand,
    itemOptions,
    categoryOptions, subcategoryOptions, brandOptions,
    filteredStoreOptions, filteredSdcOptions, filteredRdcOptions,
    filteredItemOptions, filteredSubcategoryOptions, filteredBrandOptions,
    resetFilters, setFilters,
  } = useFilterStore()

  const retailerAccountId = params.retailerAccountId as string
  const runId = params.runId as string | undefined

  // Filter mode: only when viewing a simulation result
  const isSimulationRun = !!(retailerAccountId && runId && pathname.includes('/simulation/') && !pathname.includes('/new'))
  const hasFilters = !!(globalItem || globalStore || globalSdc || globalRdc || globalCategory || globalSubcategory || globalBrand)

  const handleLogout = async () => {
    if (refreshToken) logout().catch(() => {})
    clearAuth()
    router.push('/login')
  }

  const isRuns = retailerAccountId && (
    pathname === `/retailers/${retailerAccountId}` ||
    pathname === `/retailers/${retailerAccountId}/runs`
  )
  const isNewSim = retailerAccountId && pathname.includes('/simulation/new')
  const isScenario = retailerAccountId && pathname.includes('/scenario')
  const isSimulation = retailerAccountId && pathname.includes('/simulation/') && !pathname.includes('/new')

  const applyFilter = (item: string, store: string, sdc: string, rdc: string) => {
    setFilters({ globalItem: item, globalStore: store, globalSdc: sdc, globalRdc: rdc })
  }

  // When category/subcategory/brand changes, update meta fields and clear
  // the item selection if it no longer belongs to the new filter set.
  const applyMetaFilter = (category: string, subcategory: string, brand: string) => {
    const validItems = filteredItemOptions(category, subcategory, brand)
    const validIds = new Set(validItems.map(o => o.value))
    const newItem = globalItem && validIds.has(globalItem) ? globalItem : ''
    setFilters({
      globalCategory: category,
      globalSubcategory: subcategory,
      globalBrand: brand,
      globalItem: newItem,    // cleared or kept — either way triggers the page effect
      globalStore: newItem ? globalStore : '',
      globalSdc:   newItem ? globalSdc   : '',
      globalRdc:   newItem ? globalRdc   : '',
    })
  }

  const navItems = [
    { label: 'Retailers', href: '/retailers', icon: Home, current: !retailerAccountId },
    retailerAccountId && { label: 'Runs', href: `/retailers/${retailerAccountId}`, icon: BarChart3, current: !!isRuns },
    retailerAccountId && { label: 'New Simulation', href: `/retailers/${retailerAccountId}/simulation/new`, icon: Plus, current: !!isNewSim },
    retailerAccountId && { label: 'Scenario Setup', href: `/retailers/${retailerAccountId}/scenario`, icon: Settings, current: !!isScenario },
  ].filter(Boolean)

  return (
    <aside className="w-52 flex-shrink-0 overflow-y-auto scrollbar-none bg-gradient-to-b from-charcoal-blue-900 to-charcoal-blue-950 flex flex-col">
      {/* Logo */}
      <div className="flex h-[56px] flex-shrink-0 items-center gap-2.5 border-b border-white/10 px-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-majorelle-blue-500 to-majorelle-blue-700 text-sm font-bold text-white">
          M
        </div>
        <div>
          <h1 className="text-sm font-bold text-white leading-none">METRAI</h1>
          <p className="text-[10px] font-medium text-charcoal-blue-400 mt-0.5">Simulation</p>
        </div>
      </div>

      {/* Filter mode — shown when viewing a simulation run */}
      {isSimulationRun ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Filter header */}
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={13} className="text-majorelle-blue-400" />
              <span className="text-xs font-bold text-white">Filters</span>
            </div>
            <Link
              href={`/retailers/${retailerAccountId}`}
              className="flex items-center gap-1 text-[10px] font-semibold text-charcoal-blue-400 hover:text-charcoal-blue-200 transition-colors"
            >
              <ChevronLeft size={11} /> Runs
            </Link>
          </div>

          {/* Filter controls */}
          <div className="flex-1 overflow-y-auto scrollbar-none px-4 py-4 space-y-4">
            {itemOptions.length === 0 ? (
              <p className="text-[10px] text-charcoal-blue-500 text-center pt-4">Loading filters…</p>
            ) : (
              <>
                {/* Product meta filters */}
                <div className="space-y-3">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-charcoal-blue-500">Product</p>
                  {categoryOptions.length > 0 && (
                    <FilterSelect
                      variant="dark"
                      label="Category"
                      value={globalCategory}
                      options={categoryOptions}
                      onChange={v => applyMetaFilter(v, '', '')}
                    />
                  )}
                  {subcategoryOptions.length > 0 && (
                    <FilterSelect
                      variant="dark"
                      label="Sub Category"
                      value={globalSubcategory}
                      options={filteredSubcategoryOptions(globalCategory)}
                      onChange={v => applyMetaFilter(globalCategory, v, '')}
                    />
                  )}
                  {brandOptions.length > 0 && (
                    <FilterSelect
                      variant="dark"
                      label="Brand"
                      value={globalBrand}
                      options={filteredBrandOptions(globalCategory, globalSubcategory)}
                      onChange={v => applyMetaFilter(globalCategory, globalSubcategory, v)}
                    />
                  )}
                  <FilterSelect
                    variant="dark"
                    label="Item"
                    value={globalItem}
                    options={filteredItemOptions(globalCategory, globalSubcategory, globalBrand)}
                    onChange={v => applyFilter(v, globalStore, globalSdc, globalRdc)}
                  />
                </div>

                {/* Location filters */}
                <div className="border-t border-white/10 pt-4 space-y-3">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-charcoal-blue-500">Location</p>
                  <FilterSelect
                    variant="dark"
                    label="Store"
                    value={globalStore}
                    options={filteredStoreOptions(globalItem)}
                    onChange={v => applyFilter(globalItem, v, globalSdc, globalRdc)}
                  />
                </div>

                {/* Supply Chain filters */}
                <div className="border-t border-white/10 pt-4 space-y-3">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-charcoal-blue-500">Supply Chain</p>
                  <FilterSelect
                    variant="dark"
                    label="Supplier DC"
                    value={globalSdc}
                    options={filteredSdcOptions(globalItem, globalRdc)}
                    onChange={v => applyFilter(globalItem, globalStore, v, globalRdc)}
                  />
                  <FilterSelect
                    variant="dark"
                    label="Retailer DC"
                    value={globalRdc}
                    options={filteredRdcOptions(globalItem, globalSdc)}
                    onChange={v => applyFilter(globalItem, globalStore, globalSdc, v)}
                  />
                </div>
              </>
            )}
          </div>

          {/* Reset filters */}
          <div className="border-t border-white/10 px-4 py-3">
            <button
              onClick={resetFilters}
              disabled={!hasFilters}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-charcoal-blue-400/30 px-3 py-1.5 text-xs font-semibold text-charcoal-blue-300 transition-all hover:border-majorelle-blue-500/50 hover:bg-majorelle-blue-500/10 hover:text-majorelle-blue-300 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <RotateCcw size={12} /> Reset Filters
            </button>
          </div>
        </div>
      ) : (
        /* Nav mode — all other pages */
        <>
          <nav className="flex flex-col gap-0.5 flex-1 overflow-y-auto px-2 py-4">
            {navItems.map((item: any) => {
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold transition-all duration-200 ${
                    item.current
                      ? 'bg-majorelle-blue-500 text-white'
                      : 'text-charcoal-blue-300 hover:bg-majorelle-blue-500/15 hover:text-white'
                  }`}
                >
                  <Icon size={15} className="flex-shrink-0" />
                  <span>{item.label}</span>
                  {item.current && <div className="ml-auto h-1.5 w-1.5 rounded-full bg-white" />}
                </Link>
              )
            })}

            {/* Simulation link — visible when on simulation page */}
            {isSimulation && (
              <div className="mt-2 border-t border-white/10 pt-2">
                <div className="flex items-center gap-2.5 rounded-xl bg-majorelle-blue-500/20 px-3 py-2 text-xs font-semibold text-majorelle-blue-300">
                  <SlidersHorizontal size={15} className="flex-shrink-0" />
                  <span>Filters available</span>
                </div>
              </div>
            )}
          </nav>

          {/* User / Logout */}
          <div className="border-t border-white/10 px-3 py-3">
            <div className="mb-2 rounded-xl bg-majorelle-blue-500/15 px-3 py-2">
              <p className="mb-1 text-[9px] font-bold uppercase tracking-wide text-charcoal-blue-400">Signed In As</p>
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-majorelle-blue-500 text-xs font-bold text-white">
                  {(fullName || 'U').charAt(0).toUpperCase()}
                </div>
                <p className="truncate text-xs font-medium text-white">{fullName || 'User'}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-charcoal-blue-400/30 px-3 py-1.5 text-xs font-semibold text-charcoal-blue-300 transition-all hover:border-red-500/50 hover:bg-red-500/15 hover:text-red-400"
            >
              <LogOut size={13} />
              Sign Out
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
