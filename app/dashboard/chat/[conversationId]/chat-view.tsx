'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatDateLong, formatTime } from '@/lib/calendar'
import { markRead, sendMessage, uploadChatFile } from '../actions'
import { formatBytes, isImage, isPdf, type MessageRow } from '../shared'

const SCROLL_THRESHOLD_PX = 80
const GROUPING_GAP_SEC = 5 * 60
const MAX_FILE_BYTES = 10 * 1024 * 1024
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
])

// TTL toastów — ważne komunikaty (rozmiar, typ pliku) zostają dłużej, żeby
// użytkownik zdążył przeczytać. Generyczne błędy uploadu — 4 s.
const TOAST_TTL_SIZE_MS = 10_000
const TOAST_TTL_VALIDATION_MS = 8_000
const TOAST_TTL_DEFAULT_MS = 4_000

// Walidacja pojedynczego pliku — wspólna dla input[type=file] i drop.
// duration sygnalizuje pushError-owi, jak długo trzymać toast.
function validateFile(
  f: File,
): { ok: true } | { ok: false; reason: string; duration: number } {
  if (!ALLOWED_MIME.has(f.type)) {
    return {
      ok: false,
      reason: `Plik „${f.name}” nie jest obsługiwany (dozwolone: JPG / PNG / WEBP / GIF, PDF).`,
      duration: TOAST_TTL_VALIDATION_MS,
    }
  }
  if (f.size > MAX_FILE_BYTES) {
    const mb = (f.size / (1024 * 1024)).toFixed(1)
    return {
      ok: false,
      reason: `Plik „${f.name}” jest za duży (rozmiar: ${mb} MB). Maksymalny rozmiar to 10 MB.`,
      duration: TOAST_TTL_SIZE_MS,
    }
  }
  return { ok: true }
}

// Stabilny id pliku w kolejce upload-u (wystarczy losowy string).
let _pendingSeq = 0
function nextPendingId(): string {
  _pendingSeq += 1
  return `p-${Date.now()}-${_pendingSeq}`
}

type PendingFile = {
  id: string
  file: File
  previewUrl: string | null // object URL dla obrazów; null dla PDF
}

function makePending(file: File): PendingFile {
  return {
    id: nextPendingId(),
    file,
    previewUrl: file.type.startsWith('image/')
      ? URL.createObjectURL(file)
      : null,
  }
}

// Lista dat po polsku — separator dni w liście wiadomości. Formatowanie
// deterministyczne (formatDateLong/formatTime), żeby SSR i CSR dawały ten sam
// string. „Dzisiaj"/„Wczoraj" zależy od bieżącej daty użytkownika — dlatego
// element renderujący ma suppressHydrationWarning.
function dayLabel(iso: string): string {
  const today = new Date()
  const d = new Date(iso)
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return 'Dzisiaj'

  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Wczoraj'

  return formatDateLong(d)
}

