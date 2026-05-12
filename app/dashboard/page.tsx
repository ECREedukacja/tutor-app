import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

export default async function DashboardPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, role')
    .eq('id', user!.id)
    .single()

  const displayName = profile?.first_name?.trim() || user!.email
  const roleLabel = profile?.role === 'teacher' ? 'Nauczyciel' : 'Uczeń'

  const nextHref =
    profile?.role === 'teacher' ? '/dashboard/students' : '/dashboard/teachers'
  const nextLabel =
    profile?.role === 'teacher' ? 'Przejdź do uczniów' : 'Przejdź do nauczycieli'

  return (
    <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
      <h1 className="text-2xl font-semibold text-slate-900">
        Cześć, {displayName}!
      </h1>
      <p className="mt-1 text-sm text-slate-600">
        Rola w aplikacji:{' '}
        <span className="font-medium text-indigo-700">{roleLabel}</span>
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Link
          href={nextHref}
          className="rounded-xl bg-indigo-50 p-5 ring-1 ring-indigo-100 transition hover:bg-indigo-100"
        >
          <h2 className="text-sm font-semibold text-indigo-900">{nextLabel}</h2>
          <p className="mt-1 text-sm leading-6 text-indigo-700">
            {profile?.role === 'teacher'
              ? 'Zarządzaj prośbami i listą uczniów.'
              : 'Znajdź nauczyciela i wyślij prośbę o nawiązanie współpracy.'}
          </p>
        </Link>

        <div className="rounded-xl bg-slate-50 p-5 ring-1 ring-slate-200">
          <h2 className="text-sm font-semibold text-slate-900">Wkrótce</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Terminarz lekcji, chat z plikami, generator zadań AI i lekcje na żywo.
          </p>
        </div>
      </div>
    </div>
  )
}
