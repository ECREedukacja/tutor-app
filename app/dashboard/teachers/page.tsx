import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { fetchEmailsByIds } from '../actions'
import { TeacherSearch } from './teachers-client'

type RequestRow = {
  id: string
  status: 'pending' | 'accepted' | 'rejected'
  message: string | null
  created_at: string
  responded_at: string | null
  teacher_id: string
  teacher: { first_name: string; last_name: string } | null
}

const statusLabel: Record<RequestRow['status'], string> = {
  pending: 'Oczekuje',
  accepted: 'Zaakceptowana',
  rejected: 'Odrzucona',
}

const statusClass: Record<RequestRow['status'], string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  accepted: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  rejected: 'bg-slate-100 text-slate-700 ring-slate-200',
}

export default async function TeachersPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: me } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user!.id)
    .single()

  if (me?.role !== 'student') {
    redirect('/dashboard')
  }

  const { data: requestsRaw } = await supabase
    .from('student_teacher_requests')
    .select(
      'id, status, message, created_at, responded_at, teacher_id, teacher:profiles!student_teacher_requests_teacher_id_fkey(first_name, last_name)'
    )
    .eq('student_id', user!.id)
    .order('created_at', { ascending: false })

  const requests = (requestsRaw ?? []) as unknown as RequestRow[]

  const { data: linksRaw } = await supabase
    .from('teacher_students')
    .select(
      'teacher_id, teacher:profiles!teacher_students_teacher_id_fkey(first_name, last_name)'
    )
    .eq('student_id', user!.id)

  type LinkRow = {
    teacher_id: string
    teacher: { first_name: string; last_name: string } | null
  }
  const links = (linksRaw ?? []) as unknown as LinkRow[]

  const idsForEmail = Array.from(
    new Set([
      ...requests.map((r) => r.teacher_id),
      ...links.map((l) => l.teacher_id),
    ])
  )
  const emails = await fetchEmailsByIds(idsForEmail)

  return (
    <div className="space-y-8">
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-xl font-semibold text-slate-900">Wyszukaj nauczyciela</h1>
        <p className="mt-1 text-sm text-slate-600">
          Znajdź nauczyciela po imieniu, nazwisku lub adresie e-mail i wyślij mu prośbę
          o nawiązanie współpracy.
        </p>
        <div className="mt-4">
          <TeacherSearch />
        </div>
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-lg font-semibold text-slate-900">Moje prośby</h2>
        {requests.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">
            Nie wysłałeś jeszcze żadnych próśb.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {requests.map((r) => (
              <li key={r.id} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {r.teacher?.first_name} {r.teacher?.last_name}
                  </p>
                  <p className="text-xs text-slate-500">
                    {emails[r.teacher_id] ?? '—'}
                  </p>
                  {r.message && (
                    <p className="mt-1 text-sm text-slate-700">„{r.message}"</p>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    Wysłano: {new Date(r.created_at).toLocaleDateString('pl-PL')}
                  </p>
                </div>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${statusClass[r.status]}`}
                >
                  {statusLabel[r.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-lg font-semibold text-slate-900">Moi nauczyciele</h2>
        {links.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">
            Nie masz jeszcze żadnych nauczycieli.{' '}
            <Link
              href="#"
              className="font-medium text-indigo-600 hover:text-indigo-700"
            >
              Wyszukaj powyżej
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {links.map((l) => (
              <li
                key={l.teacher_id}
                className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200"
              >
                <p className="text-sm font-medium text-slate-900">
                  {l.teacher?.first_name} {l.teacher?.last_name}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {emails[l.teacher_id] ?? '—'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
