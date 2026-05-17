'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useState, useTransition } from 'react'
import { createClient } from '@/lib/supabase/client'
import { formatDateShort } from '@/lib/calendar'
import {
  fetchRelatedPeople,
  startConversation,
  type RelatedPerson,
} from './actions'
import type { ConversationSummary } from './shared'
import { previewLine } from './shared'
import { useTabs } from './tabs-provider'

// Lewa kolumna: lista konwersacji + powiązanych osób bez czatu (sekcja
// „Pozostali"). Wyszukiwarka filtruje obie sekcje w miejscu.
//
// Sortowanie:
//   • Konwersacje: po last_message_at malejąco (najświeższe na górze)
//   • Pozostali (powiązani bez czatu): alfabetycznie po nazwisku
//
// Realtime: subskrybujemy INSERT/UPDATE w messages — aktualizujemy podgląd,
// last_message_at i licznik unread (dla nie-aktywnej zakładki).
//
// Każdy klik konwersacji wywołuje openTab — pasek zakładek nad środkową
// kolumną widzi nowo otwartą rozmowę.

// Skrócony „relative" format do listy konwersacji (np. „5 min", „2 godz.",
// „wczoraj", „16 maj"). DETERMINISTYCZNY — nie używamy Intl.RelativeTimeFormat
// ani toLocaleDateString, żeby SSR/CSR dawały ten sam string. Mimo to wartość
// zmienia się z czasem, więc span renderujący wynik ma suppressHydrationWarning.

