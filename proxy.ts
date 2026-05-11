import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Dopasuj wszystkie ścieżki oprócz tych zaczynających się od:
     * - _next/static (pliki statyczne)
     * - _next/image (optymalizacja obrazów)
     * - favicon.ico (plik ikony)
     * - pliki graficzne
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
