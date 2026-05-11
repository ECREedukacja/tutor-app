import { type EmailOtpType } from '@supabase/supabase-js'
import { type NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  if (!token_hash || !type) {
    const url = new URL('/auth/error', origin)
    url.searchParams.set('message', 'Brak wymaganych parametrów linku weryfikacyjnego.')
    return NextResponse.redirect(url)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.verifyOtp({ type, token_hash })

  if (error) {
    const url = new URL('/auth/error', origin)
    url.searchParams.set(
      'message',
      error.message || 'Nie udało się zweryfikować adresu e-mail.'
    )
    return NextResponse.redirect(url)
  }

  return NextResponse.redirect(new URL('/auth/confirmed', origin))
}
