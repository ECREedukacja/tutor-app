'use client'

import { addDays, formatWeekRange, getWeekStart } from '@/lib/calendar'

type Props = {
  weekStart: Date
  onChange: (next: Date) => void
}

export function WeekNav({ weekStart, onChange }: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold text-slate-900 sm:text-lg">
        {formatWeekRange(weekStart)}
      </h2>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(addDays(weekStart, -7))}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          aria-label="Poprzedni tydzień"
        >
          ←
        </button>
        <button
          type="button"
          onClick={() => onChange(getWeekStart(new Date()))}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          Dzisiaj
        </button>
        <button
          type="button"
          onClick={() => onChange(addDays(weekStart, 7))}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          aria-label="Następny tydzień"
        >
          →
        </button>
      </div>
    </div>
  )
}
