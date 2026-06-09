import { engineClient } from './client'
import type { LoginRequest, LoginResponse, RegisterRequest, RegisterResponse } from './types'

export const login = (data: LoginRequest) =>
  engineClient.post<LoginResponse>('/auth/login', data).then(r => r.data)

export const register = (data: RegisterRequest) =>
  engineClient.post<RegisterResponse>('/auth/register', data).then(r => r.data)

export const logout = () => Promise.resolve()
