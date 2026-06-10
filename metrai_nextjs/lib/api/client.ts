import axios, { AxiosError, AxiosInstance } from 'axios'
import { useAuthStore } from '@/lib/store/authStore'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8001'
const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL || 'http://localhost:8000'

let isRefreshing = false
let failedQueue: Array<{
  onSuccess: (token: string) => void
  onFailure: (error: AxiosError) => void
}> = []

const processQueue = (error: AxiosError | null, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.onFailure(error)
    } else if (token) {
      prom.onSuccess(token)
    }
  })
  failedQueue = []
}

const createApiClient = (): AxiosInstance => {
  const client = axios.create({
    baseURL: BACKEND_URL,
    headers: {
      'Content-Type': 'application/json',
    },
  })

  client.interceptors.request.use((config) => {
    const { accessToken } = useAuthStore.getState()
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`
    }
    return config
  })

  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const originalRequest = error.config as any

      if (error.response?.status === 401 && !originalRequest._retry) {
        if (isRefreshing) {
          return new Promise((resolve, reject) => {
            failedQueue.push({
              onSuccess: (token: string) => {
                originalRequest.headers.Authorization = `Bearer ${token}`
                resolve(client(originalRequest))
              },
              onFailure: (err: AxiosError) => {
                reject(err)
              },
            })
          })
        }

        originalRequest._retry = true
        isRefreshing = true

        try {
          const { refreshToken } = useAuthStore.getState()
          if (!refreshToken) throw new Error('No refresh token available')

          const response = await axios.post(`${ENGINE_URL}/auth/refresh`, {
            refresh_token: refreshToken,
          })

          const { access_token, refresh_token, token_expiry } = response.data

          useAuthStore.getState().setAuth({
            accessToken: access_token,
            refreshToken: refresh_token,
            tokenExpiry: token_expiry,
          })

          originalRequest.headers.Authorization = `Bearer ${access_token}`
          processQueue(null, access_token)
          isRefreshing = false

          return client(originalRequest)
        } catch (err) {
          processQueue(err as AxiosError, null)
          useAuthStore.getState().clearAuth()
          isRefreshing = false
          window.location.href = '/login'
          return Promise.reject(err)
        }
      }

      return Promise.reject(error)
    }
  )

  return client
}

export const apiClient = createApiClient()

export const engineClient = axios.create({
  baseURL: ENGINE_URL,
  headers: { 'Content-Type': 'application/json' },
})

engineClient.interceptors.request.use((config) => {
  const { accessToken } = useAuthStore.getState()
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`
  }
  return config
})

export const setAuthToken = (token: string) => {
  apiClient.defaults.headers.common.Authorization = `Bearer ${token}`
}

export const clearAuthToken = () => {
  delete apiClient.defaults.headers.common.Authorization
}
