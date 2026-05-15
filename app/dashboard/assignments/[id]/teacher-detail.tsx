'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { MathContent } from '@/components/math-content'
import { MathEditor } from '@/components/math-editor'
import {
  gradeAssignment,
  gradeAssignmentWithAI,
  sendAssignment,
  updateTaskHint,
} from '../actions'
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
  auto_grade_enabled: boolean
  ai_suggested_grade: string | null
  ai_suggested_feedback: string | null
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
  ai_suggested_correct: boolean | null
  ai_suggested_comment: string | null
  ai_graded_at: string | null
}

type Grading = { isCorrect: boolean | null; comment: string }

// Tooltip pokazywany na ✨ — nadpisuje native title="..." w HTML.
const AI_TOOLTIP = 'Sugestia AI — możesz edytować'

export function TeacherAssignmentDetail({
  assignment,
  tasks,
  studentName,
}: {
  assignment: AssignmentFull
  tasks: TaskRow[]
  studentName: string
}) {
  const router = useRouter()
  const isDraft = assignment.status === 'draft'
  const canGrade =
    assignment.status === 'submitted' || assignment.status === 'graded'
  const isAlreadyGraded = assignment.status === 'graded'

  // Czy AI już skończyło ocenianie (po pełnym pipeline)?
  const hasAISuggestion = assignment.ai_suggested_grade != null

  // Czy AI obecnie pracuje w tle? (status=submitted, auto_grade_enabled=true,
  // ale jeszcze nie ma ai_suggested_grade)
  const aiInProgress =
    assignment.status === 'submitted' &&
    assignment.auto_grade_enabled &&
    !hasAISuggestion

  // Inicjalizacja pól oceniania:
  //   • jeśli praca już oceniona (graded) — załaduj zapisane wartości
  //   • jeśli AI ma sugestie — pre-fill z AI
  //   • inaczej — puste
  const initialGrading = useMemo<Record<string, Grading>>(() => {
    return Object.fromEntries(
      tasks.map((t) => {
        if (isAlreadyGraded) {
          return [
            t.id,
            { isCorrect: t.is_correct, comment: t.teacher_comment ?? '' },
          ]
        }
        if (t.ai_suggested_correct !== null) {
          return [
            t.id,
            {
              isCorrect: t.ai_suggested_correct,
              comment: t.ai_suggested_comment ?? '',
            },
          ]
        }
        return [t.id, { isCorrect: null, comment: '' }]
      }),
    )
  }, [tasks, isAlreadyGraded])

  const [grading, setGrading] = useState<Record<string, Grading>>(initialGrading)
  const [grade, setGrade] = useState(
    isAlreadyGraded
      ? assignment.grade ?? ''
      : assignment.ai_suggested_grade ?? '',
  )
  const [feedback, setFeedback] = useState(
    isAlreadyGraded
      ? assignment.teacher_feedback ?? ''
      : assignment.ai_suggested_feedback ?? '',
  )

  // Flagi „użytkownik ruszył to pole" — sterują wyświetlaniem ikonki ✨.
  // Wszystkie zaczynają od false. onChange ustawia na true, ✨ znika.
  const [edited, setEdited] = useState<{
    grade: boolean
    feedback: boolean
    taskCorrect: Record<string, boolean>
    taskComment: Record<string, boolean>
  }>({
    grade: false,
    feedback: false,
    taskCorrect: {},
    taskComment: {},
  })

  const [busy, setBusy] = useState(false)
  const [aiBusy, setAIBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Wysyłka draftu (jeśli wszedł tu nauczyciel ze szkicu).
  const [dueDate, setDueDate] = useState('')
  const [studentMessage, setStudentMessage] = useState(
    assignment.teacher_message ?? '',
  )

  async function handleSendDraft() {
    setError(null)
    setBusy(true)
    try {
      const dueIso = dueDate ? new Date(dueDate).toISOString() : null
      await sendAssignment(assignment.id, dueIso, studentMessage)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się wysłać pracy.')
    } finally {
      setBusy(false)
    }
  }

  async function handleGrade() {
    if (!grade.trim()) {
      setError('Wpisz ocenę przed zapisaniem.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      await gradeAssignment(
        assignment.id,
        grade,
        feedback,
        Object.entries(grading).map(([taskId, g]) => ({
          taskId,
          isCorrect: g.isCorrect,
          comment: g.comment,
        })),
      )
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się ocenić pracy.')
    } finally {
      setBusy(false)
    }
  }

  async function handleAIGrade() {
    setError(null)
    setAIBusy(true)
    try {
      await gradeAssignmentWithAI(assignment.id)
      // Odśwież — props się zmienią, useMemo zainicjalizuje grading z AI suggestions.
      router.refresh()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'AI nie zdołało ocenić pracy. Spróbuj ponownie.',
      )
    } finally {
      setAIBusy(false)
    }
  }

  return (
    // Remount po zmianie sugestii AI / statusu odbywa się w rodzicu
    // ([id]/page.tsx) przez `key` na <TeacherAssignmentDetail/>. Tutaj
    // wystarczy zwykły wrapper.
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
            <p className="text-sm text-slate-600">uczeń: {studentName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {assignment.auto_grade_enabled ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800"
                title="Praca z włączonym auto-ocenianiem przez AI"
              >
                ✨ Auto-AI
              </span>
            ) : null}
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[assignment.status] ?? 'bg-slate-100 text-slate-700'}`}
            >
              {STATUS_LABELS[assignment.status] ?? assignment.status}
            </span>
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
          {assignment.grade ? <div>Ocena: {assignment.grade}</div> : null}
        </div>
      </header>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {/* Wysyłka szkicu */}
      {isDraft ? (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <div className="font-semibold text-amber-900">
            To jeszcze szkic — uczeń go nie widzi. Wyślij, żeby trafił do ucznia.
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-amber-900">
              Termin oddania (opcjonalnie)
              <input
                type="datetime-local"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm text-slate-900"
              />
            </label>
            <label className="text-xs font-medium text-amber-900">
              Wiadomość do ucznia (opcjonalnie)
              <textarea
                value={studentMessage}
                onChange={(e) => setStudentMessage(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm text-slate-900"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={handleSendDraft}
            disabled={busy}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Wysyłam…' : 'Wyślij pracę uczniowi'}
          </button>
        </div>
      ) : null}

      {/* Pasek AI — informacja o stanie auto-grading + przycisk manualny */}
      {assignment.status === 'submitted' && !isAlreadyGraded ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
          {hasAISuggestion ? (
            <p className="text-sm text-indigo-900">
              ✨ AI oceniło tę pracę. Wszystkie pola poniżej są wstępnie wypełnione
              sugestiami AI — możesz je zaakceptować, edytować lub odrzucić.
              Nic nie jest zapisane, dopóki nie klikniesz „Oceń pracę".
            </p>
          ) : aiInProgress ? (
            <p className="text-sm text-indigo-900">
              ⏳ AI właśnie ocenia tę pracę w tle. Odśwież stronę za moment lub
              oceń ręcznie.
            </p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-indigo-900">
                Możesz poprosić AI o sugestię oceny dla tej pracy.
              </p>
              <button
                type="button"
                onClick={handleAIGrade}
                disabled={aiBusy}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {aiBusy
                  ? 'AI ocenia (30–60 s)…'
                  : '✨ Oceń z pomocą AI'}
              </button>
            </div>
          )}
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
          </div>

          <MathContent text={t.content} />

          <details className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
            <summary className="cursor-pointer text-xs font-semibold text-emerald-800">
              Pokaż wzorcowe rozwiązanie
            </summary>
            <div className="mt-2">
              <MathContent text={t.expected_answer ?? '—'} />
            </div>
          </details>

          {/* Wskazówka — z możliwością edycji przez nauczyciela */}
          <TeacherHintBlock
            taskId={t.id}
            initialHint={t.hint ?? ''}
          />

          {t.student_answer !== null && t.student_answer !== '' ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                Odpowiedź ucznia
              </div>
              <MathContent text={t.student_answer} className="text-sm" />
            </div>
          ) : (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs italic text-slate-500">
              Uczeń jeszcze nie udzielił odpowiedzi na to zadanie.
            </div>
          )}

          {canGrade && t.student_answer ? (
            <div className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50 p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-indigo-900">
                <input
                  type="checkbox"
                  checked={grading[t.id]?.isCorrect === true}
                  onChange={(e) => {
                    setGrading((prev) => ({
                      ...prev,
                      [t.id]: {
                        ...prev[t.id],
                        isCorrect: e.target.checked ? true : false,
                      },
                    }))
                    setEdited((prev) => ({
                      ...prev,
                      taskCorrect: { ...prev.taskCorrect, [t.id]: true },
                    }))
                  }}
                  disabled={isAlreadyGraded}
                />
                Poprawnie
                {!isAlreadyGraded &&
                t.ai_suggested_correct !== null &&
                !edited.taskCorrect[t.id] ? (
                  <AISparkle />
                ) : null}
              </label>
              {isAlreadyGraded ? (
                grading[t.id]?.comment ? (
                  <div className="rounded-lg border border-indigo-300 bg-white p-2 text-sm text-slate-900">
                    <MathContent text={grading[t.id].comment} />
                  </div>
                ) : (
                  <div className="rounded-lg border border-indigo-200 bg-slate-50 p-2 text-xs italic text-slate-500">
                    Bez komentarza.
                  </div>
                )
              ) : (
                <div className="relative">
                  <MathEditor
                    value={grading[t.id]?.comment ?? ''}
                    onChange={(next) => {
                      setGrading((prev) => ({
                        ...prev,
                        [t.id]: { ...prev[t.id], comment: next },
                      }))
                      setEdited((prev) => ({
                        ...prev,
                        taskComment: { ...prev.taskComment, [t.id]: true },
                      }))
                    }}
                    placeholder="Komentarz do tego zadania (opcjonalnie)"
                  />
                  {t.ai_suggested_comment !== null &&
                  !edited.taskComment[t.id] ? (
                    <span className="absolute right-2 top-2 rounded bg-white px-1">
                      <AISparkle />
                    </span>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ))}

      {canGrade ? (
        <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-900">
            {isAlreadyGraded ? 'Ocena pracy' : 'Wystaw ocenę'}
          </h2>
          <label className="block text-sm font-medium text-slate-800">
            <span className="flex items-center gap-2">
              Ocena
              {!isAlreadyGraded &&
              assignment.ai_suggested_grade !== null &&
              !edited.grade ? (
                <AISparkle />
              ) : null}
            </span>
            <input
              type="text"
              value={grade}
              onChange={(e) => {
                setGrade(e.target.value)
                setEdited((prev) => ({ ...prev, grade: true }))
              }}
              disabled={isAlreadyGraded}
              placeholder="np. 5, bardzo dobrze, 18/20"
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50"
            />
          </label>
          <div className="block text-sm font-medium text-slate-800">
            <span className="flex items-center gap-2">
              Komentarz ogólny
              {!isAlreadyGraded &&
              assignment.ai_suggested_feedback !== null &&
              !edited.feedback ? (
                <AISparkle />
              ) : null}
            </span>
            {isAlreadyGraded ? (
              feedback ? (
                <div className="mt-1 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-900">
                  <MathContent text={feedback} />
                </div>
              ) : (
                <div className="mt-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs italic text-slate-500">
                  Bez komentarza ogólnego.
                </div>
              )
            ) : (
              <div className="mt-1">
                <MathEditor
                  value={feedback}
                  onChange={(next) => {
                    setFeedback(next)
                    setEdited((prev) => ({ ...prev, feedback: true }))
                  }}
                  placeholder="Podsumowanie pracy ucznia"
                />
              </div>
            )}
          </div>
          {!isAlreadyGraded ? (
            <button
              type="button"
              onClick={handleGrade}
              disabled={busy}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? 'Zapisuję…' : 'Oceń pracę'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ✨ wyświetlana obok pól pre-fillowanych przez AI; po edycji znika.
function AISparkle() {
  return (
    <span
      title={AI_TOOLTIP}
      className="cursor-help text-xs text-indigo-500"
      aria-label={AI_TOOLTIP}
    >
      ✨ AI
    </span>
  )
}

// Wskazówka w widoku nauczyciela — pokazana w boxie, opcjonalnie edytowalna.
function TeacherHintBlock({
  taskId,
  initialHint,
}: {
  taskId: string
  initialHint: string
}) {
  const [hint, setHint] = useState(initialHint)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initialHint)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function commit() {
    setErr(null)
    setSaving(true)
    try {
      await updateTaskHint(taskId, draft)
      setHint(draft)
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Nie udało się zapisać.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          💡 Wskazówka dla ucznia
        </div>
        {editing ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={commit}
              disabled={saving}
              className="rounded-md bg-amber-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {saving ? 'Zapisuję…' : 'Zapisz'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setDraft(hint)
                setErr(null)
              }}
              className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Anuluj
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setEditing(true)
              setDraft(hint)
            }}
            className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
          >
            Edytuj
          </button>
        )}
      </div>
      {err ? <div className="mb-1 text-xs text-red-700">{err}</div> : null}
      {editing ? (
        <MathEditor
          value={draft}
          onChange={setDraft}
          placeholder="Krótka podpowiedź — kierunkuje, ale nie rozwiązuje zadania."
        />
      ) : hint && hint.trim() ? (
        <MathContent text={hint} />
      ) : (
        <p className="text-xs italic text-amber-700">
          Brak wskazówki — uczeń nie widzi dla tego zadania podpowiedzi.
        </p>
      )}
    </div>
  )
}