function relativeShort(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffSec = Math.round((now - then) / 1000) // dodatnie dla przeszłości
  if (diffSec < 60) return 'teraz'
  if (diffSec < 3600) {
    const m = Math.round(diffSec / 60)
    return `${m} min`
  }

  const that = new Date(iso)
  const today = new Date()
  const sameDay = that.toDateString() === today.toDateString()
  if (sameDay) {
    const h = Math.round(diffSec / 3600)
    return `${h} godz.`
  }

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (that.toDateString() === yesterday.toDateString()) return 'wczoraj'

  return formatDateShort(that)
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function ConversationList({
  userId,
  initial,
}: {
  userId: string
  initial: ConversationSummary[]
}) {
  const supabase = useMemo(() => createClient(), [])
  const pathname = usePathname()
  const router = useRouter()
  const { openTab } = useTabs()
  const [items, setItems] = useState<ConversationSummary[]>(initial)
  const [query, setQuery] = useState('')
  const [related, setRelated] = useState<RelatedPerson[]>([])
  const [startingId, setStartingId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  // Aktywna konwersacja z URL: /dashboard/chat/[id]
  const activeId = useMemo(() => {
    const m = pathname?.match(/^\/dashboard\/chat\/([^/]+)/)
    return m ? m[1] : null
  }, [pathname])

  // Wszyscy powiązani — używani do sekcji „Pozostali" (bez czatu). Cichy
  // fallback do [], gdy server action padnie.
  useEffect(() => {
    let cancelled = false
    fetchRelatedPeople()
      .then((list) => {
        if (!cancelled) setRelated(list)
      })
      .catch(() => {
        if (!cancelled) setRelated([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Realtime: nowe wiadomości — aktualizują podgląd i licznik unread.
  useEffect(() => {
    const channel = supabase
      .channel(`conv-list-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const m = payload.new as {
            conversation_id: string
            sender_id: string
            content: string | null
            file_name: string | null
            created_at: string
          }
          setItems((prev) => {
            const idx = prev.findIndex((c) => c.id === m.conversation_id)
            if (idx === -1) return prev
            const updated: ConversationSummary = {
              ...prev[idx],
              last_message_at: m.created_at,
              last_message_preview: previewLine({
                content: m.content,
                file_name: m.file_name,
              }),
              unread_count:
                m.sender_id === userId || activeId === m.conversation_id
                  ? prev[idx].unread_count
                  : prev[idx].unread_count + 1,
            }
            const next = [updated, ...prev.filter((_, i) => i !== idx)]
            return next
          })
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          const m = payload.new as {
            conversation_id: string
            sender_id: string
            read_at: string | null
          }
          if (m.sender_id !== userId && m.read_at) {
            setItems((prev) =>
              prev.map((c) =>
                c.id === m.conversation_id
                  ? {
                      ...c,
                      unread_count: Math.max(0, c.unread_count - 1),
                    }
                  : c,
              ),
            )
          }
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [supabase, userId, activeId])

  const q = query.trim().toLowerCase()

  // Konwersacje pasujące do query + zerowanie licznika aktywnej.
  const visibleConversations = useMemo(() => {
    const base = activeId
      ? items.map((c) => (c.id === activeId ? { ...c, unread_count: 0 } : c))
      : items
    if (!q) return base
    return base.filter((c) => c.other_name.toLowerCase().includes(q))
  }, [items, q, activeId])

  // Powiązane osoby BEZ konwersacji — sekcja „Pozostali". Filtr po query
  // (jeśli wpisano) + sort po nazwisku (locale 'pl', diakrytyki zachowane).
  const remainingPeople = useMemo(() => {
    const existingOtherIds = new Set(items.map((c) => c.other_id))
    const filtered = related.filter(
      (p) => !existingOtherIds.has(p.id) && (!q || p.name.toLowerCase().includes(q)),
    )
    return filtered.sort((a, b) =>
      a.lastName.localeCompare(b.lastName, 'pl', { sensitivity: 'base' }),
    )
  }, [related, items, q])

  const isSearching = q.length > 0
  const nothingFound =
    isSearching && visibleConversations.length === 0 && remainingPeople.length === 0
  const totallyEmpty =
    !isSearching && visibleConversations.length === 0 && remainingPeople.length === 0

  const onConversationClick = (id: string, name: string) => {
    openTab(id, name)
  }

  const onStart = (otherId: string) => {
    setStartError(null)
    setStartingId(otherId)
    startTransition(async () => {
      try {
        await startConversation(otherId)
      } catch (e) {
        // redirect() rzuca NEXT_REDIRECT — to nie błąd.
        if (
          e &&
          typeof e === 'object' &&
          'digest' in e &&
          typeof (e as { digest?: string }).digest === 'string' &&
          (e as { digest: string }).digest.startsWith('NEXT_REDIRECT')
        ) {
          return
        }
        setStartError(
          e instanceof Error ? e.message : 'Nie udało się otworzyć czatu.',
        )
        setStartingId(null)
      }
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 p-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Wiadomości
        </h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Szukaj rozmowy lub osoby…"
          className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
        />
      </div>

      {startError ? (
        <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {startError}
        </div>
      ) : null}

      {totallyEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-500">
          <span className="text-2xl" aria-hidden>
            💬
          </span>
          <p>Brak powiązanych osób.</p>
          <p className="text-xs">
            Dodaj nauczyciela / ucznia w sekcji powyżej, aby zacząć rozmawiać.
          </p>
        </div>
      ) : nothingFound ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-slate-500">
          <p>Brak wyników dla „{query}”.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {visibleConversations.length > 0 ? (
            <section>
              <ul>
                {visibleConversations.map((c) => {
                  const isActive = c.id === activeId
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/dashboard/chat/${c.id}`}
                        onClick={() => {
                          onConversationClick(c.id, c.other_name)
                          router.refresh()
                        }}
                        className={`flex items-start gap-3 border-b border-slate-100 px-3 py-3 transition ${
                          isActive
                            ? 'bg-indigo-50'
                            : 'bg-white hover:bg-slate-50'
                        }`}
                      >
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700"
                          aria-hidden
                        >
                          {initials(c.other_name) || '?'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-semibold text-slate-900">
                              {c.other_name}
                            </span>
                            <span
                              className="shrink-0 text-[11px] text-slate-400"
                              // Format daty zależy od ICU/locale dostępnego w
                              // środowisku — Node (SSR) i przeglądarka mogą
                              // dać różne stringi („16.05" vs „16 maj"). Ten
                              // sam tekst i tak renderujemy po hydratacji
                              // (klient zapisze swoją wersję), więc tłumimy
                              // ostrzeżenie tylko dla tego liścia.
                              suppressHydrationWarning
                            >
                              {relativeShort(c.last_message_at)}
                            </span>
                          </span>
                          <span className="mt-0.5 flex items-center justify-between gap-2">
                            <span
                              className={`truncate text-xs ${
                                c.unread_count > 0
                                  ? 'font-semibold text-slate-800'
                                  : 'text-slate-500'
                              }`}
                            >
                              {c.last_message_preview ?? 'Brak wiadomości'}
                            </span>
                            {c.unread_count > 0 ? (
                              <span className="ml-2 inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
                                {c.unread_count > 99 ? '99+' : c.unread_count}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}

          {remainingPeople.length > 0 ? (
            <section>
              <h3 className="bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Pozostali
              </h3>
              <ul>
                {remainingPeople.map((p) => {
                  const busy = startingId === p.id
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => onStart(p.id)}
                        disabled={busy}
                        className="flex w-full items-start gap-3 border-b border-slate-100 px-3 py-3 text-left transition hover:bg-slate-50 disabled:opacity-60"
                      >
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600"
                          aria-hidden
                        >
                          {initials(p.name) || '?'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-slate-900">
                            {p.name}
                          </span>
                          <span className="block text-xs text-slate-500">
                            {busy ? 'Otwieram…' : 'Rozpocznij konwersację'}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}
