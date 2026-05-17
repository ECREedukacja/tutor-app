import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signManyFileUrls, markRead } from '../actions'
import { ChatView } from './chat-view'
import { FilesPanel } from './files-panel'
import { AutoTab } from './auto-tab'
import type { FileItem, MessageRow } from '../shared'

// /dashboard/chat/[conversationId] — aktywna konwersacja w środku + pliki po prawej.
export const dynamic = 'force-dynamic'

export default async function ChatConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>
}) {
  const { conversationId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // 1) Konwersacja + druga strona.
  const { data: convRaw } = await supabase
    .from('conversations')
    .select(
      'id, teacher_id, student_id, last_message_at, created_at, teacher:profiles!conversations_teacher_id_fkey(first_name, last_name), student:profiles!conversations_student_id_fkey(first_name, last_name)',
    )
    .eq('id', conversationId)
    .maybeSingle()

  if (!convRaw) notFound()

  type ConvRaw = {
    id: string
    teacher_id: string
    student_id: string
    last_message_at: string
    created_at: string
    teacher: { first_name: string | null; last_name: string | null } | null
    student: { first_name: string | null; last_name: string | null } | null
  }
  const conv = convRaw as unknown as ConvRaw

  if (conv.teacher_id !== user.id && conv.student_id !== user.id) {
    notFound()
  }

  const isTeacher = conv.teacher_id === user.id
  const other = isTeacher ? conv.student : conv.teacher
  const otherId = isTeacher ? conv.student_id : conv.teacher_id
  const otherName =
    [other?.first_name, other?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Użytkownik'

  // 2) Wiadomości (rosnąco, do limitu — najnowsze 500).
  const { data: messagesRaw } = await supabase
    .from('messages')
    .select(
      'id, conversation_id, sender_id, content, file_url, file_name, file_size, file_type, read_at, created_at',
    )
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500)
  const messages = (messagesRaw ?? []) as MessageRow[]

  // 3) Oznacz cudze wiadomości jako przeczytane (RPC) — przy każdym wejściu na
  //    stronę konwersacji. Frontend dodatkowo odpala mark_messages_read przy
  //    odzyskaniu focusu (w razie gdyby user otworzył inną kartę i wrócił).
  try {
    await markRead(conversationId)
  } catch {
    // Cicho — niekrytyczne; UI w pasku statusu nic by z tym nie zrobił.
  }

  // 4) Pliki z konwersacji + podpisane URL-e.
  const filePaths = messages
    .filter((m) => m.file_url)
    .map((m) => m.file_url as string)
  const signed = await signManyFileUrls(filePaths)

  const files: FileItem[] = messages
    .filter((m) => m.file_url)
    .map((m) => ({
      message_id: m.id,
      path: m.file_url as string,
      name: m.file_name ?? 'plik',
      size: m.file_size,
      type: m.file_type,
      sender_id: m.sender_id,
      created_at: m.created_at,
      signed_url: signed[m.file_url as string] ?? null,
    }))
    .reverse() // najnowsze na górze

  // 5) Mapa signed URL dla bąbelków w czacie (te same pliki).
  const signedUrlMap = signed

  return (
    <div className="flex h-full min-w-0 flex-1">
      <AutoTab id={conversationId} name={otherName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatView
          key={conversationId}
          conversationId={conversationId}
          currentUserId={user.id}
          otherName={otherName}
          otherId={otherId}
          initialMessages={messages}
          signedUrls={signedUrlMap}
        />
      </div>
      <aside className="hidden w-[280px] shrink-0 border-l border-slate-200 lg:flex lg:flex-col">
        <FilesPanel files={files} />
      </aside>
    </div>
  )
}
