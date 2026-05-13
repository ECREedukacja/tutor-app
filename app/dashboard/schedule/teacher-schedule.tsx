'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  HOURS_START,
  LESSON_MINUTES,
  LESSON_SPAN,
  type LessonMode,
  addDays,
  addMinutes,
  dayIndexInWeek,
  formatDateLong,
  formatTime,
  getWeekStart,
  gridRowFor,
  modeIcon,
  modeLabel,
} from '@/lib/calendar'
import { WeekCalendar, type CalendarBlock } from '../calendar/week-calendar'
import { WeekNav } from '../calendar/week-nav'
import {
  ModalShell,
  TIME_OPTIONS,
  combineDateTimeLocal,
  toLocalDateInput,
  toLocalTimeInput,
} from './shared'
import {
  cancelLesson,
  createAvailability,
  createProposal,
  deleteAvailability,
  rescheduleLessonDirectly,
  scheduleLessonDirectly,
} from './actions'
import type { Proposal } from './types'
import { ProposalsSection } from './proposals-section'

export type StudentInfo = {
  id: string
  first_name: string
  last_name: string
}

type Availability = {
  id: string
  start_at: string
  duration_minutes: number
}

type Lesson = {
  id: string
  start_at: string
  duration_minutes: number
  mode: LessonMode
  student_id: string
  student: { first_name: string; last_name: string } | null
}

