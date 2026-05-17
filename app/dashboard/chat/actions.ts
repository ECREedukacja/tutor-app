'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'

// Dozwolone typy MIME i limit rozmiaru — walidowane też po stronie klienta
// (UX), ale tu jest źródło prawdy (klient można obejść).
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
])

const SIGNED_URL_TTL_SEC = 7 * 24 * 60 * 60 // 7 dni

// ----------------------------------------------------------------------------
// sendMessage — tekstowa wiadomość (bez pliku).
// ----------------------------------------------------------------------------
export async function sendMessage(conversationId: string, content: string) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const trimmed = content.trim()
  if (trimmed.length === 0) throw new Error('Wiadomość nie może być pusta.')

  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_id: user.id,
    content: trimmed,
  })
  if (error) throw new Error(error.message)

  // 'layout' bo licznik nieprzeczytanych w nav.tsx siedzi w layoucie.
  revalidatePath('/dashboard', 'layout')
}

// ----------------------------------------------------------------------------
// uploadChatFile — upload pliku + INSERT wiadomości z linkiem do niego.
// Przyjmuje FormData, bo Server Actions natywnie obsługują pliki przez FormData.
// ----------------------------------------------------------------------------
export async function uploadChatFile(formData: FormData) {
  const conversationId = String(formData.get('conversationId') ?? '')
  const file = formData.get('file')
  const captionRaw = formData.get('content')
  const caption = typeof captionRaw === 'string' ? captionRaw.trim() : ''

  if (!conversationId) throw new Error('Brak konwersacji.')
  if (!(file instanceof File)) throw new Error('Brak pliku.')
  // UWAGA na kolejność: limit BODY Server Actions ustawiamy w next.config.ts
  // (12 MB). Sprawdzamy rozmiar PRZED testem „pusty”, bo przy przekroczeniu
  // limitu Next-a body bywa obcięte (file.size === 0) i komunikat „pusty”
  // byłby mylący.
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1)
    throw new Error(
      `Plik „${file.name}” jest za duży (rozmiar: ${mb} MB). Maksymalny rozmiar to 10 MB.`,
    )
  }
  if (file.size === 0) {
    throw new Error(
      `Plik „${file.name}” jest pusty lub został odrzucony przez serwer (mógł przekroczyć dopuszczalny rozmiar przesyłki).`,
    )
  }
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error(
      `Plik „${file.name}” nie jest obsługiwany. Dozwolone: JPG / PNG / WEBP / GIF, PDF.`,
    )
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  // Sprawdzenie czy user jest stroną — przyspiesza i daje czytelny błąd
  // (RLS na storage też by to wyłapał).
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('teacher_id, student_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (convErr) throw new Error(convErr.message)
  if (!conv || (conv.teacher_id !== user.id && conv.student_id !== user.id)) {
    throw new Error('Brak dostępu do tej konwersacji.')
  }

  // Sanityzacja nazwy: zostaw alfanum, kropki, myślniki i podkreślenia.
  const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'plik'
  const path = `${conversationId}/${randomUUID()}_${safeName}`

  const bytes = new Uint8Array(await file.arrayBuffer())

  const { error: upErr } = await supabase.storage
    .from('chat-files')
    .upload(path, bytes, {
      contentType: file.type,
      upsert: false,
    })
  if (upErr) {
    // Bucket w Supabase ma własny file-size-limit. Jeśli go przekroczymy,
    // dostajemy „The object exceeded the maximum allowed size" / „Payload too
    // large" — zamieniamy na komunikat zrozumiały dla użytkownika.
    const m = upErr.message.toLowerCase()
    if (
      m.includes('exceeded the maximum') ||
      m.includes('exceeded maximum') ||
      m.includes('payload too large') ||
      m.includes('max size') ||
      m.includes('maximum file size')
    ) {
      const mb = (file.size / (1024 * 1024)).toFixed(1)
      throw new Error(
        `Plik „${file.name}” jest za duży dla serwera (rozmiar: ${mb} MB). Maksymalny rozmiar to 10 MB.`,
      )
    }
    throw new Error('Upload nieudany: ' + upErr.message)
  }

  const { error: insErr } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_id: user.id,
    content: caption.length > 0 ? caption : null,
    file_url: path, // przechowujemy ścieżkę; podpisany URL generujemy przy odczycie
    file_name: file.name,
    file_size: file.size,
    file_type: file.type,
  })
  if (insErr) {
    // Best-effort: usuń plik gdy INSERT padł, żeby nie zostawiać sierot.
    await supabase.storage.from('chat-files').remove([path])
    throw new Error(insErr.message)
  }

  revalidatePath('/dashboard', 'layout')
}

