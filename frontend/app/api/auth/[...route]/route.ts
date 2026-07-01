import { NextRequest, NextResponse } from 'next/server'
import axios from 'axios'

const BACKEND_URL = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8080'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ route: string[] }> }
) {
  try {
    const { route: routeArray } = await params
    const route = routeArray[0]
    const body = await request.json()

    const backendUrl = `${BACKEND_URL}/api/auth/${route}`

    const response = await axios.post(backendUrl, body, {
      headers: {
        'Content-Type': 'application/json',
      },
    })

    const result = NextResponse.json(response.data, { status: response.status })

    if (response.data.access_token) {
      result.cookies.set({
        name: 'auth-token',
        value: response.data.access_token,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 7,
      })

      if (response.data.refresh_token) {
        result.cookies.set({
          name: 'refresh-token',
          value: response.data.refresh_token,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 30,
        })
      }
    }

    return result
  } catch (error: any) {
    console.error('Auth API error:', error.message)

    if (error.response?.data) {
      return NextResponse.json(
        error.response.data,
        { status: error.response.status }
      )
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ route: string[] }> }
) {
  try {
    const { route: routeArray } = await params
    const route = routeArray[0]
    const backendUrl = `${BACKEND_URL}/api/auth/${route}`

    const authToken = request.cookies.get('auth-token')?.value

    const headers: any = {
      'Content-Type': 'application/json',
    }

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`
    }

    const response = await axios.get(backendUrl, { headers })

    return NextResponse.json(response.data, { status: response.status })
  } catch (error: any) {
    console.error('Auth API error:', error.message)

    if (error.response?.data) {
      return NextResponse.json(
        error.response.data,
        { status: error.response.status }
      )
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
