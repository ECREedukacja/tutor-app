'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import type { LessonMode } from '@/lib/calendar'

const RESCHEDULE_BY_STUDENT_MIN_MS = 24 * 60 * 60 * 1000
const CANCEL_BY_STUDENT_MIN_MS = 24 * 60 * 60 * 1000

// Tworzy wolny termin. RLS pozwala nauczycielowi na INSERT tylko z własnym
// teacher_id, dodatkowo trigger validate_availability sprawdza rolę i to,
// że termin jest w przyszłości.
export async function createAvailability(startAtIso: string): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { error } = await supabase.from('availability').insert({
    teacher_id: user.id,
    start_at: startAtIso,
  })
  if (error) throw new Error(error.message)
}

export async function deleteAvailability(id: string): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { error } = await supabase
    .from('availability')
    .delete()
    .eq('id', id)
    .eq('teacher_id', user.id)
  if (error) throw new Error(error.message)
}

// Rezerwacja lekcji — wszystko (insert lessons + delete availability) dzieje
// się atomowo w funkcji RPC book_lesson.
export async function bookLesson(
  availabilityId: string,
  mode: LessonMode = 'online',
): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { data, error } = await supabase.rpc('book_lesson', {
    p_availability_id: availabilityId,
    p_student_id: user.id,
    p_mode: mode,
  })
  if (error) throw new Error(error.message)
  return data as string
}

// ----------------------------------------------------------------------------
// Nauczyciel: planowanie i przenoszenie lekcji „od razu"
// ----------------------------------------------------------------------------

// Nauczyciel tworzy lekcję bezpośrednio dla wybranego ucznia (bez slotu).
// Polityka RLS „Teachers schedule own lessons" + trigger validate_lesson
// pilnują, że istnieje powiązanie i role są zgodne.
export async function scheduleLessonDirectly(args: {
  studentId: string
  startAtIso: string
  mode: LessonMode
}): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { data, error } = await supabase
    .from('lessons')
    .insert({
      teacher_id: user.id,
      student_id: args.studentId,
      start_at: args.startAtIso,
      mode: args.mode,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)

  // Defense-in-depth: trigger `cleanup_availability_on_lesson` powinien usunąć
  // kolidujący slot, ale dla pewności i czytelności robimy też jawny DELETE.
  await supabase
    .from('availability')
    .delete()
    .eq('teacher_id', user.id)
    .eq('start_at', args.startAtIso)

  return data.id as string
}

// Nauczyciel przenosi swoją lekcję na inny termin — bez ograniczeń czasowych.
export async function rescheduleLessonDirectly(args: {
  lessonId: string
  startAtIso: string
  mode: LessonMode
}): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { error } = await supabase
    .from('lessons')
    .update({
      start_at: args.startAtIso,
      mode: args.mode,
    })
    .eq('id', args.lessonId)
    .eq('teacher_id', user.id)
  if (error) throw new Error(error.message)

  // Defense-in-depth — j.w. Stary slot świadomie NIE jest przywracany; jeśli
  // nauczyciel chce ponownie udostępnić poprzedni termin, dodaje go ręcznie.
  await supabase
    .from('availability')
    .delete()
    .eq('teacher_id', user.id)
    .eq('start_at', args.startAtIso)
}

// ----------------------------------------------------------------------------
// Propozycje
// ----------------------------------------------------------------------------

