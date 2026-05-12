import { createClient as createSupabaseClient } from '@supabase/supabase-js'

// Klient z service_role — omija RLS. Używać WYŁĄCZNIE w server actions
// / route handlerach, po wcześniejszej weryfikacji tożsamości użytkownika
// przez supabase.auth.getUser() na zwykłym kliencie.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error(
      'Brak SUPABASE_SERVICE_ROLE_KEY w środowisku — wymagany do operacji administracyjnych.'
    )
  }

  return createSupabaseClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
