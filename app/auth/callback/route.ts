import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const errorDescription = searchParams.get('error_description')

  if (errorDescription) {
    const url = new URL('/auth/error', origin)
    url.searchParams.set('message', errorDescription)
    return NextResponse.redirect(url)
  }

  if (!code) {
    const url = new URL('/auth/error', origin)
    url.searchParams.set('message', 'Brak kodu autoryzacji w odpowiedzi dostawcy.')
    return NextResponse.redirect(url)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    const url = new URL('/auth/error', origin)
    url.searchParams.set(
      'message',
      error.message || 'Nie udało się dokończyć logowania.'
    )
    return NextResponse.redirect(url)
  }

  return NextResponse.redirect(new URL('/dashboard', origin))
}