// Tworzy propozycję lekcji. Po stronie serwera robimy walidację 24h dla
// ucznia proponującego reschedule (nauczyciel nie ma ograniczeń czasowych).
export async function createProposal(args: {
  kind: 'new_lesson' | 'reschedule'
  teacherId: string
  studentId: string
  originalLessonId?: string | null
  startAtIso: string
  mode: LessonMode
}): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  if (user.id !== args.teacherId && user.id !== args.studentId) {
    throw new Error('Nie jesteś stroną tej relacji.')
  }
  if (args.kind === 'reschedule' && !args.originalLessonId) {
    throw new Error('Brak lekcji źródłowej do przeniesienia.')
  }
  if (args.kind === 'new_lesson' && args.originalLessonId) {
    throw new Error('Nowa lekcja nie może mieć lekcji źródłowej.')
  }

  // Walidacja 24h: tylko gdy uczeń proponuje reschedule.
  if (args.kind === 'reschedule' && user.id === args.studentId) {
    const { data: lesson, error: lessonErr } = await supabase
      .from('lessons')
      .select('start_at, student_id')
      .eq('id', args.originalLessonId!)
      .single()
    if (lessonErr) throw new Error(lessonErr.message)
    if (lesson.student_id !== user.id) {
      throw new Error('Lekcja nie należy do Ciebie.')
    }
    const diff = new Date(lesson.start_at).getTime() - Date.now()
    if (diff <= RESCHEDULE_BY_STUDENT_MIN_MS) {
      throw new Error('Zmiana terminu możliwa do 24h przed lekcją.')
    }
  }

  const { data, error } = await supabase
    .from('lesson_proposals')
    .insert({
      kind: args.kind,
      teacher_id: args.teacherId,
      student_id: args.studentId,
      proposer_id: user.id,
      original_lesson_id: args.originalLessonId ?? null,
      start_at: args.startAtIso,
      mode: args.mode,
    })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  // Badge w nawigacji liczy oczekujące propozycje od drugiej strony — po
  // utworzeniu naszej propozycji druga strona zobaczy nowy badge dopiero
  // po revalidacji layoutu.
  revalidatePath('/dashboard', 'layout')
  return data.id as string
}

// Druga strona (nie proposer) zmienia status na accepted/rejected. Trigger
// w bazie tworzy/aktualizuje lekcję przy akceptacji.
export async function respondToProposal(
  proposalId: string,
  accept: boolean,
): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  // Sprawdzamy że odpowiadający NIE jest proposerem oraz że propozycja jest pending.
  const { data: prop, error: pErr } = await supabase
    .from('lesson_proposals')
    .select('proposer_id, teacher_id, student_id, status')
    .eq('id', proposalId)
    .single()
  if (pErr) throw new Error(pErr.message)
  if (prop.proposer_id === user.id) {
    throw new Error('Proposer nie odpowiada na własną propozycję.')
  }
  if (user.id !== prop.teacher_id && user.id !== prop.student_id) {
    throw new Error('Nie jesteś stroną tej propozycji.')
  }
  if (prop.status !== 'pending') {
    throw new Error('Propozycja została już rozpatrzona.')
  }

  const { error } = await supabase
    .from('lesson_proposals')
    .update({ status: accept ? 'accepted' : 'rejected' })
    .eq('id', proposalId)
  if (error) throw new Error(error.message)
  revalidatePath('/dashboard', 'layout')
}

// ----------------------------------------------------------------------------
// Odwołanie lekcji
// ----------------------------------------------------------------------------

// Odwołanie lekcji: status → 'cancelled', cancelled_by, cancelled_at.
// - Uczeń może odwołać TYLKO gdy do startu lekcji > 24h.
// - Nauczyciel: brak ograniczeń czasowych.
// RLS pozwala obu stronom na UPDATE własnych lekcji, ale 24h sprawdzamy tu
// (klient nie jest zaufany).
export async function cancelLesson(lessonId: string): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { data: lesson, error: lErr } = await supabase
    .from('lessons')
    .select('teacher_id, student_id, start_at, status')
    .eq('id', lessonId)
    .single()
  if (lErr) throw new Error(lErr.message)
  if (user.id !== lesson.teacher_id && user.id !== lesson.student_id) {
    throw new Error('Nie jesteś stroną tej lekcji.')
  }
  if (lesson.status !== 'scheduled') {
    throw new Error('Lekcja została już rozpatrzona.')
  }

  if (user.id === lesson.student_id) {
    const diff = new Date(lesson.start_at).getTime() - Date.now()
    if (diff <= CANCEL_BY_STUDENT_MIN_MS) {
      throw new Error('Odwołanie możliwe do 24h przed lekcją.')
    }
  }

  const { error } = await supabase
    .from('lessons')
    .update({
      status: 'cancelled',
      cancelled_by: user.id,
      cancelled_at: new Date().toISOString(),
    })
    .eq('id', lessonId)
  if (error) throw new Error(error.message)
  revalidatePath('/dashboard', 'layout')
}

