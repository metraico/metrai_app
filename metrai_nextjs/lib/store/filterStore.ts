import { create } from 'zustand'

export interface FilterOption { value: string; label: string }

interface FilterState {
  globalItem: string
  globalStore: string
  globalSdc: string
  globalRdc: string
  globalCategory: string
  globalSubcategory: string
  globalBrand: string
  itemOptions: FilterOption[]
  storeOptions: FilterOption[]
  sdcOptions: FilterOption[]
  rdcOptions: FilterOption[]
  categoryOptions: FilterOption[]
  subcategoryOptions: FilterOption[]
  brandOptions: FilterOption[]
  // cross-filter helpers passed from simulation page
  filteredStoreOptions: (itemId: string) => FilterOption[]
  filteredSdcOptions: (itemId: string, rdcId: string) => FilterOption[]
  filteredRdcOptions: (itemId: string, sdcId: string) => FilterOption[]
  filteredItemOptions: (category: string, subcategory: string, brand: string) => FilterOption[]
  filteredSubcategoryOptions: (category: string) => FilterOption[]
  filteredBrandOptions: (category: string, subcategory: string) => FilterOption[]
  setFilters: (partial: Partial<Pick<FilterState,
    'globalItem' | 'globalStore' | 'globalSdc' | 'globalRdc' |
    'globalCategory' | 'globalSubcategory' | 'globalBrand'>>) => void
  setOptions: (opts: {
    itemOptions: FilterOption[]
    storeOptions: FilterOption[]
    sdcOptions: FilterOption[]
    rdcOptions: FilterOption[]
    categoryOptions: FilterOption[]
    subcategoryOptions: FilterOption[]
    brandOptions: FilterOption[]
    filteredStoreOptions: (itemId: string) => FilterOption[]
    filteredSdcOptions: (itemId: string, rdcId: string) => FilterOption[]
    filteredRdcOptions: (itemId: string, sdcId: string) => FilterOption[]
    filteredItemOptions: (category: string, subcategory: string, brand: string) => FilterOption[]
    filteredSubcategoryOptions: (category: string) => FilterOption[]
    filteredBrandOptions: (category: string, subcategory: string) => FilterOption[]
  }) => void
  resetFilters: () => void
  clearOptions: () => void
  // callback set by simulation page so sidebar can trigger chart refetch
  onApplyGlobalFilters: ((item: string, store: string, sdc: string, rdc: string) => void) | null
  setOnApplyGlobalFilters: (fn: (item: string, store: string, sdc: string, rdc: string) => void) => void
}

export const useFilterStore = create<FilterState>((set, get) => ({
  globalItem: '',
  globalStore: '',
  globalSdc: '',
  globalRdc: '',
  globalCategory: '',
  globalSubcategory: '',
  globalBrand: '',
  itemOptions: [],
  storeOptions: [],
  sdcOptions: [],
  rdcOptions: [],
  categoryOptions: [],
  subcategoryOptions: [],
  brandOptions: [],
  filteredStoreOptions: () => [],
  filteredSdcOptions: () => [],
  filteredRdcOptions: () => [],
  filteredItemOptions: () => [],
  filteredSubcategoryOptions: () => [],
  filteredBrandOptions: () => [],
  onApplyGlobalFilters: null,

  setFilters: (partial) => set(partial),

  setOptions: (opts) => set(opts),

  resetFilters: () => {
    const fn = get().onApplyGlobalFilters
    if (fn) fn('', '', '', '')
    set({
      globalItem: '', globalStore: '', globalSdc: '', globalRdc: '',
      globalCategory: '', globalSubcategory: '', globalBrand: '',
    })
  },

  clearOptions: () => set({
    itemOptions: [],
    storeOptions: [],
    sdcOptions: [],
    rdcOptions: [],
    categoryOptions: [],
    subcategoryOptions: [],
    brandOptions: [],
    filteredStoreOptions: () => [],
    filteredSdcOptions: () => [],
    filteredRdcOptions: () => [],
    filteredItemOptions: () => [],
    filteredSubcategoryOptions: () => [],
    filteredBrandOptions: () => [],
    onApplyGlobalFilters: null,
    globalItem: '', globalStore: '', globalSdc: '', globalRdc: '',
    globalCategory: '', globalSubcategory: '', globalBrand: '',
  }),

  setOnApplyGlobalFilters: (fn) => set({ onApplyGlobalFilters: fn }),
}))
