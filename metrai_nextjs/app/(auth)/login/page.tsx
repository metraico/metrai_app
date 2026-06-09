'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store/authStore'
import { login, register } from '@/lib/api/auth'

export default function LoginPage() {
  const router = useRouter()
  const { setAuth } = useAuthStore()

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState('signin')

  const [signInForm, setSignInForm] = useState({
    username: '',
    password: '',
  })

  const [signUpForm, setSignUpForm] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    full_name: '',
  })

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      const data = await login({ username: signInForm.username, password: signInForm.password })
      const payload = JSON.parse(atob(data.access_token.split('.')[1]))

      setAuth({
        userId: payload.sub ?? null,
        fullName: payload.username ?? null,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        retailerAccountId: null,
      })

      router.push('/retailers')
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Invalid username or password.')
      console.error('Sign in error:', err)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (signUpForm.password !== signUpForm.confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setIsLoading(true)

    try {
      await register({
        username: signUpForm.username,
        email: signUpForm.email,
        password: signUpForm.password,
        full_name: signUpForm.full_name,
      })

      // Register returns user info only — sign in to get tokens
      const data = await login({ username: signUpForm.username, password: signUpForm.password })
      const payload = JSON.parse(atob(data.access_token.split('.')[1]))
      setAuth({
        userId: payload.sub ?? null,
        fullName: payload.username ?? null,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        retailerAccountId: null,
      })

      router.push('/retailers')
    } catch (err: any) {
      const errorMsg = err.response?.data?.detail || err.message || 'Registration failed. Please try again.'
      setError(errorMsg)
      console.error('Sign up error:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-charcoal-blue-50 p-8">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-sm">
        {/* Header */}
        <div className="border-b border-charcoal-blue-200 px-8 py-10">
          <h1 className="text-3xl font-bold text-charcoal-blue-950">MetRAI</h1>
          <p className="mt-1 text-sm font-medium text-charcoal-blue-400">Simulation Engine</p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-charcoal-blue-200">
          <button
            onClick={() => setActiveTab('signin')}
            className={`flex-1 px-6 py-4 text-sm font-semibold transition-all duration-200 ${
              activeTab === 'signin'
                ? 'border-b-2 border-majorelle-blue-500 bg-white text-majorelle-blue-500'
                : 'bg-charcoal-blue-50 text-charcoal-blue-400 hover:text-charcoal-blue-600'
            }`}
          >
            Sign In
          </button>
          <button
            onClick={() => setActiveTab('signup')}
            className={`flex-1 px-6 py-4 text-sm font-semibold transition-all duration-200 ${
              activeTab === 'signup'
                ? 'border-b-2 border-majorelle-blue-500 bg-white text-majorelle-blue-500'
                : 'bg-charcoal-blue-50 text-charcoal-blue-400 hover:text-charcoal-blue-600'
            }`}
          >
            Sign Up
          </button>
        </div>

        {/* Content */}
        <div className="px-8 py-8">
          {error && (
            <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
              {error}
            </div>
          )}

          {activeTab === 'signin' && (
            <form onSubmit={handleSignIn} className="flex flex-col gap-5">
              <div>
                <label className="mb-2 block text-sm font-semibold text-charcoal-blue-950">
                  Username
                </label>
                <input
                  type="text"
                  placeholder="Enter your username"
                  value={signInForm.username}
                  onChange={(e) => setSignInForm({ ...signInForm, username: e.target.value })}
                  required
                  disabled={isLoading}
                  className="w-full rounded-2xl border border-charcoal-blue-200 bg-white px-4 py-2.5 text-sm font-medium text-charcoal-blue-950 transition-colors duration-200 placeholder-charcoal-blue-400 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500 disabled:bg-charcoal-blue-50 disabled:text-charcoal-blue-400"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-charcoal-blue-950">
                  Password
                </label>
                <input
                  type="password"
                  placeholder="Enter your password"
                  value={signInForm.password}
                  onChange={(e) => setSignInForm({ ...signInForm, password: e.target.value })}
                  required
                  disabled={isLoading}
                  className="w-full rounded-2xl border border-charcoal-blue-200 bg-white px-4 py-2.5 text-sm font-medium text-charcoal-blue-950 transition-colors duration-200 placeholder-charcoal-blue-400 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500 disabled:bg-charcoal-blue-50 disabled:text-charcoal-blue-400"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="mt-2 rounded-2xl bg-majorelle-blue-500 px-5 py-2.5 text-sm font-semibold text-white transition-all duration-200 hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30 disabled:bg-majorelle-blue-400 disabled:shadow-none"
              >
                {isLoading ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          )}

          {activeTab === 'signup' && (
            <form onSubmit={handleSignUp} className="flex flex-col gap-5">
              <div>
                <label className="mb-2 block text-sm font-semibold text-charcoal-blue-950">
                  Username
                </label>
                <input
                  type="text"
                  placeholder="Choose a username"
                  value={signUpForm.username}
                  onChange={(e) => setSignUpForm({ ...signUpForm, username: e.target.value })}
                  required
                  disabled={isLoading}
                  className="w-full rounded-2xl border border-charcoal-blue-200 bg-white px-4 py-2.5 text-sm font-medium text-charcoal-blue-950 transition-colors duration-200 placeholder-charcoal-blue-400 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500 disabled:bg-charcoal-blue-50 disabled:text-charcoal-blue-400"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-charcoal-blue-950">
                  Email <span className="text-xs font-normal text-charcoal-blue-400">(optional)</span>
                </label>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={signUpForm.email}
                  onChange={(e) => setSignUpForm({ ...signUpForm, email: e.target.value })}
                  disabled={isLoading}
                  className="w-full rounded-2xl border border-charcoal-blue-200 bg-white px-4 py-2.5 text-sm font-medium text-charcoal-blue-950 transition-colors duration-200 placeholder-charcoal-blue-400 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500 disabled:bg-charcoal-blue-50 disabled:text-charcoal-blue-400"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-charcoal-blue-950">
                  Full Name <span className="text-xs font-normal text-charcoal-blue-400">(optional)</span>
                </label>
                <input
                  type="text"
                  placeholder="John Doe"
                  value={signUpForm.full_name}
                  onChange={(e) => setSignUpForm({ ...signUpForm, full_name: e.target.value })}
                  disabled={isLoading}
                  className="w-full rounded-2xl border border-charcoal-blue-200 bg-white px-4 py-2.5 text-sm font-medium text-charcoal-blue-950 transition-colors duration-200 placeholder-charcoal-blue-400 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500 disabled:bg-charcoal-blue-50 disabled:text-charcoal-blue-400"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-charcoal-blue-950">
                  Password
                </label>
                <input
                  type="password"
                  placeholder="Create a password"
                  value={signUpForm.password}
                  onChange={(e) => setSignUpForm({ ...signUpForm, password: e.target.value })}
                  required
                  disabled={isLoading}
                  className="w-full rounded-2xl border border-charcoal-blue-200 bg-white px-4 py-2.5 text-sm font-medium text-charcoal-blue-950 transition-colors duration-200 placeholder-charcoal-blue-400 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500 disabled:bg-charcoal-blue-50 disabled:text-charcoal-blue-400"
                />
              </div>

              <div>
                <label className="mb-2 block text-sm font-semibold text-charcoal-blue-950">
                  Confirm Password
                </label>
                <input
                  type="password"
                  placeholder="Confirm your password"
                  value={signUpForm.confirmPassword}
                  onChange={(e) => setSignUpForm({ ...signUpForm, confirmPassword: e.target.value })}
                  required
                  disabled={isLoading}
                  className="w-full rounded-2xl border border-charcoal-blue-200 bg-white px-4 py-2.5 text-sm font-medium text-charcoal-blue-950 transition-colors duration-200 placeholder-charcoal-blue-400 focus:border-majorelle-blue-500 focus:outline-none focus:ring-1 focus:ring-majorelle-blue-500 disabled:bg-charcoal-blue-50 disabled:text-charcoal-blue-400"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="mt-2 rounded-2xl bg-majorelle-blue-500 px-5 py-2.5 text-sm font-semibold text-white transition-all duration-200 hover:bg-majorelle-blue-600 hover:shadow-lg hover:shadow-majorelle-blue-500/30 disabled:bg-majorelle-blue-400 disabled:shadow-none"
              >
                {isLoading ? 'Creating account...' : 'Create account'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
