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
}

export const useFilterStore = create<FilterState>((set) => ({
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

  setFilters: (partial) => set(partial),

  setOptions: (opts) => set(opts),

  resetFilters: () => set({
    globalItem: '', globalStore: '', globalSdc: '', globalRdc: '',
    globalCategory: '', globalSubcategory: '', globalBrand: '',
  }),

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
    globalItem: '', globalStore: '', globalSdc: '', globalRdc: '',
    globalCategory: '', globalSubcategory: '', globalBrand: '',
  }),
}))
