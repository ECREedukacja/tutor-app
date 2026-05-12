import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { fetchEmailsByIds } from '../actions'
import { RequestActions } from './students-client'

type RequestRow = {
  id: string
  message: string | null
  created_at: string
  student_id: string
  student: { first_name: string; last_name: string; phone: string | null } | null
}

type LinkRow = {
  student_id: string
  student:
    | { first_name: string; last_name: string; phone: string | null }
    | null
}

export default async function StudentsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: me } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user!.id)
    .single()

  if (me?.role !== 'teacher') {
    redirect('/dashboard')
  }

  const { data: pendingRaw } = await supabase
    .from('student_teacher_requests')
    .select(
      'id, message, created_at, student_id, student:profiles!student_teacher_requests_student_id_fkey(first_name, last_name, phone)'
    )
    .eq('teacher_id', user!.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  const pending = (pendingRaw ?? []) as unknown as RequestRow[]

  const { data: linksRaw } = await supabase
    .from('teacher_students')
    .select(
      'student_id, student:profiles!teacher_students_student_id_fkey(first_name, last_name, phone)'
    )
    .eq('teacher_id', user!.id)

  const links = (linksRaw ?? []) as unknown as LinkRow[]

  const idsForEmail = Array.from(
    new Set([
      ...pending.map((p) => p.student_id),
      ...links.map((l) => l.student_id),
    ])
  )
  const emails = await fetchEmailsByIds(idsForEmail)

  return (
    <div className="space-y-8">
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900">Oczekujące prośby</h1>
          {pending.length > 0 && (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold leading-none text-white">
              {pending.length}
            </span>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">
            Brak nowych próśb od uczniów.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {pending.map((r) => (
              <li
                key={r.id}
                className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {r.student?.first_name} {r.student?.last_name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {emails[r.student_id] ?? '—'}
                      {r.student?.phone ? ` · ${r.student.phone}` : ''}
                    </p>
                    {r.message && (
                      <p className="mt-2 text-sm text-slate-700">„{r.message}"</p>
                    )}
                    <p className="mt-1 text-xs text-slate-500">
                      {new Date(r.created_at).toLocaleDateString('pl-PL')}
                    </p>
                  </div>
                  <RequestActions requestId={r.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-lg font-semibold text-slate-900">Moi uczniowie</h2>
        {links.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">
            Jeszcze nie masz przypisanych uczniów.
          </p>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {links.map((l) => (
              <li
                key={l.student_id}
                className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200"
              >
                <p className="text-sm font-medium text-slate-900">
                  {l.student?.first_name} {l.student?.last_name}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {emails[l.student_id] ?? '—'}
                </p>
                {l.student?.phone && (
                  <p className="text-xs text-slate-500">{l.student.phone}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
