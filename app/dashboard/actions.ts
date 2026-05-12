'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { TeacherSearchResult } from './types'

export async function logout() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}

// Wyszukanie nauczycieli po imieniu, nazwisku lub e-mailu.
// Zwraca tylko nauczycieli, z którymi uczeń nie ma jeszcze powiązania ani
// otwartej prośby (pending/accepted). Używa service_role, bo standardowe
// RLS na profiles pozwala czytać tylko własny profil.
export async function searchTeachers(query: string): Promise<TeacherSearchResult[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { data: me } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  if (me?.role !== 'student') {
    throw new Error('Tylko uczeń może wyszukiwać nauczycieli.')
  }

  const admin = createAdminClient()

  // ID nauczycieli, których trzeba wykluczyć: istniejące prośby pending/accepted
  // oraz aktualne powiązania w teacher_students.
  const [{ data: requests }, { data: links }] = await Promise.all([
    admin
      .from('student_teacher_requests')
      .select('teacher_id, status')
      .eq('student_id', user.id)
      .in('status', ['pending', 'accepted']),
    admin
      .from('teacher_students')
      .select('teacher_id')
      .eq('student_id', user.id),
  ])

  const excluded = new Set<string>([
    ...(requests?.map((r) => r.teacher_id) ?? []),
    ...(links?.map((l) => l.teacher_id) ?? []),
  ])

  // Pełna mapa e-maili z auth.users — potrzebna i do wyszukania po e-mailu,
  // i do uzupełnienia wyników o adres widoczny w UI.
  const { data: usersPage, error: usersErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  })
  if (usersErr) throw new Error(usersErr.message)

  const emailById = new Map<string, string>()
  const queryLower = trimmed.toLowerCase()
  const idsMatchingEmail: string[] = []
  for (const u of usersPage.users) {
    if (!u.email) continue
    emailById.set(u.id, u.email)
    if (u.email.toLowerCase().includes(queryLower)) idsMatchingEmail.push(u.id)
  }

  const like = `%${trimmed}%`
  const orParts = [`first_name.ilike.${like}`, `last_name.ilike.${like}`]
  if (idsMatchingEmail.length > 0) {
    orParts.push(`id.in.(${idsMatchingEmail.join(',')})`)
  }

  const { data: profiles, error } = await admin
    .from('profiles')
    .select('id, first_name, last_name')
    .eq('role', 'teacher')
    .or(orParts.join(','))
    .limit(50)
  if (error) throw new Error(error.message)

  return (profiles ?? [])
    .filter((p) => p.id !== user.id && !excluded.has(p.id))
    .map((p) => ({
      id: p.id,
      first_name: p.first_name,
      last_name: p.last_name,
      email: emailById.get(p.id) ?? '',
    }))
    .slice(0, 20)
}

export async function sendRequest(teacherId: string, message: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const trimmed = message.trim()
  const { error } = await supabase.from('student_teacher_requests').insert({
    student_id: user.id,
    teacher_id: teacherId,
    message: trimmed.length > 0 ? trimmed : null,
  })
  if (error) throw new Error(error.message)

  revalidatePath('/dashboard/teachers')
  // Inwalidacja layoutu nauczyciela też — jego badge powinien wzrosnąć
  // przy najbliższym wejściu na dashboard po wysłaniu prośby przez ucznia.
  revalidatePath('/dashboard', 'layout')
}

export async function respondToRequest(requestId: string, accept: boolean) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { error } = await supabase
    .from('student_teacher_requests')
    .update({ status: accept ? 'accepted' : 'rejected' })
    .eq('id', requestId)
    .eq('teacher_id', user.id)
  if (error) throw new Error(error.message)

  // 'layout' bo licznik oczekujących próśb żyje w app/dashboard/layout.tsx —
  // bez tego badge zostaje przy starej wartości po akceptacji/odrzuceniu.
  revalidatePath('/dashboard', 'layout')
}

// Helper: pobiera e-maile dla listy user_id z auth.users (wymaga service_role).
export async function fetchEmailsByIds(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {}
  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) throw new Error(error.message)

  const wanted = new Set(ids)
  const map: Record<string, string> = {}
  for (const u of data.users) {
    if (wanted.has(u.id) && u.email) map[u.id] = u.email
  }
  return map
}