export function TeacherSchedule({
  teacherId,
  teacherAddress,
  students,
}: {
  teacherId: string
  teacherAddress: string | null
  students: StudentInfo[]
}) {
  const supabase = useMemo(() => createClient(), [])
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()))
  const [slots, setSlots] = useState<Availability[]>([])
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)

  const [addModal, setAddModal] = useState<{ date: Date } | null>(null)
  const [slotModal, setSlotModal] = useState<Availability | null>(null)
  const [lessonModal, setLessonModal] = useState<Lesson | null>(null)
  const [scheduleModal, setScheduleModal] = useState(false)
  const [rescheduleModal, setRescheduleModal] = useState<Lesson | null>(null)
  const [cancelModal, setCancelModal] = useState<Lesson | null>(null)

  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart])
  const studentById = useMemo(() => {
    const m = new Map<string, StudentInfo>()
    for (const s of students) m.set(s.id, s)
    return m
  }, [students])

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: slotsData }, { data: lessonsData }, { data: proposalsData }] =
      await Promise.all([
        supabase
          .from('availability')
          .select('id, start_at, duration_minutes')
          .eq('teacher_id', teacherId)
          .gte('start_at', weekStart.toISOString())
          .lt('start_at', weekEnd.toISOString())
          .order('start_at'),
        supabase
          .from('lessons')
          .select(
            'id, start_at, duration_minutes, mode, student_id, student:profiles!lessons_student_id_fkey(first_name, last_name)',
          )
          .eq('teacher_id', teacherId)
          .eq('status', 'scheduled')
          .gte('start_at', weekStart.toISOString())
          .lt('start_at', weekEnd.toISOString())
          .order('start_at'),
        supabase
          .from('lesson_proposals')
          .select(
            'id, kind, teacher_id, student_id, proposer_id, original_lesson_id, start_at, duration_minutes, mode, status, created_at, original_lesson:lessons!lesson_proposals_original_lesson_id_fkey(start_at, mode)',
          )
          .eq('teacher_id', teacherId)
          .order('created_at', { ascending: false }),
      ])
    setSlots((slotsData ?? []) as Availability[])
    setLessons((lessonsData ?? []) as unknown as Lesson[])
    setProposals((proposalsData ?? []) as unknown as Proposal[])
    setLoading(false)
  }, [supabase, teacherId, weekStart, weekEnd])

  useEffect(() => {
    load()
  }, [load])

  // Realtime: zmiany w mojej availability/lessons + propozycje (na całej tabeli;
  // RLS ogranicza widoczność do mojej pary).
  useEffect(() => {
    const channel = supabase
      .channel(`teacher-schedule-${teacherId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'availability',
          filter: `teacher_id=eq.${teacherId}`,
        },
        () => load(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lessons',
          filter: `teacher_id=eq.${teacherId}`,
        },
        () => load(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lesson_proposals',
          filter: `teacher_id=eq.${teacherId}`,
        },
        () => load(),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [supabase, teacherId, load])

  const blocks = useMemo<CalendarBlock[]>(() => {
    const out: CalendarBlock[] = []
    for (const s of slots) {
      const d = new Date(s.start_at)
      const dayIdx = dayIndexInWeek(d, weekStart)
      const row = gridRowFor(d)
      if (dayIdx === null || row === null) continue
      out.push({
        id: `s-${s.id}`,
        dayIdx,
        slotIdx: row - 1,
        spanSlots: LESSON_SPAN,
        className:
          'bg-emerald-100 border-emerald-500 text-emerald-900 hover:bg-emerald-200',
        content: (
          <div className="space-y-0.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
              Wolny termin
            </p>
            <p className="text-sm font-medium tabular-nums">
              {formatTime(d)}–{formatTime(addMinutes(d, LESSON_MINUTES))}
            </p>
          </div>
        ),
        onClick: () => setSlotModal(s),
      })
    }
    for (const l of lessons) {
      const d = new Date(l.start_at)
      const dayIdx = dayIndexInWeek(d, weekStart)
      const row = gridRowFor(d)
      if (dayIdx === null || row === null) continue
      const fullName = l.student
        ? `${l.student.first_name} ${l.student.last_name}`
        : 'Uczeń'
      out.push({
        id: `l-${l.id}`,
        dayIdx,
        slotIdx: row - 1,
        spanSlots: LESSON_SPAN,
        className:
          'bg-indigo-100 border-indigo-500 text-indigo-900 hover:bg-indigo-200',
        content: (
          <div className="space-y-0.5">
            <p className="truncate text-sm font-medium">
              <span aria-hidden>{modeIcon(l.mode)}</span> {fullName}
            </p>
            <p className="text-[11px] tabular-nums opacity-80">
              {formatTime(d)}–{formatTime(addMinutes(d, LESSON_MINUTES))}
            </p>
          </div>
        ),
        onClick: () => setLessonModal(l),
      })
    }
    return out
  }, [slots, lessons, weekStart])

  const myProposals = proposals.filter((p) => p.proposer_id === teacherId)
  const incomingProposals = proposals.filter(
    (p) => p.proposer_id !== teacherId && p.status === 'pending',
  )

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-slate-900">Mój terminarz</h1>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setScheduleModal(true)}
              disabled={students.length === 0}
              className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
              title={
                students.length === 0
                  ? 'Brak uczniów — najpierw zaakceptuj prośby o powiązanie'
                  : ''
              }
            >
              📅 Umów lekcję
            </button>
            <button
              type="button"
              onClick={() => {
                const d = new Date(weekStart)
                d.setHours(HOURS_START, 0, 0, 0)
                setAddModal({ date: d })
              }}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700"
            >
              + Dodaj wolny termin
            </button>
          </div>
        </div>
        <WeekNav weekStart={weekStart} onChange={setWeekStart} />
        {loading && (
          <p className="mt-2 text-xs text-slate-400">Ładowanie terminarza…</p>
        )}
      </div>

      <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <WeekCalendar
          weekStart={weekStart}
          blocks={blocks}
          onEmptyClick={(d) => setAddModal({ date: d })}
        />
      </div>

      <ProposalsSection
        myProposals={myProposals}
        incomingProposals={incomingProposals}
        currentUserId={teacherId}
        teacherAddress={teacherAddress}
        getCounterpartLabel={(p) => {
          const s = studentById.get(p.student_id)
          return s ? `${s.first_name} ${s.last_name}` : 'Uczeń'
        }}
      />

      {addModal && (
        <AddSlotModal
          initial={addModal.date}
          onClose={() => setAddModal(null)}
          onSaved={() => {
            setAddModal(null)
            load()
          }}
        />
      )}

      {slotModal && (
        <SlotDetailsModal
          slot={slotModal}
          onClose={() => setSlotModal(null)}
          onDeleted={() => {
            setSlotModal(null)
            load()
          }}
        />
      )}

      {lessonModal && (
        <LessonDetailsModal
          lesson={lessonModal}
          teacherAddress={teacherAddress}
          onClose={() => setLessonModal(null)}
          onReschedule={() => {
            setRescheduleModal(lessonModal)
            setLessonModal(null)
          }}
          onCancel={() => {
            setCancelModal(lessonModal)
            setLessonModal(null)
          }}
        />
      )}

      {cancelModal && (
        <CancelLessonConfirmModal
          lesson={cancelModal}
          onClose={() => setCancelModal(null)}
          onCancelled={() => {
            setCancelModal(null)
            load()
          }}
        />
      )}

      {scheduleModal && (
        <ScheduleLessonModal
          teacherId={teacherId}
          teacherAddress={teacherAddress}
          students={students}
          onClose={() => setScheduleModal(false)}
          onSaved={() => {
            setScheduleModal(false)
            load()
          }}
        />
      )}

      {rescheduleModal && (
        <RescheduleLessonModal
          lesson={rescheduleModal}
          teacherId={teacherId}
          teacherAddress={teacherAddress}
          onClose={() => setRescheduleModal(null)}
          onSaved={() => {
            setRescheduleModal(null)
            load()
          }}
        />
      )}
    </div>
  )
}

// ---------------- Modale ----------------

function AddSlotModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: Date
  onClose: () => void
  onSaved: () => void
}) {
  const initialDateStr = toLocalDateInput(initial)
  const initTime = toLocalTimeInput(initial)
  const initialTimeStr = TIME_OPTIONS.includes(initTime) ? initTime : TIME_OPTIONS[0]

  const [date, setDate] = useState(initialDateStr)
  const [time, setTime] = useState(initialTimeStr)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () => {
    setError(null)
    const local = combineDateTimeLocal(date, time)
    if (local.getTime() <= Date.now()) {
      setError('Termin musi być w przyszłości.')
      return
    }
    startTransition(async () => {
      try {
        await createAvailability(local.toISOString())
        onSaved()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się zapisać.')
      }
    })
  }

  return (
    <ModalShell title="Dodaj wolny termin" onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-900">Data</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-900">
            Godzina (lekcja 45 min)
          </span>
          <select
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Anuluj
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? 'Zapisywanie…' : 'Zapisz termin'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

function SlotDetailsModal({
  slot,
  onClose,
  onDeleted,
}: {
  slot: Availability
  onClose: () => void
  onDeleted: () => void
}) {
  const d = new Date(slot.start_at)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const remove = () => {
    setError(null)
    startTransition(async () => {
      try {
        await deleteAvailability(slot.id)
        onDeleted()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się usunąć.')
      }
    })
  }

  return (
    <ModalShell title="Wolny termin" onClose={onClose}>
      <div className="space-y-1 text-sm text-slate-900">
        <p>{formatDateLong(d)}</p>
        <p className="tabular-nums">
          {formatTime(d)}–{formatTime(addMinutes(d, LESSON_MINUTES))}
        </p>
      </div>
      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Zamknij
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Usuwanie…' : 'Usuń'}
        </button>
      </div>
    </ModalShell>
  )
}

function LessonDetailsModal({
  lesson,
  teacherAddress,
  onClose,
  onReschedule,
  onCancel,
}: {
  lesson: Lesson
  teacherAddress: string | null
  onClose: () => void
  onReschedule: () => void
  onCancel: () => void
}) {
  const d = new Date(lesson.start_at)
  const fullName = lesson.student
    ? `${lesson.student.first_name} ${lesson.student.last_name}`
    : 'Uczeń'
  return (
    <ModalShell title="Zaplanowana lekcja" onClose={onClose}>
      <div className="space-y-2 text-sm text-slate-900">
        <p>
          <span className="text-slate-500">Uczeń:</span>{' '}
          <span className="font-medium text-slate-900">{fullName}</span>
        </p>
        <p>{formatDateLong(d)}</p>
        <p className="tabular-nums">
          {formatTime(d)}–{formatTime(addMinutes(d, lesson.duration_minutes))}
        </p>
        <p>
          <span className="text-slate-500">Forma:</span>{' '}
          <span className="font-medium text-slate-900">
            {modeIcon(lesson.mode)} {modeLabel(lesson.mode)}
            {lesson.mode === 'in_person' && teacherAddress
              ? `: ${teacherAddress}`
              : ''}
          </span>
        </p>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Zamknij
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100"
        >
          Odwołaj lekcję
        </button>
        <button
          type="button"
          onClick={onReschedule}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          Przenieś na inny termin
        </button>
      </div>
    </ModalShell>
  )
}

function CancelLessonConfirmModal({
  lesson,
  onClose,
  onCancelled,
}: {
  lesson: Lesson
  onClose: () => void
  onCancelled: () => void
}) {
  const d = new Date(lesson.start_at)
  const fullName = lesson.student
    ? `${lesson.student.first_name} ${lesson.student.last_name}`
    : 'Uczeń'
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = () => {
    setError(null)
    startTransition(async () => {
      try {
        await cancelLesson(lesson.id)
        onCancelled()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się odwołać lekcji.')
      }
    })
  }

  return (
    <ModalShell title="Odwołaj lekcję" onClose={onClose}>
      <div className="space-y-2 text-sm text-slate-900">
        <p>Czy na pewno chcesz odwołać tę lekcję?</p>
        <p className="text-slate-700">
          <span className="font-medium text-slate-900">{fullName}</span> ·{' '}
          {formatDateLong(d)},{' '}
          <span className="tabular-nums">{formatTime(d)}</span>
        </p>
      </div>
      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Anuluj
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Odwoływanie…' : 'Tak, odwołaj'}
        </button>
      </div>
    </ModalShell>
  )
}

// ===== Umów lekcję =====

function ScheduleLessonModal({
  teacherId,
  teacherAddress,
  students,
  onClose,
  onSaved,
}: {
  teacherId: string
  teacherAddress: string | null
  students: StudentInfo[]
  onClose: () => void
  onSaved: () => void
}) {
  const initDate = new Date()
  initDate.setDate(initDate.getDate() + 1)
  const [studentId, setStudentId] = useState(students[0]?.id ?? '')
  const [date, setDate] = useState(toLocalDateInput(initDate))
  const [time, setTime] = useState(TIME_OPTIONS[0])
  const [mode, setMode] = useState<LessonMode>('online')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const hasAddress = !!teacherAddress && teacherAddress.trim().length > 0

  const submit = (asProposal: boolean) => {
    setError(null)
    const local = combineDateTimeLocal(date, time)
    if (local.getTime() <= Date.now()) {
      setError('Termin musi być w przyszłości.')
      return
    }
    if (!studentId) {
      setError('Wybierz ucznia.')
      return
    }
    const effectiveMode = hasAddress ? mode : 'online'
    startTransition(async () => {
      try {
        if (asProposal) {
          await createProposal({
            kind: 'new_lesson',
            teacherId,
            studentId,
            startAtIso: local.toISOString(),
            mode: effectiveMode,
          })
        } else {
          await scheduleLessonDirectly({
            studentId,
            startAtIso: local.toISOString(),
            mode: effectiveMode,
          })
        }
        onSaved()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się zapisać.')
      }
    })
  }

  return (
    <ModalShell title="Umów lekcję" onClose={onClose} size="lg">
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-900">Uczeń</span>
          <select
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {students.map((s) => (
              <option key={s.id} value={s.id}>
                {s.first_name} {s.last_name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-900">Data</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-900">Godzina</span>
            <select
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {TIME_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ModeRadio
          mode={mode}
          onChange={setMode}
          teacherAddress={teacherAddress}
        />
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Anuluj
          </button>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={pending}
            className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Wyślij propozycję
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={pending}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Zaplanuj od razu
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

// ===== Przenieś =====

function RescheduleLessonModal({
  lesson,
  teacherId,
  teacherAddress,
  onClose,
  onSaved,
}: {
  lesson: Lesson
  teacherId: string
  teacherAddress: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const current = new Date(lesson.start_at)
  const [date, setDate] = useState(toLocalDateInput(current))
  const initTime = toLocalTimeInput(current)
  const [time, setTime] = useState(
    TIME_OPTIONS.includes(initTime) ? initTime : TIME_OPTIONS[0],
  )
  const [mode, setMode] = useState<LessonMode>(lesson.mode)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const hasAddress = !!teacherAddress && teacherAddress.trim().length > 0

  const submit = (asProposal: boolean) => {
    setError(null)
    const local = combineDateTimeLocal(date, time)
    if (local.getTime() <= Date.now()) {
      setError('Termin musi być w przyszłości.')
      return
    }
    const effectiveMode = hasAddress ? mode : 'online'
    startTransition(async () => {
      try {
        if (asProposal) {
          await createProposal({
            kind: 'reschedule',
            teacherId,
            studentId: lesson.student_id,
            originalLessonId: lesson.id,
            startAtIso: local.toISOString(),
            mode: effectiveMode,
          })
        } else {
          await rescheduleLessonDirectly({
            lessonId: lesson.id,
            startAtIso: local.toISOString(),
            mode: effectiveMode,
          })
        }
        onSaved()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się zapisać.')
      }
    })
  }

  return (
    <ModalShell title="Przenieś lekcję" onClose={onClose} size="lg">
      <div className="space-y-3 text-sm text-slate-900">
        <p>
          <span className="text-slate-500">Obecnie:</span>{' '}
          <span className="font-medium">
            {formatDateLong(current)}, {formatTime(current)}
          </span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block font-medium">Nowa data</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-medium">Nowa godzina</span>
            <select
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {TIME_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <ModeRadio
          mode={mode}
          onChange={setMode}
          teacherAddress={teacherAddress}
        />
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Anuluj
          </button>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={pending}
            className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Wyślij propozycję zmiany
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={pending}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Przenieś od razu
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

function ModeRadio({
  mode,
  onChange,
  teacherAddress,
}: {
  mode: LessonMode
  onChange: (m: LessonMode) => void
  teacherAddress: string | null
}) {
  const hasAddress = !!teacherAddress && teacherAddress.trim().length > 0
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-900">Forma lekcji</p>
      {hasAddress ? (
        <div className="space-y-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
            <input
              type="radio"
              checked={mode === 'online'}
              onChange={() => onChange('online')}
              className="mt-0.5"
            />
            <span className="font-medium">💻 Online</span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
            <input
              type="radio"
              checked={mode === 'in_person'}
              onChange={() => onChange('in_person')}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">📍 Stacjonarnie</span>
              <span className="ml-1 block text-xs text-slate-600 sm:inline">
                ({teacherAddress})
              </span>
            </span>
          </label>
        </div>
      ) : (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
          💻 Online — dodaj adres w „Mój profil", żeby umożliwić lekcje
          stacjonarne.
        </p>
      )}
    </div>
  )
}
