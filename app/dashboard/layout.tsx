import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { logout } from './actions'
import { DashboardNav } from './nav'
import { Notifications } from './notifications'

// Layout zawiera licznik oczekujących próśb — musi być policzony za każdym
// renderem; bez force-dynamic Next cache'uje RSC payload layoutu i badge
// pokazuje stary stan przy nawigacji client-side.
export const dynamic = 'force-dynamic'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, role')
    .eq('id', user.id)
    .single()

  const role = profile?.role ?? 'student'
  const displayName =
    profile?.first_name?.trim() ||
    user.email?.split('@')[0] ||
    'Użytkownik'

  let pendingCount = 0
  if (role === 'teacher') {
    const { count } = await supabase
      .from('student_teacher_requests')
      .select('id', { count: 'exact', head: true })
      .eq('teacher_id', user.id)
      .eq('status', 'pending')
    pendingCount = count ?? 0
  }

  // Liczba oczekujących propozycji do akceptacji (od drugiej strony pary).
  // Dla nauczyciela: propozycje wysłane przez ucznia. Dla ucznia: propozycje
  // wysłane przez nauczyciela.
  //
  // Używamy fetchu id-ów + .length zamiast `count: 'exact', head: true`, bo
  // kombinacja head:true + .neq() + RLS bywa zawodna (planner czasem zwraca
  // 0 mimo widocznych wierszy). Liczba pending propozycji per użytkownik jest
  // znikoma, więc koszt pobrania kilku id-ów jest pomijalny.
  const partyColumn = role === 'teacher' ? 'teacher_id' : 'student_id'
  const { data: pendingProposals } = await supabase
    .from('lesson_proposals')
    .select('id')
    .eq(partyColumn, user.id)
    .eq('status', 'pending')
    .neq('proposer_id', user.id)
  const proposalsPending = pendingProposals?.length ?? 0

  // Badge "Prace domowe":
  //   • uczeń: prace 'sent' (jeszcze nieotworzone — czyli bez przejścia na in_progress)
  //   • nauczyciel: prace 'submitted' (oddane, czekają na ocenę)
  let assignmentsPending = 0
  if (role === 'teacher') {
    const { count } = await supabase
      .from('assignments')
      .select('id', { count: 'exact', head: true })
      .eq('teacher_id', user.id)
      .eq('status', 'submitted')
    assignmentsPending = count ?? 0
  } else {
    const { count } = await supabase
      .from('assignments')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', user.id)
      .eq('status', 'sent')
    assignmentsPending = count ?? 0
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link
            href="/dashboard"
            className="text-lg font-semibold tracking-tight text-slate-900 transition hover:text-indigo-600"
          >
            Tutor App
          </Link>
          <div className="flex items-center gap-3">
            <Notifications userId={user.id} />
            <span className="hidden text-sm text-slate-600 sm:inline">
              {displayName}
            </span>
            <form action={logout}>
              <button
                type="submit"
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
              >
                Wyloguj się
              </button>
            </form>
          </div>
        </div>
        <DashboardNav
          role={role}
          pendingCount={pendingCount}
          proposalsPending={proposalsPending}
          assignmentsPending={assignmentsPending}
        />
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  )
}
