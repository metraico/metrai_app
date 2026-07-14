import { apiClient } from './client'
import type { LoginRequest, BackendLoginResponse, RegisterRequest, RegisterResponse } from './types'

export const login = (data: LoginRequest) =>
  apiClient.post<BackendLoginResponse>('/auth/login', data).then(r => r.data)

export const register = (data: RegisterRequest) =>
  apiClient.post<RegisterResponse>('/auth/register', data).then(r => r.data)

export const logout = () => Promise.resolve()
