import { apiClient } from './client'
import type { LoginRequest, LoginResponse, RegisterRequest, RegisterResponse, LogoutRequest } from './types'

export const login = (data: LoginRequest) =>
  apiClient.post<LoginResponse>('/auth/login', data).then(r => r.data)

export const register = (data: RegisterRequest) =>
  apiClient.post<RegisterResponse>('/auth/register', data).then(r => r.data)

export const logout = (data: LogoutRequest) =>
  apiClient.post<{ status: string }>('/auth/logout', data).then(r => r.data)
