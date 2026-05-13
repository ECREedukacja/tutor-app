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
