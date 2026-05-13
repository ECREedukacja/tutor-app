'use client'

import { useEffect } from 'react'
import { HOURS_END, HOURS_START, LESSON_MINUTES } from '@/lib/calendar'

// ===== Opcje godzin =====

// Co 15 minut. Ograniczamy do startów, które zmieszczą 45-minutową lekcję
// w widocznym przedziale HOURS_START..HOURS_END.
export const TIME_OPTIONS = (() => {
  const opts: string[] = []
  const lastStartMin = HOURS_END * 60 - LESSON_MINUTES
  for (let h = HOURS_START; h <= HOURS_END; h++) {
    for (const m of [0, 15, 30, 45]) {
      const totalMin = h * 60 + m
      if (totalMin > lastStartMin) break
      opts.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
  }
  return opts
})()

export function toLocalDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function toLocalTimeInput(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function combineDateTimeLocal(dateStr: string, timeStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = timeStr.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm, 0, 0)
}

// ===== Modal shell =====

export function ModalShell({
  title,
  onClose,
  children,
  size = 'md',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  size?: 'md' | 'lg'
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const maxW = size === 'lg' ? 'max-w-lg' : 'max-w-md'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        className={`w-full ${maxW} max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl ring-1 ring-slate-200`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 transition hover:text-slate-600"
            aria-label="Zamknij"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
