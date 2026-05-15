'use client'

import Link from 'next/link'
import { STATUS_LABELS, STATUS_COLORS, formatDateTime } from './shared'

type StudentAssignmentRow = {
  id: string
  title: string
  status: string
  sent_at: string | null
  due_date: string | null
  submitted_at: string | null
  grade: string | null
  teacher_id: string
  teacher: { first_name: string; last_name: string } | null
}

export function StudentAssignments({ items }: { items: StudentAssignmentRow[] }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Prace domowe</h1>

      {items.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
          Nie masz jeszcze żadnych prac domowych. Pojawią się tutaj, gdy
          nauczyciel wyśle Ci zadania.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {items.map((a) => {
            const teacherName =
              `${a.teacher?.first_name ?? ''} ${a.teacher?.last_name ?? ''}`.trim() ||
              'Nauczyciel'
            const overdue =
              a.due_date &&
              new Date(a.due_date) < new Date() &&
              ['sent', 'in_progress'].includes(a.status)
            return (
              <li key={a.id}>
                <Link
                  href={`/dashboard/assignments/${a.id}`}
                  className="flex h-full flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4 transition hover:border-indigo-300 hover:bg-indigo-50/30"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-slate-900">{a.title}</h3>
                    <span
                      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[a.status] ?? 'bg-slate-100 text-slate-700'}`}
                    >
                      {STATUS_LABELS[a.status] ?? a.status}
                    </span>
                  </div>
                  <p className="text-sm text-slate-600">od {teacherName}</p>
                  <div className="mt-auto space-y-0.5 text-xs text-slate-500">
                    {a.sent_at ? (
                      <div>Wysłana: {formatDateTime(a.sent_at)}</div>
                    ) : null}
                    {a.due_date ? (
                      <div className={overdue ? 'font-semibold text-red-600' : ''}>
                        Termin: {formatDateTime(a.due_date)}
                        {overdue ? ' (po terminie)' : ''}
                      </div>
                    ) : null}
                    {a.grade ? (
                      <div className="font-semibold text-emerald-700">
                        Ocena: {a.grade}
                      </div>
                    ) : null}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
