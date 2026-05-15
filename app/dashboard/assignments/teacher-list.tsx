'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteAssignment } from './actions'
import { STATUS_LABELS, STATUS_COLORS, formatDateTime } from './shared'

export type StudentLite = {
  id: string
  first_name: string
  last_name: string
}

type AssignmentRow = {
  id: string
  title: string
  status: string
  created_at: string
  sent_at: string | null
  due_date: string | null
  submitted_at: string | null
  grade: string | null
  student_id: string
}

type StatusFilter = 'all' | 'pending' | 'submitted'

export function TeacherAssignments({
  students,
  assignments,
}: {
  teacherId: string
  students: StudentLite[]
  assignments: AssignmentRow[]
}) {
  const router = useRouter()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [studentFilter, setStudentFilter] = useState<string>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const studentName = (id: string) => {
    const s = students.find((x) => x.id === id)
    if (!s) return 'Uczeń'
    const full = `${s.first_name} ${s.last_name}`.trim()
    return full || 'Uczeń'
  }

  const filtered = useMemo(() => {
    return assignments.filter((a) => {
      if (statusFilter === 'pending' && !['draft', 'sent', 'in_progress'].includes(a.status)) {
        return false
      }
      if (statusFilter === 'submitted' && !['submitted', 'graded'].includes(a.status)) {
        return false
      }
      if (studentFilter !== 'all' && a.student_id !== studentFilter) return false
      return true
    })
  }, [assignments, statusFilter, studentFilter])

  async function handleDelete(id: string) {
    if (!confirm('Usunąć tę pracę domową? Tej operacji nie można cofnąć.')) return
    setBusyId(id)
    try {
      await deleteAssignment(id)
      startTransition(() => router.refresh())
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Nie udało się usunąć pracy.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">Prace domowe</h1>
        {students.length > 0 ? (
          <Link
            href="/dashboard/assignments/new"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
          >
            + Nowa praca domowa
          </Link>
        ) : null}
      </div>

      {students.length === 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Nie masz jeszcze żadnego ucznia powiązanego ze swoim kontem. Aby
          generować prace domowe, najpierw zaakceptuj prośbę ucznia w sekcji{' '}
          <Link href="/dashboard/students" className="font-semibold underline">
            Moi uczniowie
          </Link>
          .
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-4 rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-col">
              <label className="mb-1 text-xs font-medium text-slate-600">
                Status
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800"
              >
                <option value="all">Wszystkie</option>
                <option value="pending">Oczekujące</option>
                <option value="submitted">Oddane / ocenione</option>
              </select>
            </div>
            <div className="flex flex-col">
              <label className="mb-1 text-xs font-medium text-slate-600">
                Uczeń
              </label>
              <select
                value={studentFilter}
                onChange={(e) => setStudentFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800"
              >
                <option value="all">Wszyscy</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {`${s.first_name} ${s.last_name}`.trim() || 'Uczeń'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
              Brak prac domowych spełniających filtry.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-4 py-3">Tytuł</th>
                    <th className="px-4 py-3">Uczeń</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Wysłana</th>
                    <th className="px-4 py-3">Termin</th>
                    <th className="px-4 py-3 text-right">Akcje</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">{a.title}</td>
                      <td className="px-4 py-3 text-slate-700">
                        {studentName(a.student_id)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[a.status] ?? 'bg-slate-100 text-slate-700'}`}
                        >
                          {STATUS_LABELS[a.status] ?? a.status}
                        </span>
                        {a.grade ? (
                          <span className="ml-2 text-xs font-medium text-emerald-700">
                            {a.grade}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {a.sent_at ? formatDateTime(a.sent_at) : '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {a.due_date ? formatDateTime(a.due_date) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex gap-2">
                          <Link
                            href={`/dashboard/assignments/${a.id}`}
                            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                          >
                            Podgląd
                          </Link>
                          {['draft', 'sent'].includes(a.status) ? (
                            <button
                              type="button"
                              disabled={busyId === a.id}
                              onClick={() => handleDelete(a.id)}
                              className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                            >
                              Usuń
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
