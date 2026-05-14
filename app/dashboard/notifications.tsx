'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { markAllNotificationsRead, markNotificationRead } from './actions'

// Mapowanie typów powiadomień na ikonki (emoji).
const TYPE_ICONS: Record<string, string> = {
  request_received: '👤',
  request_accepted: '✅',
  request_rejected: '❌',
  lesson_proposal_received: '📅',
  lesson_proposal_accepted: '✅',
  lesson_proposal_rejected: '❌',
  lesson_proposal_cancelled: '🚫',
  lesson_cancelled: '🚫',
  lesson_scheduled: '📅',
  lesson_booked: '📅',
  lesson_rescheduled: '🔄',
  recurring_series_cancelled: '🚫',
  lesson_reminder: '⏰',
}

export type Notification = {
  id: string
  user_id: string
  type: string
  title: string
  body: string | null
  link: string | null
  read_at: string | null
  created_at: string
}

const DROPDOWN_LIMIT = 10
const FETCH_LIMIT = 30
const TOAST_DISMISS_MS = 5000

// Polski formatter relatywnego czasu — Intl.RelativeTimeFormat + ręczny wybór
// jednostki, żeby uniknąć "0 sekund temu" i mieć krótkie etykiety.
const relFmt = new Intl.RelativeTimeFormat('pl-PL', { numeric: 'auto' })

function relativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffSec = Math.round((then - now) / 1000) // ujemne dla przeszłości
  const abs = Math.abs(diffSec)
  if (abs < 60) return relFmt.format(Math.round(diffSec), 'second')
  if (abs < 3600) return relFmt.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return relFmt.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 7 * 86400) return relFmt.format(Math.round(diffSec / 86400), 'day')
  if (abs < 30 * 86400) return relFmt.format(Math.round(diffSec / (7 * 86400)), 'week')
  return relFmt.format(Math.round(diffSec / (30 * 86400)), 'month')
}

