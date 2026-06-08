import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AuthState {
  userId: string | null
  fullName: string | null
  email: string | null
  accessToken: string | null
  refreshToken: string | null
  tokenExpiry: number | null
  retailerAccountId: string | null
  isAuthenticated: boolean

  setAuth: (data: Partial<Omit<AuthState, 'isAuthenticated' | 'setAuth' | 'clearAuth'>>) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      userId: null,
      fullName: null,
      email: null,
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      retailerAccountId: null,
      isAuthenticated: false,

      setAuth: (data) => set((state) => ({
        ...state,
        ...data,
        isAuthenticated: !!data.accessToken,
      })),

      clearAuth: () => set({
        userId: null,
        fullName: null,
        email: null,
        accessToken: null,
        refreshToken: null,
        tokenExpiry: null,
        retailerAccountId: null,
        isAuthenticated: false,
      }),
    }),
    {
      name: 'auth-storage',
    }
  )
)
