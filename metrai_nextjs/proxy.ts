import { NextRequest, NextResponse } from 'next/server'

const publicRoutes = ['/login', '/register']
const authRoutes = ['/login', '/register']

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  const isPublicRoute = publicRoutes.includes(pathname)

  const authToken = request.cookies.get('auth-token')?.value

  if (isPublicRoute) {
    if (authToken) {
      return NextResponse.redirect(new URL('/retailers', request.url))
    }
    return NextResponse.next()
  }

  // TODO: Temporarily disabled auth check for UI testing
  // if (!authToken) {
  //   return NextResponse.redirect(new URL('/login', request.url))
  // }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api).*)',
  ],
}