// ----------------------------------------------------------------------------
// Cykliczne lekcje tygodniowe (tworzy nauczyciel)
// ----------------------------------------------------------------------------

// Domyślny horyzont generacji — 12 tygodni naprzód od daty pierwszej lekcji
// (lub od dziś przy dogenerowywaniu). Po wyczerpaniu nauczyciel klika
// „Dogeneruj kolejne 12 tygodni" w sekcji „Moje cykle".
const RECURRING_DEFAULT_HORIZON_WEEKS = 12

function addDaysIso(date: Date, days: number): Date {
  const r = new Date(date)
  r.setDate(r.getDate() + days)
  return r
}

function toDateOnly(d: Date): string {
  // YYYY-MM-DD w lokalnym czasie — odpowiada typowi DATE w Postgresie.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Tworzy wzorzec cyklu + uruchamia generator na 12 tygodni naprzód
// (bezpieczna domyślna pula; resztę dogeneruje nauczyciel lub w przyszłości cron).
export async function createRecurringLesson(args: {
  studentId: string
  startAtIso: string // pierwszy termin (data + godzina lokalna nauczyciela)
  mode: LessonMode
  endsOnDate: string | null // YYYY-MM-DD lub null dla cyklu bez końca
}): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const firstStart = new Date(args.startAtIso)
  if (firstStart.getTime() <= Date.now()) {
    throw new Error('Pierwszy termin cyklu musi być w przyszłości.')
  }
  if (firstStart.getMinutes() % 15 !== 0 || firstStart.getSeconds() !== 0) {
    throw new Error('Godzina musi być na siatce 15-minutowej.')
  }
  if (args.endsOnDate) {
    const endsOn = new Date(args.endsOnDate + 'T00:00:00')
    const minEnd = addDaysIso(firstStart, 7)
    if (endsOn.getTime() < new Date(toDateOnly(minEnd)).getTime()) {
      throw new Error('Data końcowa musi być co najmniej tydzień po pierwszej lekcji.')
    }
    const maxEnd = addDaysIso(firstStart, 365 * 2)
    if (endsOn.getTime() > new Date(toDateOnly(maxEnd)).getTime()) {
      throw new Error('Data końcowa nie może przekraczać 2 lat od pierwszej lekcji.')
    }
  }

  const dayOfWeek = firstStart.getDay() // 0=Nd..6=Sb — pokrywa się z PG dow
  const hh = String(firstStart.getHours()).padStart(2, '0')
  const mm = String(firstStart.getMinutes()).padStart(2, '0')
  const timeOfDay = `${hh}:${mm}:00`
  const startsOn = toDateOnly(firstStart)

  const { data: inserted, error: insertErr } = await supabase
    .from('recurring_lessons')
    .insert({
      teacher_id: user.id,
      student_id: args.studentId,
      day_of_week: dayOfWeek,
      time_of_day: timeOfDay,
      mode: args.mode,
      starts_on: startsOn,
      ends_on: args.endsOnDate,
    })
    .select('id')
    .single()
  if (insertErr) throw new Error(insertErr.message)

  // Generujemy 12 tygodni naprzód lub do ends_on (cokolwiek wcześniejsze
  // — funkcja w bazie sama wybiera MIN).
  const horizon = addDaysIso(firstStart, RECURRING_DEFAULT_HORIZON_WEEKS * 7)
  const { error: genErr } = await supabase.rpc('generate_recurring_lessons', {
    p_recurring_id: inserted.id,
    p_until: toDateOnly(horizon),
  })
  if (genErr) throw new Error(genErr.message)

  revalidatePath('/dashboard', 'layout')
  return inserted.id as string
}

