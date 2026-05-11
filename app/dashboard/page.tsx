import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logout } from './actions'

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, role')
    .eq('id', user.id)
    .single()

  const displayName = profile?.first_name?.trim() || user.email
  const roleLabel = profile?.role === 'teacher' ? 'Nauczyciel' : 'Uczeń'

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">
                Cześć, {displayName}!
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Rola w aplikacji:{' '}
                <span className="font-medium text-indigo-700">{roleLabel}</span>
              </p>
            </div>
            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Wyloguj się
              </button>
            </form>
          </div>

          <div className="mt-8 rounded-xl bg-slate-50 p-6 text-sm text-slate-600 ring-1 ring-slate-200">
            To Twój panel główny. Wkrótce pojawi się tu terminarz lekcji, chat z plikami,
            generator zadań AI oraz lekcje na żywo.
          </div>
        </div>
      </div>
    </main>
  )
}
