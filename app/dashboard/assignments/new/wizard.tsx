'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MathContent } from '@/components/math-content'
import { MathEditor } from '@/components/math-editor'
import {
  generateAssignmentTasks,
  saveAssignment,
  sendAssignment,
  type GeneratedTask,
  type GenerationParams,
} from '../actions'
import { DIFFICULTY_LABELS, TASK_TYPE_LABELS } from '../shared'

type Student = { id: string; first_name: string; last_name: string }
type Step = 1 | 2 | 3

const DIFFICULTY_OPTIONS: GenerationParams['difficulty'][] = [
  'easy',
  'medium',
  'hard',
  'mixed',
]

export function AssignmentWizard({ students }: { students: Student[] }) {
  const router = useRouter()
  const [step, setStep] = useState<Step>(1)

  // Krok 1
  const [title, setTitle] = useState('')
  const [studentId, setStudentId] = useState(students[0]?.id ?? '')
  const [topic, setTopic] = useState('')
  const [gradeLevel, setGradeLevel] = useState('')
  const [difficulty, setDifficulty] = useState<GenerationParams['difficulty']>('medium')
  const [taskCount, setTaskCount] = useState(5)
  const [customPrompt, setCustomPrompt] = useState('')

  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Krok 2
  const [tasks, setTasks] = useState<GeneratedTask[]>([])
  const [generatedTitle, setGeneratedTitle] = useState('')
  const [showAnswers, setShowAnswers] = useState<Record<number, boolean>>({})
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // Edycja wskazówki per zadanie (osobna od edycji treści — nauczyciel może
  // mieć otwartą edycję treści i wskazówki w różnych zadaniach niezależnie).
  const [editingHintIndex, setEditingHintIndex] = useState<number | null>(null)
  const [hintDraft, setHintDraft] = useState('')

  // Krok 3
  const [dueDate, setDueDate] = useState('')
  const [studentMessage, setStudentMessage] = useState('')
  const [autoGradeEnabled, setAutoGradeEnabled] = useState(false)
  const [sending, setSending] = useState(false)

  function studentLabel(s: Student) {
    return `${s.first_name} ${s.last_name}`.trim() || 'Uczeń'
  }

  async function handleGenerate(replace: boolean, append: boolean) {
    if (!studentId) {
      setError('Wybierz ucznia.')
      return
    }
    setError(null)
    setGenerating(true)
    try {
      const result = await generateAssignmentTasks(
        {
          subject: 'mathematics',
          topic,
          grade_level: gradeLevel,
          difficulty,
          task_count: taskCount,
          custom_prompt: customPrompt,
        },
        append ? { existingTasks: tasks } : undefined,
      )
      if (replace || tasks.length === 0) {
        setTasks(result.tasks)
        setGeneratedTitle(result.assignment_title)
      } else if (append) {
        setTasks((prev) => [...prev, ...result.tasks])
      }
      setStep(2)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się wygenerować zadań.')
    } finally {
      setGenerating(false)
    }
  }

  function startEditTask(idx: number) {
    setEditingIndex(idx)
    setEditDraft(tasks[idx].content)
  }

  function commitEditTask() {
    if (editingIndex === null) return
    setTasks((prev) =>
      prev.map((t, i) =>
        i === editingIndex ? { ...t, content: editDraft } : t,
      ),
    )
    setEditingIndex(null)
    setEditDraft('')
  }

  function startEditHint(idx: number) {
    setEditingHintIndex(idx)
    setHintDraft(tasks[idx].hint ?? '')
  }

  function commitEditHint() {
    if (editingHintIndex === null) return
    setTasks((prev) =>
      prev.map((t, i) =>
        i === editingHintIndex ? { ...t, hint: hintDraft } : t,
      ),
    )
    setEditingHintIndex(null)
    setHintDraft('')
  }

  function deleteTask(idx: number) {
    setTasks((prev) =>
      prev.filter((_, i) => i !== idx).map((t, i) => ({ ...t, order_index: i + 1 })),
    )
  }

  async function handleSendAndSave() {
    if (tasks.length === 0) {
      setError('Praca musi zawierać co najmniej jedno zadanie.')
      return
    }
    setError(null)
    setSending(true)
    try {
      const finalTitle = (title.trim() || generatedTitle.trim() || 'Praca domowa').slice(0, 200)
      const { id } = await saveAssignment({
        studentId,
        title: finalTitle,
        topic,
        gradeLevel,
        difficulty,
        customPrompt,
        tasks,
        autoGradeEnabled,
      })
      const dueIso = dueDate ? new Date(dueDate).toISOString() : null
      await sendAssignment(id, dueIso, studentMessage)
      router.push('/dashboard/assignments')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nie udało się wysłać pracy.')
      setSending(false)
    }
  }

  const studentName = studentLabel(
    students.find((s) => s.id === studentId) ?? students[0]!,
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/dashboard/assignments"
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          ← Prace domowe
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">Nowa praca domowa</h1>
      </div>

      {/* Pasek kroków */}
      <ol className="flex items-center gap-2 text-xs font-medium">
        {[
          { n: 1, label: 'Formularz' },
          { n: 2, label: 'Podgląd' },
          { n: 3, label: 'Wyślij' },
        ].map((s, i, arr) => (
          <li key={s.n} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full ${
                step === s.n
                  ? 'bg-indigo-600 text-white'
                  : step > s.n
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-slate-200 text-slate-600'
              }`}
            >
              {step > s.n ? '✓' : s.n}
            </span>
            <span
              className={
                step === s.n
                  ? 'text-indigo-700'
                  : step > s.n
                    ? 'text-emerald-700'
                    : 'text-slate-500'
              }
            >
              {s.label}
            </span>
            {i < arr.length - 1 ? (
              <span className="ml-1 h-px w-8 bg-slate-300" />
            ) : null}
          </li>
        ))}
      </ol>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-medium">Wystąpił błąd</div>
          <div>{error}</div>
        </div>
      ) : null}

      {/* KROK 1 — formularz */}
      {step === 1 ? (
        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
          <Field label="Tytuł pracy (opcjonalnie — AI zaproponuje, jeśli puste)">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="np. Równania kwadratowe — zestaw 1"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </Field>

          <Field label="Uczeń">
            <select
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            >
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {studentLabel(s)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Przedmiot">
            <select
              disabled
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
            >
              <option>Matematyka</option>
            </select>
          </Field>

          <Field label="Temat">
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="np. równania kwadratowe, trygonometria"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </Field>

          <Field label="Poziom">
            <input
              type="text"
              value={gradeLevel}
              onChange={(e) => setGradeLevel(e.target.value)}
              placeholder="np. klasa 8, matura podstawowa"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </Field>

          <Field label="Trudność">
            <div className="flex flex-wrap gap-2">
              {DIFFICULTY_OPTIONS.map((d) => (
                <label
                  key={d}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
                    difficulty === d
                      ? 'border-indigo-500 bg-indigo-50 text-indigo-800'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="difficulty"
                    value={d}
                    checked={difficulty === d}
                    onChange={() => setDifficulty(d)}
                    className="sr-only"
                  />
                  {DIFFICULTY_LABELS[d]}
                </label>
              ))}
            </div>
          </Field>

          <Field label={`Liczba zadań: ${taskCount}`}>
            <input
              type="range"
              min={1}
              max={10}
              value={taskCount}
              onChange={(e) => setTaskCount(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-slate-500">
              <span>1</span>
              <span>10</span>
            </div>
          </Field>

          <Field label="Dodatkowe wskazówki (opcjonalnie)">
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={4}
              placeholder='np. "Zadania mają zawierać zastosowania praktyczne", "Skup się na wzorach Viète&apos;a"'
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </Field>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={() => handleGenerate(true, false)}
              disabled={generating}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {generating ? 'Generuję zadania, to może potrwać 10–30 sekund…' : 'Generuj zadania'}
            </button>
          </div>
        </div>
      ) : null}

      {/* KROK 2 — podgląd */}
      {step === 2 ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-sm text-slate-600">Tytuł zaproponowany przez AI:</div>
            <div className="text-base font-semibold text-slate-900">
              {title.trim() || generatedTitle || 'Praca domowa'}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Uczeń: {studentName} · Trudność: {DIFFICULTY_LABELS[difficulty]} ·{' '}
              Zadań: {tasks.length}
            </div>
          </div>

          {tasks.map((t, idx) => (
            <div
              key={idx}
              className="space-y-2 rounded-lg border border-slate-200 bg-white p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    Zadanie {idx + 1}
                  </div>
                  <div className="text-xs text-slate-500">
                    {TASK_TYPE_LABELS[t.task_type] ?? t.task_type}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {editingIndex === idx ? (
                    <>
                      <button
                        type="button"
                        onClick={commitEditTask}
                        className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                      >
                        Zapisz
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingIndex(null)
                          setEditDraft('')
                        }}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Anuluj
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => startEditTask(idx)}
                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Edytuj treść
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteTask(idx)}
                        className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                      >
                        Usuń zadanie
                      </button>
                    </>
                  )}
                </div>
              </div>

              {editingIndex === idx ? (
                <MathEditor
                  value={editDraft}
                  onChange={setEditDraft}
                  placeholder="Treść zadania…"
                />
              ) : (
                <MathContent text={t.content} />
              )}

              <div>
                <button
                  type="button"
                  onClick={() =>
                    setShowAnswers((prev) => ({ ...prev, [idx]: !prev[idx] }))
                  }
                  className="text-xs font-medium text-indigo-700 hover:underline"
                >
                  {showAnswers[idx] ? 'Ukryj rozwiązanie' : 'Pokaż rozwiązanie'}
                </button>
                {showAnswers[idx] ? (
                  <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-3">
                    <MathContent text={t.expected_answer} />
                  </div>
                ) : null}
              </div>

              {/* Wskazówka dla ucznia */}
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                    💡 Wskazówka dla ucznia
                  </div>
                  {editingHintIndex === idx ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={commitEditHint}
                        className="rounded-md bg-amber-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-700"
                      >
                        Zapisz
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingHintIndex(null)
                          setHintDraft('')
                        }}
                        className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                      >
                        Anuluj
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEditHint(idx)}
                      className="rounded-md border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                    >
                      Edytuj
                    </button>
                  )}
                </div>
                {editingHintIndex === idx ? (
                  <MathEditor
                    value={hintDraft}
                    onChange={setHintDraft}
                    placeholder="Krótka podpowiedź — kierunkuje, ale nie rozwiązuje zadania."
                  />
                ) : t.hint && t.hint.trim() ? (
                  <MathContent text={t.hint} />
                ) : (
                  <p className="text-xs italic text-amber-700">
                    Brak wskazówki — uczeń nie zobaczy tego zadania z podpowiedzią.
                  </p>
                )}
              </div>
            </div>
          ))}

          <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-4">
            <button
              type="button"
              onClick={() => handleGenerate(true, false)}
              disabled={generating}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {generating ? 'Generuję…' : 'Wygeneruj nowe zadania'}
            </button>
            <button
              type="button"
              onClick={() => handleGenerate(false, true)}
              disabled={generating}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {generating ? 'Generuję…' : 'Dogeneruj kolejne'}
            </button>
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Wróć do formularza
            </button>
            <div className="ml-auto">
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={tasks.length === 0}
                className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Zapisz i wyślij →
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* KROK 3 — wysyłka */}
      {step === 3 ? (
        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
          <Field label="Termin oddania (opcjonalnie)">
            <input
              type="datetime-local"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </Field>

          <Field label="Wiadomość do ucznia (opcjonalnie)">
            <textarea
              value={studentMessage}
              onChange={(e) => setStudentMessage(e.target.value)}
              rows={3}
              placeholder="np. Skup się na zadaniach 3 i 5 — będą na sprawdzianie."
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
            />
          </Field>

          {/* Toggle automatycznego oceniania przez AI */}
          <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={autoGradeEnabled}
                onChange={(e) => setAutoGradeEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <div className="space-y-1">
                <div className="text-sm font-semibold text-indigo-900">
                  ✨ Włącz automatyczne ocenianie przez AI po oddaniu
                </div>
                <p className="text-xs text-indigo-800">
                  AI sprawdzi każde zadanie i zaproponuje komentarze oraz ocenę.
                  Ty zachowasz pełną kontrolę — możesz zaakceptować, edytować lub
                  odrzucić sugestie.
                </p>
              </div>
            </label>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="mb-2 font-semibold text-slate-900">Podsumowanie</div>
            <ul className="space-y-1 text-slate-700">
              <li>Uczeń: {studentName}</li>
              <li>Liczba zadań: {tasks.length}</li>
              <li>
                Termin oddania:{' '}
                {dueDate
                  ? new Date(dueDate).toLocaleString('pl-PL')
                  : 'bez terminu'}
              </li>
              <li>
                Auto-ocena AI:{' '}
                {autoGradeEnabled ? 'tak — sugestie po oddaniu' : 'nie'}
              </li>
            </ul>
          </div>

          <div className="flex justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              ← Wróć do podglądu
            </button>
            <button
              type="button"
              onClick={handleSendAndSave}
              disabled={sending}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {sending ? 'Wysyłam…' : 'Wyślij pracę domową'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-slate-800">{label}</label>
      {children}
    </div>
  )
}