export function Notifications({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [items, setItems] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const [toasts, setToasts] = useState<Notification[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const initialLoadDoneRef = useRef(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // Polityki autoplay w przeglądarkach: dźwięk można odtworzyć dopiero po
  // pierwszej interakcji użytkownika ze stroną. Trzymamy flagę i odblokowujemy
  // <audio> krótkim play()+pause() przy pierwszym kliku/keydownie/dotknięciu.
  const [audioUnlocked, setAudioUnlocked] = useState(false)

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('notifications')
      .select(
        'id, user_id, type, title, body, link, read_at, created_at',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(FETCH_LIMIT)
    setItems((data ?? []) as Notification[])
    initialLoadDoneRef.current = true
  }, [supabase, userId])

  useEffect(() => {
    load()
  }, [load])

  // Realtime: nowe wpisy + zmiany (read_at). Filtr po user_id (RLS dodatkowo
  // pilnuje, że widzimy tylko swoje).
  useEffect(() => {
    const channel = supabase
      .channel(`notifications-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const n = payload.new as Notification
          setItems((prev) => [n, ...prev].slice(0, FETCH_LIMIT))
          // Toast + dźwięk tylko po pierwszym załadowaniu — nie wybuchamy
          // dźwiękami na "świeże" rekordy które po prostu już istniały.
          if (initialLoadDoneRef.current) {
            setToasts((prev) => [n, ...prev])
            const audio = audioRef.current
            if (audio) {
              audio.currentTime = 0
              const p = audio.play()
              if (p && typeof p.catch === 'function') {
                // Cicho ignorujemy — autoplay może być wciąż zablokowany
                // (np. zanim użytkownik zdążył w cokolwiek kliknąć). Pulse
                // ikonki w toaście służy jako wizualny fallback.
                p.catch(() => {})
              }
            }
          }
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const updated = payload.new as Notification
          setItems((prev) =>
            prev.map((n) => (n.id === updated.id ? updated : n)),
          )
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [supabase, userId])

  // Audio-unlock: po pierwszej interakcji odpalamy play()+pause(), żeby
  // kolejne play() z subskrypcji realtime przeszły bez błędu.
  useEffect(() => {
    if (audioUnlocked) return
    let active = true

    const tryUnlock = () => {
      const audio = audioRef.current
      if (!audio || !active) return
      audio.muted = true
      const p = audio.play()
      const finish = () => {
        if (!active) return
        audio.pause()
        audio.currentTime = 0
        audio.muted = false
        setAudioUnlocked(true)
      }
      if (p && typeof p.then === 'function') {
        p.then(finish).catch(() => {
          // Gest nie wystarczył — kolejna interakcja spróbuje ponownie.
          audio.muted = false
        })
      } else {
        finish()
      }
    }

    document.addEventListener('click', tryUnlock)
    document.addEventListener('keydown', tryUnlock)
    document.addEventListener('touchstart', tryUnlock)

    return () => {
      active = false
      document.removeEventListener('click', tryUnlock)
      document.removeEventListener('keydown', tryUnlock)
      document.removeEventListener('touchstart', tryUnlock)
    }
  }, [audioUnlocked])

  // Zamknij dropdown przy kliknięciu poza nim.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const unreadCount = items.filter((n) => !n.read_at).length
  const displayCount = unreadCount > 99 ? '99+' : String(unreadCount)
  const dropdownItems = items.slice(0, DROPDOWN_LIMIT)

  const handleClick = useCallback(
    async (n: Notification) => {
      // Optymistyczna aktualizacja — server action i tak zaktualizuje read_at.
      if (!n.read_at) {
        setItems((prev) =>
          prev.map((x) =>
            x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x,
          ),
        )
        try {
          await markNotificationRead(n.id)
        } catch {
          // jeśli zawiedzie, realtime UPDATE-em się i tak zsynchronizujemy
        }
      }
      setOpen(false)
      setToasts((prev) => prev.filter((t) => t.id !== n.id))
      if (n.link) router.push(n.link)
    },
    [router],
  )

  const handleMarkAll = useCallback(async () => {
    setItems((prev) =>
      prev.map((n) =>
        n.read_at ? n : { ...n, read_at: new Date().toISOString() },
      ),
    )
    try {
      await markAllNotificationsRead()
    } catch {
      // ignorujemy — realtime UPDATE-em się dosynchronizujemy
    }
  }, [])

  return (
    <>
      <div ref={wrapperRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Powiadomienia"
          className="relative rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-base text-slate-700 transition hover:bg-slate-50"
        >
          <span aria-hidden>🔔</span>
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white ring-2 ring-white">
              {displayCount}
            </span>
          )}
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl bg-white shadow-xl ring-1 ring-slate-200 sm:w-96"
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
              <p className="text-sm font-semibold text-slate-900">Powiadomienia</p>
              <button
                type="button"
                onClick={handleMarkAll}
                disabled={unreadCount === 0}
                className="text-xs font-medium text-indigo-600 transition hover:text-indigo-800 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                Oznacz wszystkie
              </button>
            </div>
            {dropdownItems.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                Brak powiadomień
              </p>
            ) : (
              <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
                {dropdownItems.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => handleClick(n)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50 ${
                        n.read_at ? 'bg-white' : 'bg-indigo-50'
                      }`}
                    >
                      <span className="text-lg leading-none" aria-hidden>
                        {TYPE_ICONS[n.type] ?? '🔔'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-slate-900">
                          {n.title}
                        </span>
                        {n.body && (
                          <span className="mt-0.5 block truncate text-xs text-slate-600">
                            {n.body}
                          </span>
                        )}
                        <span className="mt-1 block text-[11px] text-slate-400">
                          {relativeTime(n.created_at)}
                        </span>
                      </span>
                      {!n.read_at && (
                        <span
                          aria-hidden
                          className="mt-1 h-2 w-2 shrink-0 rounded-full bg-indigo-500"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Audio do dźwięku przy nowym powiadomieniu — preload metadanych. */}
      <audio
        ref={audioRef}
        src="/sounds/notification.wav"
        preload="auto"
        aria-hidden
      />

      {/* Toasty w prawym górnym rogu — układane od góry, ostatnie u dołu. */}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-end gap-2 px-4">
        {toasts.map((t) => (
          <ToastItem
            key={t.id}
            notification={t}
            onDismiss={() =>
              setToasts((prev) => prev.filter((x) => x.id !== t.id))
            }
            onClick={() => handleClick(t)}
          />
        ))}
      </div>
    </>
  )
}

function ToastItem({
  notification,
  onDismiss,
  onClick,
}: {
  notification: Notification
  onDismiss: () => void
  onClick: () => void
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, TOAST_DISMISS_MS)
    return () => clearTimeout(t)
  }, [onDismiss])

  return (
    <div
      role="status"
      className="pointer-events-auto w-full max-w-sm animate-[toast-in_0.25s_ease-out] rounded-xl bg-white shadow-lg ring-1 ring-slate-200"
    >
      <div className="flex items-start gap-3 p-3">
        <span
          className="inline-block animate-[notif-attention_0.9s_ease-in-out] text-xl leading-none"
          aria-hidden
        >
          {TYPE_ICONS[notification.type] ?? '🔔'}
        </span>
        <button
          type="button"
          onClick={onClick}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block text-sm font-semibold text-slate-900">
            {notification.title}
          </span>
          {notification.body && (
            <span className="mt-0.5 block text-xs text-slate-600">
              {notification.body}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Zamknij"
          className="text-slate-400 transition hover:text-slate-600"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
