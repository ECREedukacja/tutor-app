'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MathContent } from '@/components/math-content'
import { MathEditor } from '@/components/math-editor'
import { saveStudentAnswer, submitAssignment } from '../actions'
import {
  STATUS_LABELS,
  STATUS_COLORS,
  TASK_TYPE_LABELS,
  formatDateTime,
} from '../shared'

type AssignmentFull = {
  id: string
  status: string
  title: string
  topic: string | null
  grade_level: string | null
  difficulty: string | null
  due_date: string | null
  sent_at: string | null
  submitted_at: string | null
  grade: string | null
  teacher_feedback: string | null
  teacher_message: string | null
}

type TaskRow = {
  id: string
  order_index: number
  content: string
  task_type: string | null
  expected_answer: string | null
  student_answer: string | null
  is_correct: boolean | null
  teacher_comment: string | null
  hint: string | null
}

const AUTO_SAVE_MS = 30_000

export function StudentAssignmentDetail({
  assignment,
  tasks,
  teacherName,
}: {
  assignment: AssignmentFull
  tasks: TaskRow[]
  teacherName: string
}) {
  const router = useRouter()
  const isReadOnly =
    assignment.status === 'submitted' || assignment.status === 'graded'

  // Mapa odpowiedzi w pamięci.
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(tasks.map((t) => [t.id, t.student_answer ?? ''])),
  )
  // Ostatnio zapisane wartości — żeby nie wysyłać zbędnych zapisów.
  const savedRef = useRef<Record<string, string>>(
    Object.fromEntries(tasks.map((t) => [t.id, t.student_answer ?? ''])),
  )
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const saveAnswer = useCallback(
    async (taskId: string) => {
      const current = answers[taskId] ?? ''
      if (current === savedRef.current[taskId]) return
      setSaving(true)
      try {
        await saveStudentAnswer(taskId, current, assignment.id)
        savedRef.current[taskId] = current
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Nie udało się zapisać odpowiedzi.')
      } finally {
        setSaving(false)
      }
    },
    [answers, assignment.id],
  )

  // Auto-save co 30 s (jeśli były zmiany).
  useEffect(() => {
    if (isReadOnly) return
    const t = setInterval(() => {
      for (const taskId of Object.keys(answers)) {
        if (answers[taskId] !== savedRef.current[taskId]) {
          void saveAnswer(taskId)
        }
      }
    }, AUTO_SAVE_MS)
    return () => clearInterval(t)
  }, [answers, isReadOnly, saveAnswer])

  const allAnswered = useMemo(
    () => tasks.every((t) => (answers[t.id] ?? '').trim().length > 0),
    [tasks, answers],
  )

  async function handleSubmit() {
    if (!confirm('Oddać pracę? Po oddaniu nie będziesz mógł zmienić odpowiedzi.')) {
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      // Najpierw flush zmian.
      for (const taskId of Object.keys(answers)) {
        if (answers[taskId] !== savedRef.current[taskId]) {
          await saveStudentAnswer(taskId, answers[taskId], assignment.id)
          savedRef.current[taskId] = answers[taskId]
        }
      }
      await submitAssignment(assignment.id)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się oddać pracy.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/assignments"
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          ← Prace domowe
        </Link>
      </div>

      <header className="space-y-2 rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              {assignment.title}
            </h1>
            <p className="text-sm text-slate-600">od {teacherName}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[assignment.status] ?? 'bg-slate-100 text-slate-700'}`}
            >
              {STATUS_LABELS[assignment.status] ?? assignment.status}
            </span>
            {assignment.grade ? (
              <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                Ocena: {assignment.grade}
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
          {assignment.sent_at ? (
            <div>Wysłana: {formatDateTime(assignment.sent_at)}</div>
          ) : null}
          {assignment.due_date ? (
            <div>Termin oddania: {formatDateTime(assignment.due_date)}</div>
          ) : null}
          {assignment.submitted_at ? (
            <div>Oddana: {formatDateTime(assignment.submitted_at)}</div>
          ) : null}
        </div>

        {assignment.teacher_message ? (
          <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-900">
            <div className="font-semibold">Wiadomość od nauczyciela</div>
            <div className="whitespace-pre-wrap">{assignment.teacher_message}</div>
          </div>
        ) : null}

        {assignment.teacher_feedback ? (
          <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <div className="font-semibold">Komentarz ogólny od nauczyciela</div>
            <MathContent text={assignment.teacher_feedback} />
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {tasks.map((t, idx) => (
        <div key={t.id} className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">
                Zadanie {idx + 1}
              </div>
              {t.task_type ? (
                <div className="text-xs text-slate-500">
                  {TASK_TYPE_LABELS[t.task_type] ?? t.task_type}
                </div>
              ) : null}
            </div>
            {assignment.status === 'graded' && t.is_correct !== null ? (
              <span
                className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  t.is_correct
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-red-100 text-red-800'
                }`}
              >
                {t.is_correct ? '✓ Poprawnie' : '✕ Niepoprawnie'}
              </span>
            ) : null}
          </div>

          <MathContent text={t.content} />

          {t.hint && t.hint.trim() ? (
            <HintBlock assignmentId={assignment.id} taskId={t.id} hint={t.hint} />
          ) : null}

          <div className="space-y-1">
            <label className="text-sm font-medium text-slate-800">
              Twoja odpowiedź
            </label>
            {isReadOnly ? (
              answers[t.id] ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <MathContent text={answers[t.id]} className="text-sm" />
                </div>
              ) : (
                <div className="min-h-20 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-400">
                  brak odpowiedzi
                </div>
              )
            ) : (
              <MathEditor
                value={answers[t.id] ?? ''}
                onChange={(next) =>
                  setAnswers((prev) => ({ ...prev, [t.id]: next }))
                }
                onBlur={() => void saveAnswer(t.id)}
                placeholder="Wpisz swoją odpowiedź…"
              />
            )}
          </div>

          {assignment.status === 'graded' && t.teacher_comment ? (
            <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
              <div className="text-xs font-semibold uppercase tracking-wide">
                Komentarz nauczyciela
              </div>
              <MathContent text={t.teacher_comment} />
            </div>
          ) : null}
        </div>
      ))}

      {!isReadOnly ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4">
          <div className="text-xs text-slate-500">
            {saving ? 'Zapisuję…' : 'Odpowiedzi zapisują się automatycznie.'}
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !allAnswered}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            title={
              !allAnswered ? 'Wypełnij wszystkie zadania przed oddaniem.' : undefined
            }
          >
            {submitting ? 'Oddaję…' : 'Oddaj pracę'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

// Rozwijana wskazówka. Stan rozwinięcia per zadanie zapisany w sessionStorage,
// żeby przeżył przeładowanie strony, ale resetuje się przy nowej sesji
// przeglądarki (zgodnie z UX: uczeń otwierający pracę „od nowa" widzi
// wskazówki domyślnie zwinięte).
function HintBlock({
  assignmentId,
  taskId,
  hint,
}: {
  assignmentId: string
  taskId: string
  hint: string
}) {
  const storageKey = `tutor:hint:${assignmentId}:${taskId}`
  const [open, setOpen] = useState(false)

  // Po hydracji odczyt z sessionStorage. Robimy to w efekcie, żeby SSR
  // i pierwszy klient render miały spójny output (zwinięty).
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (sessionStorage.getItem(storageKey) === '1') setOpen(true)
    } catch {
      // sessionStorage może być zablokowany w trybie prywatnym — ignorujemy.
    }
  }, [storageKey])

  function toggle() {
    setOpen((prev) => {
      const next = !prev
      try {
        if (typeof window !== 'undefined') {
          if (next) sessionStorage.setItem(storageKey, '1')
          else sessionStorage.removeItem(storageKey)
        }
      } catch {
        // ignorujemy
      }
      return next
    })
  }

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-amber-900 hover:bg-amber-100"
      >
        <span>💡 Wskazówka</span>
        <span aria-hidden className="text-xs">
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open ? (
        <div className="border-t border-amber-200 px-3 py-2">
          <MathContent text={hint} />
        </div>
      ) : null}
    </div>
  )
}