// ----------------------------------------------------------------------------
// markRead — oznacza wszystkie cudze wiadomości w konwersacji jako przeczytane.
// ----------------------------------------------------------------------------
export async function markRead(conversationId: string) {
  const supabase = await createClient()
  const { error } = await supabase.rpc('mark_messages_read', {
    p_conversation_id: conversationId,
  })
  if (error) throw new Error(error.message)
  revalidatePath('/dashboard', 'layout')
}

// ----------------------------------------------------------------------------
// startConversation — wywoływane z list "Moi uczniowie" / "Moi nauczyciele".
// Tworzy konwersację (lub zwraca istniejącą) i przekierowuje do niej.
// ----------------------------------------------------------------------------
export async function startConversation(otherUserId: string): Promise<never> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('get_or_create_conversation', {
    p_other_user_id: otherUserId,
  })
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Nie udało się otworzyć konwersacji.')
  redirect(`/dashboard/chat/${data}`)
}

// ----------------------------------------------------------------------------
// signFileUrl — podpisany URL do pliku w chat-files. Używamy w server
// components (lista plików, render kafelka). 7 dni TTL — i tak strona się
// odświeża, więc krótszy TTL nie poprawia bezpieczeństwa, a popsułby UX.
// ----------------------------------------------------------------------------
export async function signFileUrl(path: string): Promise<string | null> {
  const supabase = await createClient()
  const { data, error } = await supabase.storage
    .from('chat-files')
    .createSignedUrl(path, SIGNED_URL_TTL_SEC)
  if (error) return null
  return data?.signedUrl ?? null
}

// ----------------------------------------------------------------------------
// fetchRelatedPeople — wszystkie powiązane osoby (przeciwna rola) z
// teacher_students. Używane w wyszukiwarce w lewej kolumnie, żeby umożliwić
// rozpoczęcie nowej konwersacji z osobą, z którą jeszcze jej nie mamy.
// ----------------------------------------------------------------------------
export type RelatedPerson = {
  id: string
  name: string
  lastName: string // do sortowania alfabetycznego po nazwisku
}

export async function fetchRelatedPeople(): Promise<RelatedPerson[]> {
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

  const isTeacher = me?.role === 'teacher'

  // Druga strona pary w teacher_students.
  const { data: linksRaw } = isTeacher
    ? await supabase
        .from('teacher_students')
        .select(
          'student_id, student:profiles!teacher_students_student_id_fkey(first_name, last_name)',
        )
        .eq('teacher_id', user.id)
    : await supabase
        .from('teacher_students')
        .select(
          'teacher_id, teacher:profiles!teacher_students_teacher_id_fkey(first_name, last_name)',
        )
        .eq('student_id', user.id)

  type LinkRow = {
    student_id?: string
    teacher_id?: string
    student?: { first_name: string | null; last_name: string | null } | null
    teacher?: { first_name: string | null; last_name: string | null } | null
  }
  const links = (linksRaw ?? []) as unknown as LinkRow[]

  return links
    .map((l): RelatedPerson => {
      const id = (isTeacher ? l.student_id : l.teacher_id) ?? ''
      const prof = isTeacher ? l.student : l.teacher
      const name =
        [prof?.first_name, prof?.last_name]
          .filter(Boolean)
          .join(' ')
          .trim() || 'Użytkownik'
      const lastName = (prof?.last_name ?? '').trim() || name
      return { id, name, lastName }
    })
    .filter((p) => p.id)
}

export async function signManyFileUrls(
  paths: string[],
): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const supabase = await createClient()
  const out: Record<string, string> = {}
  // createSignedUrls przyjmuje listę i zwraca wpisy w tej samej kolejności.
  const { data, error } = await supabase.storage
    .from('chat-files')
    .createSignedUrls(paths, SIGNED_URL_TTL_SEC)
  if (error || !data) return out
  for (const entry of data) {
    if (entry.path && entry.signedUrl) {
      out[entry.path] = entry.signedUrl
    }
  }
  return out
}
