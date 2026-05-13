'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
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
  teacherColor,
} from '@/lib/calendar'
import { WeekCalendar, type CalendarBlock } from '../calendar/week-calendar'
import { WeekNav } from '../calendar/week-nav'
import { ModalShell } from './shared'
import { bookLesson, cancelLesson, createProposal } from './actions'
import { ProposalsSection } from './proposals-section'
import type { Proposal } from './types'

export type TeacherInfo = {
  id: string
  first_name: string
  last_name: string
  address: string | null
}

type Availability = {
  id: string
  teacher_id: string
  start_at: string
  duration_minutes: number
}

type Lesson = {
  id: string
  teacher_id: string
  start_at: string
  duration_minutes: number
  mode: LessonMode
}

const RESCHEDULE_BY_STUDENT_MIN_MS = 24 * 60 * 60 * 1000
const CANCEL_BY_STUDENT_MIN_MS = 24 * 60 * 60 * 1000
const FILTER_STORAGE_KEY = 'schedule:hiddenTeacherIds'
const ONLY_MINE_STORAGE_KEY = 'schedule:onlyMyLessons'

export function StudentSchedule({
  studentId,
  teachers,
}: {
  studentId: string
  teachers: TeacherInfo[]
}) {
  const supabase = useMemo(() => createClient(), [])
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()))
  const [slots, setSlots] = useState<Availability[]>([])
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [filterReady, setFilterReady] = useState(false)

  const [bookModal, setBookModal] = useState<Availability | null>(null)
  const [lessonModal, setLessonModal] = useState<Lesson | null>(null)
  const [rescheduleModal, setRescheduleModal] = useState<Lesson | null>(null)
  const [cancelModal, setCancelModal] = useState<Lesson | null>(null)
  const [onlyMine, setOnlyMine] = useState(false)

  // Filtr nauczycieli — czytamy z localStorage. Robimy to w useEffect, żeby
  // uniknąć hydration mismatch.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FILTER_STORAGE_KEY)
      if (raw) {
        const arr = JSON.parse(raw) as string[]
        setHiddenIds(new Set(arr))
      }
      setOnlyMine(localStorage.getItem(ONLY_MINE_STORAGE_KEY) === '1')
    } catch {
      // ignorujemy — błędny JSON traktujemy jako "nic nie schowane"
    }
    setFilterReady(true)
  }, [])

  useEffect(() => {
    if (!filterReady) return
    localStorage.setItem(
      FILTER_STORAGE_KEY,
      JSON.stringify(Array.from(hiddenIds)),
    )
  }, [hiddenIds, filterReady])

  useEffect(() => {
    if (!filterReady) return
    localStorage.setItem(ONLY_MINE_STORAGE_KEY, onlyMine ? '1' : '0')
  }, [onlyMine, filterReady])

  const teacherById = useMemo(() => {
    const m = new Map<string, TeacherInfo>()
    for (const t of teachers) m.set(t.id, t)
    return m
  }, [teachers])

  const teacherIds = useMemo(() => teachers.map((t) => t.id), [teachers])
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart])

  const load = useCallback(async () => {
    if (teacherIds.length === 0) {
      setSlots([])
      setLessons([])
      setProposals([])
      setLoading(false)
      return
    }
    setLoading(true)
    const [
      { data: slotsData },
      { data: lessonsData },
      { data: proposalsData },
    ] = await Promise.all([
      supabase
        .from('availability')
        .select('id, teacher_id, start_at, duration_minutes')
        .in('teacher_id', teacherIds)
        .gte('start_at', weekStart.toISOString())
        .lt('start_at', weekEnd.toISOString())
        .order('start_at'),
      supabase
        .from('lessons')
        .select('id, teacher_id, start_at, duration_minutes, mode')
        .eq('student_id', studentId)
        .eq('status', 'scheduled')
        .gte('start_at', weekStart.toISOString())
        .lt('start_at', weekEnd.toISOString())
        .order('start_at'),
      supabase
        .from('lesson_proposals')
        .select(
          'id, kind, teacher_id, student_id, proposer_id, original_lesson_id, start_at, duration_minutes, mode, status, created_at, original_lesson:lessons!lesson_proposals_original_lesson_id_fkey(start_at, mode)',
        )
        .eq('student_id', studentId)
        .order('created_at', { ascending: false }),
    ])
    setSlots((slotsData ?? []) as Availability[])
    setLessons((lessonsData ?? []) as Lesson[])
    setProposals((proposalsData ?? []) as unknown as Proposal[])
    setLoading(false)
  }, [supabase, studentId, teacherIds, weekStart, weekEnd])

  useEffect(() => {
    load()
  }, [load])

  // Realtime: zmiany availability/lessons widoczne dla ucznia (RLS) + propozycje
  // moje (po student_id).
  useEffect(() => {
    const channel = supabase
      .channel(`student-schedule-${studentId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'availability' },
        () => load(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lessons',
          filter: `student_id=eq.${studentId}`,
        },
        () => load(),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'lesson_proposals',
          filter: `student_id=eq.${studentId}`,
        },
        () => load(),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [supabase, studentId, load])

  const blocks = useMemo<CalendarBlock[]>(() => {
    const out: CalendarBlock[] = []
    for (const s of slots) {
      if (onlyMine) continue
      if (hiddenIds.has(s.teacher_id)) continue
      const d = new Date(s.start_at)
      const dayIdx = dayIndexInWeek(d, weekStart)
      const row = gridRowFor(d)
      if (dayIdx === null || row === null) continue
      const t = teacherById.get(s.teacher_id)
      const c = teacherColor(s.teacher_id).light
      out.push({
        id: `s-${s.id}`,
        dayIdx,
        slotIdx: row - 1,
        spanSlots: LESSON_SPAN,
        className: `${c.bg} ${c.border} ${c.text} hover:brightness-95`,
        content: (
          <div className="space-y-0.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
              Wolny · {t ? t.last_name : ''}
            </p>
            <p className="text-sm font-medium tabular-nums">
              {formatTime(d)}–{formatTime(addMinutes(d, LESSON_MINUTES))}
            </p>
          </div>
        ),
        onClick: () => setBookModal(s),
      })
    }
    for (const l of lessons) {
      if (hiddenIds.has(l.teacher_id)) continue
      const d = new Date(l.start_at)
      const dayIdx = dayIndexInWeek(d, weekStart)
      const row = gridRowFor(d)
      if (dayIdx === null || row === null) continue
      const t = teacherById.get(l.teacher_id)
      const c = teacherColor(l.teacher_id).strong
      out.push({
        id: `l-${l.id}`,
        dayIdx,
        slotIdx: row - 1,
        spanSlots: LESSON_SPAN,
        className: `${c.bg} ${c.border} ${c.text} ring-1 ring-inset ring-slate-900/10 hover:brightness-95`,
        content: (
          <div className="space-y-0.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide opacity-90">
              <span aria-hidden>{modeIcon(l.mode)}</span> Zapisany ·{' '}
              {t ? t.last_name : ''}
            </p>
            <p className="text-sm font-medium tabular-nums">
              {formatTime(d)}–{formatTime(addMinutes(d, LESSON_MINUTES))}
            </p>
          </div>
        ),
        onClick: () => setLessonModal(l),
      })
    }
    return out
  }, [slots, lessons, weekStart, teacherById, hiddenIds, onlyMine])

  const toggleTeacher = (id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const showAll = () => setHiddenIds(new Set())
  const hideAll = () => setHiddenIds(new Set(teacherIds))

  const myProposals = proposals.filter((p) => p.proposer_id === studentId)
  const incomingProposals = proposals.filter(
    (p) => p.proposer_id !== studentId && p.status === 'pending',
  )

  if (teachers.length === 0) {
    return (
      <div className="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="text-xl font-semibold text-slate-900">Terminarz</h1>
        <p className="mt-2 text-sm text-slate-600">
          Nie masz jeszcze przypisanych nauczycieli. Wyślij prośbę o powiązanie
          z nauczycielem, aby zobaczyć dostępne terminy.
        </p>
        <Link
          href="/dashboard/teachers"
          className="mt-4 inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
        >
          Znajdź nauczyciela
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:p-6">
        <h1 className="text-xl font-semibold text-slate-900">Terminarz</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {teachers.map((t) => {
            const c = teacherColor(t.id)
            const hidden = hiddenIds.has(t.id)
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => toggleTeacher(t.id)}
                className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
                  hidden
                    ? 'bg-slate-50 text-slate-400 ring-slate-200 line-through'
                    : 'bg-slate-50 text-slate-700 ring-slate-200 hover:bg-slate-100'
                }`}
                aria-pressed={!hidden}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${hidden ? 'bg-slate-300' : c.dot}`}
                />
                {t.first_name} {t.last_name}
              </button>
            )
          })}
          {teachers.length > 1 && (
            <div className="ml-1 flex items-center gap-1 text-xs">
              <button
                type="button"
                onClick={showAll}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Pokaż wszystkich
              </button>
              <button
                type="button"
                onClick={hideAll}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Ukryj wszystkich
              </button>
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <span className="text-slate-500">Wszystko</span>
            <button
              type="button"
              role="switch"
              aria-checked={onlyMine}
              onClick={() => setOnlyMine((v) => !v)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                onlyMine ? 'bg-indigo-600' : 'bg-slate-300'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  onlyMine ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
            <span
              className={`font-medium ${onlyMine ? 'text-indigo-700' : 'text-slate-700'}`}
            >
              Tylko moje lekcje
            </span>
          </label>
        </div>
        <div className="mt-4">
          <WeekNav weekStart={weekStart} onChange={setWeekStart} />
        </div>
        {loading && (
          <p className="mt-2 text-xs text-slate-400">Ładowanie terminarza…</p>
        )}
      </div>

      <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <WeekCalendar weekStart={weekStart} blocks={blocks} />
      </div>

      <ProposalsSection
        myProposals={myProposals}
        incomingProposals={incomingProposals}
        currentUserId={studentId}
        teacherAddress={null}
        getCounterpartLabel={(p) => {
          const t = teacherById.get(p.teacher_id)
          if (!t) return 'Nauczyciel'
          // Adres nauczyciela dla in_person — doczepiamy w mini-opisie sekcji.
          return `${t.first_name} ${t.last_name}${
            p.mode === 'in_person' && t.address ? ` (${t.address})` : ''
          }`
        }}
      />

      {bookModal && (
        <BookLessonModal
          slot={bookModal}
          teacher={teacherById.get(bookModal.teacher_id) ?? null}
          onClose={() => setBookModal(null)}
          onBooked={() => {
            setBookModal(null)
            load()
          }}
        />
      )}

      {lessonModal && (
        <LessonModal
          lesson={lessonModal}
          teacher={teacherById.get(lessonModal.teacher_id) ?? null}
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

      {rescheduleModal && (
        <ProposeRescheduleModal
          lesson={rescheduleModal}
          teacher={teacherById.get(rescheduleModal.teacher_id) ?? null}
          studentId={studentId}
          onClose={() => setRescheduleModal(null)}
          onSent={() => {
            setRescheduleModal(null)
            load()
          }}
        />
      )}
    </div>
  )
}

// ---------------- Modale ----------------

function BookLessonModal({
  slot,
  teacher,
  onClose,
  onBooked,
}: {
  slot: Availability
  teacher: TeacherInfo | null
  onClose: () => void
  onBooked: () => void
}) {
  const d = new Date(slot.start_at)
  const [mode, setMode] = useState<LessonMode>('online')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const hasAddress = !!teacher?.address && teacher.address.trim().length > 0

  const submit = () => {
    setError(null)
    startTransition(async () => {
      try {
        await bookLesson(slot.id, hasAddress ? mode : 'online')
        onBooked()
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Nie udało się zapisać na lekcję.',
        )
      }
    })
  }

  return (
    <ModalShell title="Zapisz się na lekcję" onClose={onClose}>
      <div className="space-y-2 text-sm text-slate-900">
        {teacher && (
          <p>
            <span className="text-slate-500">Nauczyciel:</span>{' '}
            <span className="font-medium text-slate-900">
              {teacher.first_name} {teacher.last_name}
            </span>
          </p>
        )}
        <p>{formatDateLong(d)}</p>
        <p className="tabular-nums">
          {formatTime(d)}–{formatTime(addMinutes(d, LESSON_MINUTES))}
        </p>
      </div>

      <div className="mt-4">
        <p className="mb-2 text-sm font-medium text-slate-900">Forma lekcji</p>
        {hasAddress ? (
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
              <input
                type="radio"
                name="mode"
                value="online"
                checked={mode === 'online'}
                onChange={() => setMode('online')}
                className="mt-0.5"
              />
              <span className="font-medium">💻 Online</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
              <input
                type="radio"
                name="mode"
                value="in_person"
                checked={mode === 'in_person'}
                onChange={() => setMode('in_person')}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">📍 Stacjonarnie</span>
                <span className="ml-1 block text-xs text-slate-600 sm:inline">
                  ({teacher?.address})
                </span>
              </span>
            </label>
          </div>
        ) : (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            💻 Online — ten nauczyciel nie udostępnia adresu lekcji stacjonarnych.
          </p>
        )}
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
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Zapisywanie…' : 'Zapisz się'}
        </button>
      </div>
    </ModalShell>
  )
}

function LessonModal({
  lesson,
  teacher,
  onClose,
  onReschedule,
  onCancel,
}: {
  lesson: Lesson
  teacher: TeacherInfo | null
  onClose: () => void
  onReschedule: () => void
  onCancel: () => void
}) {
  const d = new Date(lesson.start_at)
  const msUntil = d.getTime() - Date.now()
  const canReschedule = msUntil > RESCHEDULE_BY_STUDENT_MIN_MS
  const canCancel = msUntil > CANCEL_BY_STUDENT_MIN_MS
  return (
    <ModalShell title="Moja lekcja" onClose={onClose}>
      <div className="space-y-2 text-sm text-slate-900">
        {teacher && (
          <p>
            <span className="text-slate-500">Nauczyciel:</span>{' '}
            <span className="font-medium text-slate-900">
              {teacher.first_name} {teacher.last_name}
            </span>
          </p>
        )}
        <p>{formatDateLong(d)}</p>
        <p className="tabular-nums">
          {formatTime(d)}–{formatTime(addMinutes(d, lesson.duration_minutes))}
        </p>
        <p>
          <span className="text-slate-500">Forma:</span>{' '}
          <span className="font-medium text-slate-900">
            {modeIcon(lesson.mode)} {modeLabel(lesson.mode)}
            {lesson.mode === 'in_person' && teacher?.address
              ? `: ${teacher.address}`
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
        {canCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100"
          >
            Odwołaj lekcję
          </button>
        )}
        {canReschedule ? (
          <button
            type="button"
            onClick={onReschedule}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700"
          >
            Zaproponuj zmianę terminu
          </button>
        ) : (
          <span
            className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-400"
            title="Zmiana terminu możliwa do 24h przed lekcją"
          >
            Zmiana terminu niemożliwa
          </span>
        )}
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

function ProposeRescheduleModal({
  lesson,
  teacher,
  studentId,
  onClose,
  onSent,
}: {
  lesson: Lesson
  teacher: TeacherInfo | null
  studentId: string
  onClose: () => void
  onSent: () => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [availability, setAvailability] = useState<Availability[]>([])
  const [selectedSlotId, setSelectedSlotId] = useState<string>('')
  const [mode, setMode] = useState<LessonMode>(lesson.mode)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [loadingSlots, setLoadingSlots] = useState(true)

  const hasAddress = !!teacher?.address && teacher.address.trim().length > 0

  // Pobieramy wolne terminy tego nauczyciela (przyszłe).
  useEffect(() => {
    let active = true
    ;(async () => {
      setLoadingSlots(true)
      const { data } = await supabase
        .from('availability')
        .select('id, teacher_id, start_at, duration_minutes')
        .eq('teacher_id', lesson.teacher_id)
        .gte('start_at', new Date().toISOString())
        .order('start_at')
      if (!active) return
      setAvailability((data ?? []) as Availability[])
      if ((data?.length ?? 0) > 0) setSelectedSlotId(data![0].id)
      setLoadingSlots(false)
    })()
    return () => {
      active = false
    }
  }, [supabase, lesson.teacher_id])

  const submit = () => {
    setError(null)
    const slot = availability.find((s) => s.id === selectedSlotId)
    if (!slot) {
      setError('Wybierz nowy termin z listy.')
      return
    }
    const effectiveMode = hasAddress ? mode : 'online'
    startTransition(async () => {
      try {
        await createProposal({
          kind: 'reschedule',
          teacherId: lesson.teacher_id,
          studentId,
          originalLessonId: lesson.id,
          startAtIso: slot.start_at,
          mode: effectiveMode,
        })
        onSent()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się wysłać propozycji.')
      }
    })
  }

  return (
    <ModalShell title="Zaproponuj zmianę terminu" onClose={onClose} size="lg">
      <div className="space-y-3 text-sm text-slate-900">
        <p>
          <span className="text-slate-500">Lekcja:</span>{' '}
          <span className="font-medium">
            {formatDateLong(new Date(lesson.start_at))},{' '}
            {formatTime(new Date(lesson.start_at))}
          </span>
        </p>
        <p className="text-xs text-slate-500">
          Wybierz nowy termin z wolnych slotów{' '}
          {teacher ? `${teacher.first_name} ${teacher.last_name}` : 'nauczyciela'}.
        </p>
        {loadingSlots ? (
          <p className="text-xs text-slate-500">Ładowanie wolnych terminów…</p>
        ) : availability.length === 0 ? (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Brak wolnych terminów w przyszłości. Poproś nauczyciela, żeby dodał slot.
          </p>
        ) : (
          <label className="block">
            <span className="mb-1 block font-medium">Nowy termin</span>
            <select
              value={selectedSlotId}
              onChange={(e) => setSelectedSlotId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              {availability.map((s) => {
                const d = new Date(s.start_at)
                return (
                  <option key={s.id} value={s.id}>
                    {formatDateLong(d)}, {formatTime(d)}
                  </option>
                )
              })}
            </select>
          </label>
        )}

        <div>
          <p className="mb-2 text-sm font-medium text-slate-900">Forma lekcji</p>
          {hasAddress ? (
            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
                <input
                  type="radio"
                  checked={mode === 'online'}
                  onChange={() => setMode('online')}
                  className="mt-0.5"
                />
                <span className="font-medium">💻 Online</span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 transition hover:bg-slate-50">
                <input
                  type="radio"
                  checked={mode === 'in_person'}
                  onChange={() => setMode('in_person')}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">📍 Stacjonarnie</span>
                  <span className="ml-1 block text-xs text-slate-600 sm:inline">
                    ({teacher?.address})
                  </span>
                </span>
              </label>
            </div>
          ) : (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              💻 Online — ten nauczyciel nie udostępnia adresu lekcji stacjonarnych.
            </p>
          )}
        </div>

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
            disabled={pending || availability.length === 0}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? 'Wysyłanie…' : 'Wyślij propozycję'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
