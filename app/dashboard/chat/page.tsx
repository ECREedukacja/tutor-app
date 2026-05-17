import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

// /dashboard/chat — bez wybranej konwersacji.
//
// • Desktop (lg): lewa kolumna z listą widoczna (z layout.tsx), środek pokazuje
//   placeholder „Wybierz konwersację".
// • Mobile: layout chowa <aside> (hidden lg:flex), więc bez przekierowania
//   użytkownik widziałby tylko placeholder. Pokazujemy więc listę zamiast
//   środka (mobile fallback).
export const dynamic = 'force-dynamic'

export default async function ChatIndexPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <>
      {/* Desktop: pusty środek z zachętą */}
      <div className="hidden h-full flex-col items-center justify-center gap-2 px-6 text-center lg:flex">
        <span className="text-4xl" aria-hidden>
          💬
        </span>
        <p className="text-base font-medium text-slate-700">
          Wybierz konwersację
        </p>
        <p className="max-w-sm text-sm text-slate-500">
          Po lewej znajdziesz wszystkie rozmowy z osobami, z którymi jesteś
          powiązany. Możesz wysyłać wiadomości i pliki.
        </p>
      </div>

      {/* Mobile fallback: krótka informacja + link do powiązań */}
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center lg:hidden">
        <span className="text-3xl" aria-hidden>
          💬
        </span>
        <p className="text-base font-medium text-slate-700">Wiadomości</p>
        <p className="max-w-xs text-sm text-slate-500">
          Otwórz konwersację z listy „Moi uczniowie” lub „Moi nauczyciele” — w
          każdej karcie znajdziesz przycisk „Wyślij wiadomość”.
        </p>
        <Link
          href="/dashboard"
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          ← Dashboard
        </Link>
      </div>
    </>
  )
}
