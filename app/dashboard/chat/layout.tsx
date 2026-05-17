import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ConversationList } from './conversation-list'
import { TabsProvider } from './tabs-provider'
import { TabsBar } from './tabs-bar'
import { previewLine, type ConversationSummary } from './shared'

// Layout buduje lewą kolumnę (lista konwersacji) — wspólną dla
// /dashboard/chat i /dashboard/chat/[id]. Środek + prawą renderuje children.
//
// force-dynamic: lista zmienia się przy każdej nowej wiadomości, a
// równolegle z renderem czatu policzymy unread_count per konwersacja.
export const dynamic = 'force-dynamic'

export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // 1) Wszystkie konwersacje użytkownika z imieniem drugiej strony.
  const { data: convsRaw } = await supabase
    .from('conversations')
    .select(
      'id, teacher_id, student_id, last_message_at, teacher:profiles!conversations_teacher_id_fkey(first_name, last_name), student:profiles!conversations_student_id_fkey(first_name, last_name)',
    )
    .order('last_message_at', { ascending: false })

  type ConvRaw = {
    id: string
    teacher_id: string
    student_id: string
    last_message_at: string
    teacher: { first_name: string | null; last_name: string | null } | null
    student: { first_name: string | null; last_name: string | null } | null
  }
  const convs = (convsRaw ?? []) as unknown as ConvRaw[]

  if (convs.length === 0) {
    return (
      <TabsProvider>
        <ChatShell
          list={<ConversationList userId={user.id} initial={[]} />}
        >
          {children}
        </ChatShell>
      </TabsProvider>
    )
  }

  // 2) Ostatnia wiadomość + licznik nieprzeczytanych per konwersacja.
  //    Robimy to bulkiem — po dwóch zapytaniach, agregujemy w JS.
  const convIds = convs.map((c) => c.id)

  const { data: lastMsgs } = await supabase
    .from('messages')
    .select('conversation_id, content, file_name, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })

  const lastPerConv = new Map<string, { content: string | null; file_name: string | null }>()
  for (const m of lastMsgs ?? []) {
    if (!lastPerConv.has(m.conversation_id)) {
      lastPerConv.set(m.conversation_id, {
        content: m.content,
        file_name: m.file_name,
      })
    }
  }

  const { data: unreadMsgs } = await supabase
    .from('messages')
    .select('conversation_id')
    .in('conversation_id', convIds)
    .neq('sender_id', user.id)
    .is('read_at', null)

  const unreadPerConv = new Map<string, number>()
  for (const m of unreadMsgs ?? []) {
    unreadPerConv.set(
      m.conversation_id,
      (unreadPerConv.get(m.conversation_id) ?? 0) + 1,
    )
  }

  const summaries: ConversationSummary[] = convs.map((c) => {
    const isTeacher = c.teacher_id === user.id
    const other = isTeacher ? c.student : c.teacher
    const other_id = isTeacher ? c.student_id : c.teacher_id
    const name =
      [other?.first_name, other?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim() || 'Użytkownik'
    return {
      id: c.id,
      other_id,
      other_name: name,
      last_message_at: c.last_message_at,
      last_message_preview: previewLine(lastPerConv.get(c.id) ?? null),
      unread_count: unreadPerConv.get(c.id) ?? 0,
    }
  })

  return (
    <TabsProvider>
      <ChatShell
        list={<ConversationList userId={user.id} initial={summaries} />}
      >
        {children}
      </ChatShell>
    </TabsProvider>
  )
}

// Shell trzymający proporcje: lewa kolumna stała, reszta elastyczna.
//
// FULL-BLEED:
// Rodzicielski <main> dashboardu ma max-w-5xl. Czat potrzebuje pełnej
// szerokości, więc używamy klasycznej sztuczki: `w-screen` + `left-1/2
// -translate-x-1/2`, żeby wyjść poza ograniczenie max-width. Negative -mt-8
// niweluje py-8 nadrzędnego main.
//
// Mobile (<lg) layout jest jednokolumnowy — children zarządzają widocznością
// list/details (np. /chat pokazuje listę, /chat/[id] tylko czat z linkiem
// powrotu).
function ChatShell({
  list,
  children,
}: {
  list: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="relative left-1/2 -ml-[50vw] -mt-8 h-[calc(100vh-9rem)] w-screen">
      <div className="mx-auto flex h-full max-w-[1600px] overflow-hidden border-y border-slate-200 bg-white lg:border lg:border-slate-200">
        <aside className="hidden w-[300px] shrink-0 border-r border-slate-200 lg:flex lg:flex-col">
          {list}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <TabsBar />
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </div>
      </div>
    </div>
  )
}