function timeLabel(iso: string): string {
  return formatTime(new Date(iso))
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function ChatView({
  conversationId,
  currentUserId,
  otherName,
  otherId: _otherId,
  initialMessages,
  signedUrls: initialSignedUrls,
}: {
  conversationId: string
  currentUserId: string
  otherName: string
  otherId: string
  initialMessages: MessageRow[]
  signedUrls: Record<string, string>
}) {
  void _otherId // zarezerwowane na status online/offline w przyszłości
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const [messages, setMessages] = useState<MessageRow[]>(initialMessages)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>(
    initialSignedUrls,
  )
  const [input, setInput] = useState('')
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  // Id pliku aktualnie wysyłanego (kolejka sekwencyjna) — do spinnera i etykiety.
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // Błędy walidacji drop/pick — toast-stack z indywidualnym TTL per toast
  // (rozmiar 10 s, walidacja 8 s, reszta 4 s). expiresAt = absolute ms.
  const [errors, setErrors] = useState<
    { id: string; text: string; expiresAt: number }[]
  >([])
  const [imageZoom, setImageZoom] = useState<{ src: string; name: string } | null>(null)
  // Drag-over overlay: licznik dragenter/leave (żeby nie migać przy enterze dziecka).
  const [isDragging, setIsDragging] = useState(false)
  const dragDepthRef = useRef(0)

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const isUserNearBottomRef = useRef(true)

  // Zwolnij object URL-e przy odmontowaniu, żeby nie zostawiać przecieku pamięci.
  useEffect(() => {
    return () => {
      for (const p of pendingFiles) {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
      }
    }
    // Celowo pusta lista zależności — chcemy tylko cleanup przy odmontowaniu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Toast-błędy: usuwamy najwcześniej wygasającego, planując timeout do
  // jego expiresAt. Re-uruchamia się gdy errors się zmieni.
  useEffect(() => {
    if (errors.length === 0) return
    const next = errors.reduce(
      (acc, e) => (e.expiresAt < acc.expiresAt ? e : acc),
      errors[0],
    )
    const remaining = Math.max(0, next.expiresAt - Date.now())
    const t = setTimeout(() => {
      setErrors((prev) => prev.filter((e) => e.id !== next.id))
    }, remaining)
    return () => clearTimeout(t)
  }, [errors])

  const pushError = useCallback(
    (text: string, duration: number = TOAST_TTL_DEFAULT_MS) => {
      setErrors((prev) => [
        ...prev,
        { id: nextPendingId(), text, expiresAt: Date.now() + duration },
      ])
    },
    [],
  )

  // Dodaje pliki do kolejki, waliduje każdy z osobna.
  const enqueueFiles = useCallback(
    (files: File[]) => {
      const next: PendingFile[] = []
      for (const f of files) {
        const v = validateFile(f)
        if (v.ok) next.push(makePending(f))
        else pushError(v.reason, v.duration)
      }
      if (next.length > 0) {
        setPendingFiles((prev) => [...prev, ...next])
      }
    },
    [pushError],
  )

  // Komponent jest remontowany przy zmianie konwersacji dzięki key= w parent
  // page; stan klienta od tej chwili jest napędzany wyłącznie realtime'em
  // (INSERT/UPDATE messages), więc sync z prop initialMessages nie jest
  // potrzebny. router.refresh() po wysyłce odświeża tylko sidebar (lista
  // plików, layout-badge); wiadomości w środkowej kolumnie dorzuca realtime.

  // Realtime: nowe wiadomości w tej konwersacji + UPDATE (read_at).
  useEffect(() => {
    const channel = supabase
      .channel(`chat-${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        async (payload) => {
          const m = payload.new as MessageRow
          setMessages((prev) =>
            prev.some((x) => x.id === m.id) ? prev : [...prev, m],
          )
          // Plik — dociągnij podpisany URL (zarówno dla naszych, jak i cudzych,
          // bo własny upload też przychodzi tutaj jako INSERT realtime).
          if (m.file_url) {
            const { data } = await supabase.storage
              .from('chat-files')
              .createSignedUrl(m.file_url, 7 * 24 * 60 * 60)
            if (data?.signedUrl) {
              setSignedUrls((prev) => ({ ...prev, [m.file_url!]: data.signedUrl }))
            }
          }
          // Cudza wiadomość → od razu oznacz jako przeczytaną (jesteśmy w czacie).
          if (m.sender_id !== currentUserId && document.hasFocus()) {
            try {
              await markRead(conversationId)
            } catch {}
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const m = payload.new as MessageRow
          setMessages((prev) => prev.map((x) => (x.id === m.id ? m : x)))
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [supabase, conversationId, currentUserId])

  // Re-mark-read przy odzyskaniu focusu/visibility.
  useEffect(() => {
    const onFocus = async () => {
      try {
        await markRead(conversationId)
      } catch {}
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void onFocus()
    })
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [conversationId])

  // Tracker scrolla: czy użytkownik jest blisko dołu? Jeśli nie — nie scroll'uj
  // automatycznie przy nowej wiadomości (zostawiamy go w jego pozycji).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      const dist = el.scrollHeight - (el.scrollTop + el.clientHeight)
      isUserNearBottomRef.current = dist < SCROLL_THRESHOLD_PX
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll do dołu przy montażu i nowych wiadomościach — gdy blisko dołu.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (isUserNearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages.length])

  // Wysyłka: tekst-only LUB N plików sekwencyjnie (każdy = osobna wiadomość).
  // Tekst z inputa trafia jako podpis do PIERWSZEGO pliku (jeśli są pliki),
  // żeby nie duplikować go w każdej wiadomości.
  const handleSend = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      if (sending) return
      const text = input.trim()
      const files = pendingFiles
      if (!text && files.length === 0) return

      setSending(true)
      try {
        if (files.length === 0) {
          await sendMessage(conversationId, text)
        } else {
          for (let i = 0; i < files.length; i++) {
            const p = files[i]
            setUploadingId(p.id)
            const fd = new FormData()
            fd.set('conversationId', conversationId)
            fd.set('file', p.file)
            if (i === 0 && text) fd.set('content', text)
            try {
              await uploadChatFile(fd)
              // Usuń wysłany plik z kolejki na bieżąco — żeby UI się odchudzało.
              setPendingFiles((prev) => prev.filter((x) => x.id !== p.id))
              if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
            } catch (uErr) {
              // Błędy server-side (rozmiar / typ / brak dostępu) — ważne, 8 s.
              pushError(
                uErr instanceof Error
                  ? `„${p.file.name}”: ${uErr.message}`
                  : `Nie udało się wysłać „${p.file.name}”.`,
                TOAST_TTL_VALIDATION_MS,
              )
            }
          }
          setUploadingId(null)
        }

        setInput('')
        if (fileInputRef.current) fileInputRef.current.value = ''
        // Realtime doniesie wiadomości, ale router.refresh() odświeży sidebar
        // (lista plików w prawej kolumnie + badge w nawigacji).
        router.refresh()
        isUserNearBottomRef.current = true
        if (textAreaRef.current) textAreaRef.current.style.height = 'auto'
      } catch (err) {
        pushError(
          err instanceof Error ? err.message : 'Nie udało się wysłać.',
          TOAST_TTL_VALIDATION_MS,
        )
      } finally {
        setSending(false)
        setUploadingId(null)
      }
    },
    [sending, input, pendingFiles, conversationId, router, pushError],
  )

  // Enter = wyślij, Shift+Enter = nowa linia.
  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // Auto-resize textarea do max 5 linii (~120px).
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  }

  // Wybór pliku przez przycisk — wielokrotny wybór dopuszczony.
  const handlePickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files
    if (!list || list.length === 0) return
    enqueueFiles(Array.from(list))
    // Reset, żeby ponowny wybór tego samego pliku też wyzwolił onChange.
    e.target.value = ''
  }

  const removePending = (id: string) => {
    setPendingFiles((prev) => {
      const found = prev.find((p) => p.id === id)
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }

  // ---- Drag & drop ----
  // Liczymy enter/leave, żeby overlay nie migał przy enterze dziecka. Na drop
  // zerujemy licznik (bo leave dziecka nie poleci, gdy obsłużymy event tu).
  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setIsDragging(true)
  }
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragging(false)
  }
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setIsDragging(false)
    const list = e.dataTransfer?.files
    if (!list || list.length === 0) return
    enqueueFiles(Array.from(list))
  }

  // Grupowanie wiadomości w bloki (ten sam autor, < 5 min przerwa) + separator dni.
  type Render =
    | { kind: 'day'; key: string; label: string }
    | { kind: 'group'; key: string; senderId: string; messages: MessageRow[] }

  const rendered: Render[] = useMemo(() => {
    const out: Render[] = []
    let prevDay: string | null = null
    let curGroup: MessageRow[] | null = null
    let curSender: string | null = null
    let curLastTs = 0

    for (const m of messages) {
      const day = new Date(m.created_at).toDateString()
      if (day !== prevDay) {
        if (curGroup && curSender) {
          out.push({
            kind: 'group',
            key: 'g-' + curGroup[0].id,
            senderId: curSender,
            messages: curGroup,
          })
          curGroup = null
        }
        out.push({ kind: 'day', key: 'd-' + day, label: dayLabel(m.created_at) })
        prevDay = day
      }
      const ts = new Date(m.created_at).getTime() / 1000
      if (
        curGroup &&
        curSender === m.sender_id &&
        ts - curLastTs <= GROUPING_GAP_SEC
      ) {
        curGroup.push(m)
      } else {
        if (curGroup && curSender) {
          out.push({
            kind: 'group',
            key: 'g-' + curGroup[0].id,
            senderId: curSender,
            messages: curGroup,
          })
        }
        curGroup = [m]
        curSender = m.sender_id
      }
      curLastTs = ts
    }
    if (curGroup && curSender) {
      out.push({
        kind: 'group',
        key: 'g-' + curGroup[0].id,
        senderId: curSender,
        messages: curGroup,
      })
    }
    return out
  }, [messages])

  const lastOwnReadAt = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.sender_id === currentUserId && m.read_at) return m.read_at
    }
    return null
  }, [messages, currentUserId])

  return (
    <div
      className="relative flex h-full min-h-0 flex-1 flex-col"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <Link
          href="/dashboard/chat"
          className="rounded-md p-1 text-slate-600 hover:bg-slate-100 lg:hidden"
          aria-label="Wróć do listy"
        >
          ←
        </Link>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700"
          aria-hidden
        >
          {initials(otherName) || '?'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            {otherName}
          </p>
        </div>
      </header>

      <div
        ref={scrollerRef}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-slate-50 px-3 py-4 sm:px-6"
      >
        {messages.length === 0 ? (
          <div className="m-auto flex max-w-xs flex-col items-center gap-2 text-center text-sm text-slate-500">
            <span className="text-3xl" aria-hidden>
              ✉️
            </span>
            <p>Brak wiadomości. Napisz pierwszą poniżej.</p>
          </div>
        ) : (
          rendered.map((node) =>
            node.kind === 'day' ? (
              <div
                key={node.key}
                className="my-2 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-400"
              >
                <span className="h-px flex-1 bg-slate-200" />
                {/* Daty zależne od ICU (Node vs browser) → tłumimy mismatch. */}
                <span suppressHydrationWarning>{node.label}</span>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
            ) : (
              <MessageGroup
                key={node.key}
                group={node.messages}
                mine={node.senderId === currentUserId}
                signedUrls={signedUrls}
                onZoomImage={(src, name) => setImageZoom({ src, name })}
                showReadAfter={lastOwnReadAt}
              />
            ),
          )
        )}
      </div>

      {/* Stos błędów (toast) — pojawiają się nad inputem, samoczynnie znikają. */}
      {errors.length > 0 ? (
        <div className="shrink-0 border-t border-red-200 bg-red-50 px-3 py-2">
          <ul className="space-y-1 text-sm text-red-800">
            {errors.map((err) => (
              <li key={err.id} className="flex items-start gap-2">
                <span aria-hidden>⚠️</span>
                <span className="flex-1">{err.text}</span>
                <button
                  type="button"
                  onClick={() =>
                    setErrors((prev) => prev.filter((x) => x.id !== err.id))
                  }
                  className="text-red-600 hover:text-red-900"
                  aria-label="Zamknij komunikat"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        onSubmit={handleSend}
        className="shrink-0 border-t border-slate-200 bg-white px-3 py-3"
      >
        {pendingFiles.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-2">
            {pendingFiles.map((p) => {
              const isUploading = uploadingId === p.id
              return (
                <li
                  key={p.id}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs ${
                    isUploading
                      ? 'border-indigo-200 bg-indigo-50 text-indigo-900'
                      : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  {p.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.previewUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <span
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-white text-lg ring-1 ring-slate-200"
                      aria-hidden
                    >
                      📄
                    </span>
                  )}
                  <span className="flex max-w-[180px] min-w-0 flex-col">
                    <span className="truncate font-medium">{p.file.name}</span>
                    <span className="text-[11px] text-slate-500">
                      {isUploading ? (
                        <span className="inline-flex items-center gap-1">
                          <span
                            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600"
                            aria-hidden
                          />
                          Wysyłam…
                        </span>
                      ) : (
                        formatBytes(p.file.size)
                      )}
                    </span>
                  </span>
                  {!isUploading ? (
                    <button
                      type="button"
                      onClick={() => removePending(p.id)}
                      disabled={sending}
                      className="rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-red-600 disabled:opacity-40"
                      aria-label={`Usuń ${p.file.name}`}
                    >
                      ✕
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
            multiple
            onChange={handlePickFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            aria-label="Załącz plik"
            title="Załącz plik (obraz lub PDF, max 10 MB) — można też przeciągnąć"
          >
            📎
          </button>
          <textarea
            ref={textAreaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKey}
            placeholder={
              pendingFiles.length > 0
                ? 'Dodaj opis (opcjonalnie)…'
                : 'Napisz wiadomość…'
            }
            rows={1}
            disabled={sending}
            className="max-h-[120px] min-h-9 flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
          />
          <button
            type="submit"
            disabled={
              sending ||
              (input.trim().length === 0 && pendingFiles.length === 0)
            }
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {sending
              ? pendingFiles.length > 0
                ? 'Wysyłam…'
                : 'Wysyłam…'
              : 'Wyślij'}
          </button>
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Enter wysyła, Shift+Enter — nowa linia. Możesz też przeciągnąć pliki
          tutaj.
        </p>
      </form>

      {/* Overlay drag&drop — pokrywa cały panel czatu podczas przeciągania.
          pointer-events-none, żeby nie blokować eventów dragleave/drop. */}
      {isDragging ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-indigo-500/20 p-4">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-indigo-500 bg-white/90 px-8 py-6 text-indigo-700 shadow-lg">
            <span className="text-4xl" aria-hidden>
              📎
            </span>
            <p className="text-base font-semibold">Upuść pliki tutaj</p>
            <p className="text-xs text-indigo-600/80">
              Obrazy (JPG/PNG/WEBP/GIF) lub PDF, do 10 MB każdy
            </p>
          </div>
        </div>
      ) : null}

      {imageZoom ? (
        <div
          onClick={() => setImageZoom(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-label={`Podgląd: ${imageZoom.name}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageZoom.src}
            alt={imageZoom.name}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setImageZoom(null)}
            className="absolute right-4 top-4 rounded-full bg-white/90 p-2 text-slate-700 hover:bg-white"
            aria-label="Zamknij podgląd"
          >
            ✕
          </button>
        </div>
      ) : null}
    </div>
  )
}

function MessageGroup({
  group,
  mine,
  signedUrls,
  onZoomImage,
  showReadAfter,
}: {
  group: MessageRow[]
  mine: boolean
  signedUrls: Record<string, string>
  onZoomImage: (src: string, name: string) => void
  showReadAfter: string | null
}) {
  const last = group[group.length - 1]
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'} gap-1`}>
      {group.map((m, idx) => {
        const url = m.file_url ? signedUrls[m.file_url] ?? null : null
        const showStatus = mine && idx === group.length - 1
        const isLastReadStamp =
          mine && m.read_at && m.id === last.id && showReadAfter === m.read_at
        return (
          <div
            key={m.id}
            className={`flex max-w-[80%] flex-col ${mine ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`rounded-2xl px-3 py-2 text-sm shadow-sm ${
                mine
                  ? 'rounded-br-md bg-indigo-600 text-white'
                  : 'rounded-bl-md bg-white text-slate-900 ring-1 ring-slate-200'
              }`}
            >
              {m.file_url ? (
                isImage(m.file_type) ? (
                  url ? (
                    <button
                      type="button"
                      onClick={() => onZoomImage(url, m.file_name ?? 'obraz')}
                      className="block"
                    >
                      <img
                        src={url}
                        alt={m.file_name ?? ''}
                        className="max-h-64 max-w-full rounded-md"
                      />
                    </button>
                  ) : (
                    <p
                      className={
                        mine ? 'text-xs text-indigo-100' : 'text-xs text-slate-500'
                      }
                    >
                      Ładowanie obrazu…
                    </p>
                  )
                ) : isPdf(m.file_type) ? (
                  <a
                    href={url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${
                      mine
                        ? 'bg-indigo-500 hover:bg-indigo-400'
                        : 'bg-slate-100 hover:bg-slate-200'
                    }`}
                  >
                    <span className="text-lg" aria-hidden>
                      📄
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">
                        {m.file_name ?? 'Plik PDF'}
                      </span>
                      <span
                        className={`text-[11px] ${
                          mine ? 'text-indigo-100' : 'text-slate-500'
                        }`}
                      >
                        {formatBytes(m.file_size)} · otwórz w nowej karcie
                      </span>
                    </span>
                  </a>
                ) : (
                  <a
                    href={url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    📎 {m.file_name ?? 'plik'}
                  </a>
                )
              ) : null}
              {m.content ? (
                <p
                  className={`whitespace-pre-wrap break-words ${m.file_url ? 'mt-2' : ''}`}
                >
                  {m.content}
                </p>
              ) : null}
            </div>
            <div
              className={`mt-0.5 flex items-center gap-2 px-1 text-[11px] ${
                mine ? 'text-slate-500' : 'text-slate-400'
              }`}
            >
              {/* Godzina sformatowana przez Intl — może różnić się SSR vs CSR. */}
              <span suppressHydrationWarning>{timeLabel(m.created_at)}</span>
              {showStatus ? (
                isLastReadStamp ? (
                  <span suppressHydrationWarning>
                    Przeczytano {timeLabel(m.read_at!)}
                  </span>
                ) : (
                  <span>{m.read_at ? 'Przeczytano' : 'Wysłano'}</span>
                )
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