// Dogeneruj kolejne tygodnie cyklu (idempotentne — pomija daty z lekcjami).
export async function extendRecurringLessons(args: {
  recurringId: string
  weeksToExtend: number
}): Promise<number> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const weeks = Math.max(1, Math.min(104, Math.floor(args.weeksToExtend)))
  const until = addDaysIso(new Date(), weeks * 7)

  // RLS upewnia się że tylko teacher cyklu może wywołać generator z efektem
  // (funkcja działa pod SECURITY DEFINER, ale wstawia lekcje dla pary
  // teacher/student z wzorca — pozostawiamy weryfikację właściciela cyklu
  // po stronie polityki SELECT w UI; tutaj realnie chroni RLS na lessons
  // przez powiązanie teacher_id).
  const { data: created, error } = await supabase.rpc(
    'generate_recurring_lessons',
    {
      p_recurring_id: args.recurringId,
      p_until: toDateOnly(until),
    },
  )
  if (error) throw new Error(error.message)
  revalidatePath('/dashboard', 'layout')
  return (created as number) ?? 0
}

// Przenosi cykl od konkretnej lekcji włącznie: kończy obecny cykl od tej daty
// (cancel_recurring_series) i tworzy nowy cykl z nowym startem. Zachowujemy
// oryginalne ends_on, jeśli leży po nowej dacie startu — w przeciwnym razie
// nowy cykl jest bez końca.
export async function rescheduleRecurringSeries(args: {
  recurringId: string
  fromLessonDate: string // YYYY-MM-DD — data oryginalnej lekcji do przeniesienia
  newStartAtIso: string
  newMode: LessonMode
}): Promise<string> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { data: cycle, error: cErr } = await supabase
    .from('recurring_lessons')
    .select('teacher_id, student_id, ends_on, starts_on')
    .eq('id', args.recurringId)
    .single()
  if (cErr) throw new Error(cErr.message)
  if (cycle.teacher_id !== user.id) {
    throw new Error('Tylko nauczyciel cyklu może go przenieść.')
  }

  // 1) Zakończ obecną serię od daty oryginalnej lekcji włącznie.
  const { error: cancelErr } = await supabase.rpc('cancel_recurring_series', {
    p_recurring_id: args.recurringId,
    p_from_date: args.fromLessonDate,
  })
  if (cancelErr) throw new Error(cancelErr.message)

  // 2) Wylicz, czy oryginalne ends_on ma sens w nowym cyklu.
  const newStart = new Date(args.newStartAtIso)
  let endsOn: string | null = null
  if (cycle.ends_on) {
    const oldEnd = new Date(cycle.ends_on + 'T00:00:00')
    if (oldEnd.getTime() >= newStart.getTime()) {
      endsOn = cycle.ends_on as string
    }
  }

  // 3) Utwórz nowy cykl od nowej daty/godziny.
  const newId = await createRecurringLesson({
    studentId: cycle.student_id as string,
    startAtIso: args.newStartAtIso,
    mode: args.newMode,
    endsOnDate: endsOn,
  })

  revalidatePath('/dashboard', 'layout')
  return newId
}

// Zakończ cykl od podanej daty (włącznie). Anuluje wszystkie scheduled
// lekcje z cyklu od p_from_date.
export async function cancelRecurringSeries(args: {
  recurringId: string
  fromDate: string // YYYY-MM-DD
}): Promise<number> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { data, error } = await supabase.rpc('cancel_recurring_series', {
    p_recurring_id: args.recurringId,
    p_from_date: args.fromDate,
  })
  if (error) throw new Error(error.message)
  revalidatePath('/dashboard', 'layout')
  return (data as number) ?? 0
}

export async function cancelProposal(proposalId: string): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { data: prop, error: pErr } = await supabase
    .from('lesson_proposals')
    .select('proposer_id, status')
    .eq('id', proposalId)
    .single()
  if (pErr) throw new Error(pErr.message)
  if (prop.proposer_id !== user.id) {
    throw new Error('Anulować propozycję może tylko jej autor.')
  }
  if (prop.status !== 'pending') {
    throw new Error('Propozycja została już rozpatrzona.')
  }

  const { error } = await supabase
    .from('lesson_proposals')
    .update({ status: 'cancelled' })
    .eq('id', proposalId)
  if (error) throw new Error(error.message)
  revalidatePath('/dashboard', 'layout')
}
