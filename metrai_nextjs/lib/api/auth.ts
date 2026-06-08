import { apiClient } from './client'
import type { LoginRequest, LoginResponse, RegisterRequest, RegisterResponse, LogoutRequest } from './types'

export const login = (data: LoginRequest) =>
  apiClient.post<LoginResponse>('/login', data).then(r => r.data)

export const register = (data: RegisterRequest) =>
  apiClient.post<RegisterResponse>('/register', data).then(r => r.data)

export const logout = (data: LogoutRequest) =>
  apiClient.post<{ status: string }>('/logout', data).then(r => r.data)
