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
  cancelRecurringSeries,
  createAvailability,
  createProposal,
  createRecurringLesson,
  extendRecurringLessons,
  deleteAvailability,
  rescheduleLessonDirectly,
  rescheduleRecurringSeries,
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
  recurring_lesson_id: string | null
  student: { first_name: string; last_name: string } | null
}

type RecurringLesson = {
  id: string
  student_id: string
  day_of_week: number
  time_of_day: string
  duration_minutes: number
  mode: LessonMode
  starts_on: string
  ends_on: string | null
  cancelled: boolean
  created_at: string
}

const DAY_LABELS = [
  'Niedziela',
  'Poniedziałek',
  'Wtorek',
  'Środa',
  'Czwartek',
  'Piątek',
  'Sobota',
]

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
  const [cycles, setCycles] = useState<RecurringLesson[]>([])
  const [cycleLastDates, setCycleLastDates] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)

  const [addModal, setAddModal] = useState<{ date: Date } | null>(null)
  const [slotModal, setSlotModal] = useState<Availability | null>(null)
  const [lessonModal, setLessonModal] = useState<Lesson | null>(null)
  const [scheduleModal, setScheduleModal] = useState(false)
  const [rescheduleModal, setRescheduleModal] = useState<Lesson | null>(null)
  const [cancelModal, setCancelModal] = useState<Lesson | null>(null)
  // Scope: "tylko ten" / "ten i przyszłe" przy operacjach na cyklicznej lekcji.
  const [scopeModal, setScopeModal] = useState<{
    lesson: Lesson
    action: 'cancel' | 'reschedule'
  } | null>(null)
  const [cancelSeriesModal, setCancelSeriesModal] = useState<{ lesson: Lesson } | null>(
    null,
  )
  const [rescheduleSeriesModal, setRescheduleSeriesModal] = useState<{
    lesson: Lesson
  } | null>(null)

  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart])
  const studentById = useMemo(() => {
    const m = new Map<string, StudentInfo>()
    for (const s of students) m.set(s.id, s)
    return m
  }, [students])

  const load = useCallback(async () => {
    setLoading(true)
    const [
      { data: slotsData },
      { data: lessonsData },
      { data: proposalsData },
      { data: cyclesData },
      { data: cycleLastData },
    ] = await Promise.all([
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
          'id, start_at, duration_minutes, mode, student_id, recurring_lesson_id, student:profiles!lessons_student_id_fkey(first_name, last_name)',
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
      supabase
        .from('recurring_lessons')
        .select(
          'id, student_id, day_of_week, time_of_day, duration_minutes, mode, starts_on, ends_on, cancelled, created_at',
        )
        .eq('teacher_id', teacherId)
        .order('created_at', { ascending: false }),
      // Ostatnia wygenerowana lekcja per cykl — używamy do warunkowego
      // pokazania przycisku „Dogeneruj kolejne 12 tygodni".
      supabase
        .from('lessons')
        .select('recurring_lesson_id, start_at')
        .eq('teacher_id', teacherId)
        .eq('status', 'scheduled')
        .not('recurring_lesson_id', 'is', null)
        .order('start_at', { ascending: false }),
    ])
    setSlots((slotsData ?? []) as Availability[])
    setLessons((lessonsData ?? []) as unknown as Lesson[])
    setProposals((proposalsData ?? []) as unknown as Proposal[])
    setCycles((cyclesData ?? []) as RecurringLesson[])
    const lastMap: Record<string, string | null> = {}
    for (const row of (cycleLastData ?? []) as Array<{
      recurring_lesson_id: string | null
      start_at: string
    }>) {
      if (!row.recurring_lesson_id) continue
      if (!(row.recurring_lesson_id in lastMap)) {
        lastMap[row.recurring_lesson_id] = row.start_at
      }
    }
    setCycleLastDates(lastMap)
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
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'recurring_lessons',
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
              {l.recurring_lesson_id ? (
                <span
                  aria-label="Lekcja cykliczna"
                  title="Lekcja cykliczna"
                  className="ml-1"
                >
                  🔁
                </span>
              ) : null}
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
          recurring={
            lessonModal.recurring_lesson_id
              ? cycles.find((c) => c.id === lessonModal.recurring_lesson_id) ?? null
              : null
          }
          onClose={() => setLessonModal(null)}
          onReschedule={() => {
            if (lessonModal.recurring_lesson_id) {
              setScopeModal({ lesson: lessonModal, action: 'reschedule' })
            } else {
              setRescheduleModal(lessonModal)
            }
            setLessonModal(null)
          }}
          onCancel={() => {
            if (lessonModal.recurring_lesson_id) {
              setScopeModal({ lesson: lessonModal, action: 'cancel' })
            } else {
              setCancelModal(lessonModal)
            }
            setLessonModal(null)
          }}
        />
      )}

      {scopeModal && (
        <RecurringScopeModal
          lesson={scopeModal.lesson}
          action={scopeModal.action}
          onClose={() => setScopeModal(null)}
          onPickOnlyThis={() => {
            const l = scopeModal.lesson
            const action = scopeModal.action
            setScopeModal(null)
            if (action === 'cancel') setCancelModal(l)
            else setRescheduleModal(l)
          }}
          onPickAllFuture={() => {
            // Pick "ten i przyszłe" — najpierw zamknij wybór scope, potem
            // wykonaj odpowiednią akcję na cyklu.
            const l = scopeModal.lesson
            setScopeModal(null)
            if (scopeModal.action === 'cancel') {
              setCancelSeriesModal({ lesson: l })
            } else {
              setRescheduleSeriesModal({ lesson: l })
            }
          }}
        />
      )}

      {cancelSeriesModal && (
        <CancelSeriesConfirmModal
          lesson={cancelSeriesModal.lesson}
          onClose={() => setCancelSeriesModal(null)}
          onCancelled={() => {
            setCancelSeriesModal(null)
            load()
          }}
        />
      )}

      {rescheduleSeriesModal && (
        <RescheduleSeriesModal
          lesson={rescheduleSeriesModal.lesson}
          teacherAddress={teacherAddress}
          onClose={() => setRescheduleSeriesModal(null)}
          onSaved={() => {
            setRescheduleSeriesModal(null)
            load()
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

      <MyCyclesSection
        cycles={cycles}
        cycleLastDates={cycleLastDates}
        studentById={studentById}
        onChanged={load}
      />
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
  recurring,
  onClose,
  onReschedule,
  onCancel,
}: {
  lesson: Lesson
  teacherAddress: string | null
  recurring: RecurringLesson | null
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
        {recurring && (
          <div className="mt-2 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-900">
            <p className="font-medium">🔁 Część cyklu cotygodniowego</p>
            <p className="mt-1">
              Od: {formatDateLong(new Date(recurring.starts_on + 'T00:00:00'))}
            </p>
            <p>
              Do:{' '}
              {recurring.ends_on
                ? formatDateLong(new Date(recurring.ends_on + 'T00:00:00'))
                : recurring.cancelled
                  ? 'zakończony'
                  : 'trwający (bez końca)'}
            </p>
          </div>
        )}
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

// Domyślna data końcowa cyklu = 30 czerwca następnego zakończenia roku
// szkolnego (1 wrzesień – 30 czerwiec → bieżący 30 czerwiec; 1 lipca – 31
// sierpnia → następny 30 czerwiec).
function defaultEndOfSchoolYear(today: Date): Date {
  const m = today.getMonth()
  const y = today.getFullYear()
  return m < 6 ? new Date(y, 5, 30) : new Date(y + 1, 5, 30)
}

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

  // --- Cykl tygodniowy ---
  const [isRecurring, setIsRecurring] = useState(false)
  type EndsMode = 'date' | 'weeks' | 'open'
  const [endsMode, setEndsMode] = useState<EndsMode>('date')
  const [endsOnInput, setEndsOnInput] = useState(() =>
    toLocalDateInput(defaultEndOfSchoolYear(new Date())),
  )
  const [weeksCount, setWeeksCount] = useState(12)

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
        if (isRecurring) {
          let endsOnDate: string | null = null
          if (endsMode === 'date') {
            // Walidacja: minimum tydzień po pierwszej lekcji, maksimum 2 lata.
            const ends = new Date(endsOnInput + 'T00:00:00')
            const minEnd = new Date(local)
            minEnd.setDate(minEnd.getDate() + 7)
            const maxEnd = new Date(local)
            maxEnd.setDate(maxEnd.getDate() + 365 * 2)
            if (ends.getTime() < minEnd.setHours(0, 0, 0, 0)) {
              setError('Data końcowa musi być co najmniej tydzień po pierwszej lekcji.')
              return
            }
            if (ends.getTime() > maxEnd.setHours(0, 0, 0, 0)) {
              setError('Data końcowa nie może przekraczać 2 lat od pierwszej lekcji.')
              return
            }
            endsOnDate = endsOnInput
          } else if (endsMode === 'weeks') {
            if (weeksCount < 2 || weeksCount > 104) {
              setError('Liczba tygodni musi być w zakresie 2–104.')
              return
            }
            const ends = new Date(local)
            ends.setDate(ends.getDate() + (weeksCount - 1) * 7)
            endsOnDate = toLocalDateInput(ends)
          } else {
            endsOnDate = null
          }
          await createRecurringLesson({
            studentId,
            startAtIso: local.toISOString(),
            mode: effectiveMode,
            endsOnDate,
          })
          onSaved()
          return
        }

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

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
          <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-900">
            <input
              type="checkbox"
              checked={isRecurring}
              onChange={(e) => setIsRecurring(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">🔁 Lekcja cykliczna</span>{' '}
              <span className="text-slate-600">(co tydzień o tej godzinie)</span>
              <span className="mt-0.5 block text-xs text-slate-600">
                Lekcja będzie powtarzana co tydzień w wybrany dzień tygodnia.
              </span>
            </span>
          </label>
          {isRecurring && (
            <div className="mt-3 space-y-2 pl-6">
              <p className="text-xs font-medium text-slate-700">Powtarzaj do:</p>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
                <input
                  type="radio"
                  name="ends-mode"
                  checked={endsMode === 'date'}
                  onChange={() => setEndsMode('date')}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="font-medium">Konkretnej daty</span>
                  {endsMode === 'date' && (
                    <input
                      type="date"
                      value={endsOnInput}
                      onChange={(e) => setEndsOnInput(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  )}
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
                <input
                  type="radio"
                  name="ends-mode"
                  checked={endsMode === 'weeks'}
                  onChange={() => setEndsMode('weeks')}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="font-medium">Liczby tygodni</span>
                  {endsMode === 'weeks' && (
                    <input
                      type="number"
                      min={2}
                      max={104}
                      value={weeksCount}
                      onChange={(e) =>
                        setWeeksCount(parseInt(e.target.value, 10) || 0)
                      }
                      className="mt-1 block w-32 rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  )}
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
                <input
                  type="radio"
                  name="ends-mode"
                  checked={endsMode === 'open'}
                  onChange={() => setEndsMode('open')}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="font-medium">Bez końca</span>
                  {endsMode === 'open' && (
                    <span className="mt-1 block rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
                      Cykl będzie generowany co tydzień. Nadal możesz go
                      zakończyć ręcznie w dowolnym momencie.
                    </span>
                  )}
                </span>
              </label>
            </div>
          )}
        </div>

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
          {isRecurring ? (
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={pending}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? 'Tworzenie…' : 'Utwórz cykl'}
            </button>
          ) : (
            <>
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
            </>
          )}
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

// ===== Cykliczne: scope, anuluj-serię, przenieś-serię, sekcja Moje cykle =====

function RecurringScopeModal({
  lesson,
  action,
  onClose,
  onPickOnlyThis,
  onPickAllFuture,
}: {
  lesson: Lesson
  action: 'cancel' | 'reschedule'
  onClose: () => void
  onPickOnlyThis: () => void
  onPickAllFuture: () => void
}) {
  const d = new Date(lesson.start_at)
  const title =
    action === 'cancel' ? 'Odwołaj lekcję cykliczną' : 'Przenieś lekcję cykliczną'
  const verb = action === 'cancel' ? 'odwołać' : 'przenieść'
  return (
    <ModalShell title={title} onClose={onClose}>
      <div className="space-y-3 text-sm text-slate-900">
        <p>
          Co chcesz {verb}? Lekcja jest częścią cyklu cotygodniowego.
        </p>
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
          {formatDateLong(d)}, <span className="tabular-nums">{formatTime(d)}</span>
        </p>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Anuluj
        </button>
        <button
          type="button"
          onClick={onPickOnlyThis}
          className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100"
        >
          Tylko ten termin
        </button>
        <button
          type="button"
          onClick={onPickAllFuture}
          className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition ${
            action === 'cancel'
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-indigo-600 hover:bg-indigo-700'
          }`}
        >
          Ten i przyszłe
        </button>
      </div>
    </ModalShell>
  )
}

function CancelSeriesConfirmModal({
  lesson,
  onClose,
  onCancelled,
}: {
  lesson: Lesson
  onClose: () => void
  onCancelled: () => void
}) {
  const d = new Date(lesson.start_at)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const fullName = lesson.student
    ? `${lesson.student.first_name} ${lesson.student.last_name}`
    : 'Uczeń'

  const submit = () => {
    if (!lesson.recurring_lesson_id) return
    setError(null)
    const fromDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      '0',
    )}-${String(d.getDate()).padStart(2, '0')}`
    startTransition(async () => {
      try {
        await cancelRecurringSeries({
          recurringId: lesson.recurring_lesson_id!,
          fromDate,
        })
        onCancelled()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się zakończyć cyklu.')
      }
    })
  }

  return (
    <ModalShell title="Odwołaj ten i przyszłe terminy" onClose={onClose}>
      <div className="space-y-2 text-sm text-slate-900">
        <p>
          Czy na pewno chcesz odwołać tę lekcję{' '}
          <span className="font-medium">i wszystkie kolejne</span> w cyklu?
        </p>
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
          {fullName} · od {formatDateLong(d)}, {formatTime(d)}
        </p>
        <p className="text-xs text-slate-500">
          Cykl zostanie zakończony. Wcześniejsze odbyte lekcje pozostają bez zmian.
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
          Wróć
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Odwoływanie…' : 'Tak, zakończ cykl'}
        </button>
      </div>
    </ModalShell>
  )
}

function RescheduleSeriesModal({
  lesson,
  teacherAddress,
  onClose,
  onSaved,
}: {
  lesson: Lesson
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

  const submit = () => {
    if (!lesson.recurring_lesson_id) return
    setError(null)
    const local = combineDateTimeLocal(date, time)
    if (local.getTime() <= Date.now()) {
      setError('Nowy termin musi być w przyszłości.')
      return
    }
    const effectiveMode = hasAddress ? mode : 'online'
    const fromLessonDate = `${current.getFullYear()}-${String(
      current.getMonth() + 1,
    ).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`

    startTransition(async () => {
      try {
        await rescheduleRecurringSeries({
          recurringId: lesson.recurring_lesson_id!,
          fromLessonDate,
          newStartAtIso: local.toISOString(),
          newMode: effectiveMode,
        })
        onSaved()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się przenieść cyklu.')
      }
    })
  }

  return (
    <ModalShell title="Przenieś cały cykl od tej lekcji" onClose={onClose} size="lg">
      <div className="space-y-3 text-sm text-slate-900">
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
          Obecny cykl zostanie zakończony od{' '}
          <span className="font-medium">{formatDateLong(current)}</span> włącznie,
          a od nowego terminu utworzymy nowy cykl cotygodniowy.
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
        <ModeRadio mode={mode} onChange={setMode} teacherAddress={teacherAddress} />
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
            onClick={submit}
            disabled={pending}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? 'Przenoszenie…' : 'Przenieś cykl'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

function MyCyclesSection({
  cycles,
  cycleLastDates,
  studentById,
  onChanged,
}: {
  cycles: RecurringLesson[]
  cycleLastDates: Record<string, string | null>
  studentById: Map<string, StudentInfo>
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const active = cycles.filter((c) => !c.cancelled)
  if (active.length === 0) return null

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left sm:px-6"
      >
        <span className="text-sm font-semibold text-slate-900">
          🔁 Moje cykle ({active.length})
        </span>
        <span className="text-xs text-slate-500">{open ? 'Zwiń' : 'Rozwiń'}</span>
      </button>
      {open && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {active.map((c) => (
            <CycleRow
              key={c.id}
              cycle={c}
              lastLessonStartIso={cycleLastDates[c.id] ?? null}
              studentName={(() => {
                const s = studentById.get(c.student_id)
                return s ? `${s.first_name} ${s.last_name}` : 'Uczeń'
              })()}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function CycleRow({
  cycle,
  lastLessonStartIso,
  studentName,
  onChanged,
}: {
  cycle: RecurringLesson
  lastLessonStartIso: string | null
  studentName: string
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [confirmEnd, setConfirmEnd] = useState(false)

  const [hh, mm] = cycle.time_of_day.split(':')
  const timeLabel = `${hh}:${mm}`
  const dayLabel = DAY_LABELS[cycle.day_of_week] ?? '?'
  const startsOn = new Date(cycle.starts_on + 'T00:00:00')
  const endsOn = cycle.ends_on ? new Date(cycle.ends_on + 'T00:00:00') : null

  // Pokaż „Dogeneruj kolejne 12 tygodni" tylko gdy ostatnia wygenerowana lekcja
  // jest mniej niż 4 tygodnie naprzód (i cykl nie ma sztywnego końca w bliskiej
  // przyszłości).
  const FOUR_WEEKS_MS = 4 * 7 * 24 * 60 * 60 * 1000
  const lastDate = lastLessonStartIso ? new Date(lastLessonStartIso) : null
  const showExtend =
    !endsOn || endsOn.getTime() - Date.now() > FOUR_WEEKS_MS
      ? lastDate
        ? lastDate.getTime() - Date.now() < FOUR_WEEKS_MS
        : true
      : false

  const extend = () => {
    setError(null)
    startTransition(async () => {
      try {
        await extendRecurringLessons({ recurringId: cycle.id, weeksToExtend: 12 })
        onChanged()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się dogenerować.')
      }
    })
  }

  const endCycle = () => {
    setError(null)
    // Anuluj od najbliższej przyszłej daty cyklu — czyli od dziś.
    const today = new Date()
    const fromDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
      2,
      '0',
    )}-${String(today.getDate()).padStart(2, '0')}`
    startTransition(async () => {
      try {
        await cancelRecurringSeries({ recurringId: cycle.id, fromDate })
        setConfirmEnd(false)
        onChanged()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się zakończyć cyklu.')
      }
    })
  }

  return (
    <li className="px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-sm text-slate-900">
          <p className="font-medium">
            {dayLabel} {timeLabel} · {studentName}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            {modeIcon(cycle.mode)} {modeLabel(cycle.mode)} ·{' '}
            <span>Od {formatDateLong(startsOn)}</span> ·{' '}
            <span>
              Do {endsOn ? formatDateLong(endsOn) : <em>bez końca</em>}
            </span>
            {lastDate && (
              <>
                {' '}
                · Ostatnia wygenerowana: {formatDateLong(lastDate)}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {showExtend && (
            <button
              type="button"
              onClick={extend}
              disabled={pending}
              className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? 'Dogenerowywanie…' : '+ 12 tygodni'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setConfirmEnd(true)}
            disabled={pending}
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Zakończ cykl
          </button>
        </div>
      </div>
      {error && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}
      {confirmEnd && (
        <ModalShell title="Zakończ cykl" onClose={() => setConfirmEnd(false)}>
          <div className="space-y-2 text-sm text-slate-900">
            <p>
              Czy na pewno chcesz zakończyć ten cykl? Wszystkie przyszłe lekcje
              (od dziś włącznie) zostaną odwołane.
            </p>
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {dayLabel} {timeLabel} · {studentName}
            </p>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmEnd(false)}
              className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Wróć
            </button>
            <button
              type="button"
              onClick={endCycle}
              disabled={pending}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? 'Kończenie…' : 'Tak, zakończ'}
            </button>
          </div>
        </ModalShell>
      )}
    </li>
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
