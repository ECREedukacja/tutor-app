'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DAY_NAMES_SHORT,
  HOURS_END,
  HOURS_START,
  SLOTS_PER_DAY,
  SLOT_MINUTES,
  addDays,
  addMinutes,
  dayIndexInWeek,
  formatTime,
  gridRowFor,
  isSameDay,
} from '@/lib/calendar'

export type CalendarBlock = {
  id: string
  dayIdx: number
  slotIdx: number
  spanSlots: number
  className: string
  content: React.ReactNode
  onClick?: () => void
}

type Props = {
  weekStart: Date
  blocks: CalendarBlock[]
  onEmptyClick?: (date: Date) => void
}

const ROW_HEIGHT_PX = 14 // 1 slot = 15 min. 60 slotów * 14px ≈ 840px wysokości

export function WeekCalendar({ weekStart, blocks, onEmptyClick }: Props) {
  const [now, setNow] = useState<Date | null>(null)

  // Aktualną godzinę renderujemy tylko po stronie klienta, żeby uniknąć
  // hydration mismatch (SSR vs CSR dają różne wartości).
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  )

  // Sloty zajęte przez bloki — pomijamy ich tła, żeby nie podwajać klikalności.
  const occupied = useMemo(() => {
    const s = new Set<string>()
    for (const b of blocks) {
      for (let i = 0; i < b.spanSlots; i++) {
        s.add(`${b.dayIdx}-${b.slotIdx + i}`)
      }
    }
    return s
  }, [blocks])

  return (
    <>
      {/* Widok desktopowy: siatka tygodniowa */}
      <DesktopGrid
        days={days}
        blocks={blocks}
        occupied={occupied}
        now={now}
        weekStart={weekStart}
        onEmptyClick={onEmptyClick}
      />
      {/* Widok mobilny: dni jeden pod drugim */}
      <MobileList
        days={days}
        blocks={blocks}
        weekStart={weekStart}
        onEmptyClick={onEmptyClick}
      />
    </>
  )
}

// ---------------- Desktop ----------------

function DesktopGrid({
  days,
  blocks,
  occupied,
  now,
  weekStart,
  onEmptyClick,
}: {
  days: Date[]
  blocks: CalendarBlock[]
  occupied: Set<string>
  now: Date | null
  weekStart: Date
  onEmptyClick?: (date: Date) => void
}) {
  const todayIdx = now
    ? dayIndexInWeek(new Date(now.getFullYear(), now.getMonth(), now.getDate()), weekStart)
    : null
  const nowRow = now ? gridRowFor(now) : null

  // Offset (w ułamku wiersza) w obrębie 15-min slotu — używamy do dokładnego
  // pozycjonowania linii "teraz".
  const nowOffsetFraction = now
    ? ((now.getMinutes() % SLOT_MINUTES) + now.getSeconds() / 60) / SLOT_MINUTES
    : 0

  const scrollerRef = useRef<HTMLDivElement | null>(null)

  return (
    <div className="hidden md:block">
      {/* Nagłówek dni */}
      <div
        className="grid border-b border-slate-200 bg-white"
        style={{ gridTemplateColumns: '60px repeat(7, minmax(0, 1fr))' }}
      >
        <div className="border-r border-slate-100" />
        {days.map((d, i) => {
          const isToday = now ? isSameDay(d, now) : false
          return (
            <div
              key={i}
              className={`border-r border-slate-100 px-2 py-3 text-center text-sm ${
                isToday
                  ? 'bg-indigo-50 font-semibold text-indigo-900'
                  : 'text-slate-700'
              }`}
            >
              <div className="text-xs uppercase tracking-wide">
                {DAY_NAMES_SHORT[i]}
              </div>
              <div className="mt-0.5 text-base font-medium">
                {d.getDate()}.
                {String(d.getMonth() + 1).padStart(2, '0')}
              </div>
            </div>
          )
        })}
      </div>

      {/* Siatka godzinowa */}
      <div
        ref={scrollerRef}
        className="max-h-[calc(100vh-280px)] overflow-y-auto bg-white"
      >
        <div
          className="relative grid"
          style={{
            gridTemplateColumns: '60px repeat(7, minmax(0, 1fr))',
            gridTemplateRows: `repeat(${SLOTS_PER_DAY}, ${ROW_HEIGHT_PX * 2}px)`,
          }}
        >
          {/* Etykiety godzin w lewej kolumnie */}
          {Array.from({ length: HOURS_END - HOURS_START + 1 }, (_, i) => {
            const hour = HOURS_START + i
            const rowStart = i * 4 + 1
            return (
              <div
                key={hour}
                className="border-r border-slate-100 pr-2 pt-1 text-right text-[11px] font-medium text-slate-400"
                style={{
                  gridColumn: 1,
                  gridRowStart: rowStart,
                  gridRowEnd: rowStart + 1,
                }}
              >
                {hour}:00
              </div>
            )
          })}

          {/* Tło "dnia dzisiejszego" — kolumna podświetlona na delikatny indygo */}
          {todayIdx !== null && (
            <div
              className="pointer-events-none bg-indigo-50/40"
              style={{
                gridColumn: todayIdx + 2,
                gridRowStart: 1,
                gridRowEnd: SLOTS_PER_DAY + 1,
              }}
            />
          )}

          {/* Klikalne puste sloty */}
          {days.map((day, dayIdx) =>
            Array.from({ length: SLOTS_PER_DAY }, (_, slotIdx) => {
              if (occupied.has(`${dayIdx}-${slotIdx}`)) return null
              const minutes = HOURS_START * 60 + slotIdx * SLOT_MINUTES
              const slotDate = new Date(day)
              slotDate.setHours(0, 0, 0, 0)
              slotDate.setMinutes(minutes)
              const isHourMark = slotIdx % 4 === 0
              return (
                <button
                  key={`${dayIdx}-${slotIdx}`}
                  type="button"
                  onClick={() => onEmptyClick?.(slotDate)}
                  className={`border-r border-slate-100 transition hover:bg-indigo-100/60 ${
                    isHourMark ? 'border-t border-t-slate-100' : ''
                  }`}
                  style={{
                    gridColumn: dayIdx + 2,
                    gridRowStart: slotIdx + 1,
                    gridRowEnd: slotIdx + 2,
                  }}
                  aria-label={`Dodaj termin ${formatTime(slotDate)}`}
                />
              )
            }),
          )}

          {/* Bloki (sloty/lekcje) */}
          {blocks.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={b.onClick}
              className={`m-0.5 overflow-hidden rounded-md border-l-4 px-1.5 py-1 text-left text-xs transition hover:brightness-95 ${b.className}`}
              style={{
                gridColumn: b.dayIdx + 2,
                gridRowStart: b.slotIdx + 1,
                gridRowEnd: b.slotIdx + 1 + b.spanSlots,
              }}
            >
              {b.content}
            </button>
          ))}

          {/* Linia "teraz" */}
          {todayIdx !== null && nowRow !== null && (
            <div
              className="pointer-events-none relative"
              style={{
                gridColumn: todayIdx + 2,
                gridRowStart: nowRow,
                gridRowEnd: nowRow + 1,
              }}
            >
              <div
                className="absolute left-0 right-0 z-10 flex items-center"
                style={{ top: `${nowOffsetFraction * 100}%` }}
              >
                <div className="h-2 w-2 -translate-x-1/2 rounded-full bg-red-500" />
                <div className="h-0.5 flex-1 bg-red-500" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------- Mobile ----------------

function MobileList({
  days,
  blocks,
  weekStart,
  onEmptyClick,
}: {
  days: Date[]
  blocks: CalendarBlock[]
  weekStart: Date
  onEmptyClick?: (date: Date) => void
}) {
  void weekStart // unused — bloki mają już dayIdx

  const blocksByDay = useMemo(() => {
    const map = new Map<number, CalendarBlock[]>()
    for (const b of blocks) {
      const arr = map.get(b.dayIdx) ?? []
      arr.push(b)
      map.set(b.dayIdx, arr)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.slotIdx - b.slotIdx)
    }
    return map
  }, [blocks])

  return (
    <div className="space-y-3 md:hidden">
      {days.map((day, dayIdx) => {
        const today = isSameDay(day, new Date())
        const dayBlocks = blocksByDay.get(dayIdx) ?? []
        return (
          <div
            key={dayIdx}
            className={`rounded-xl border bg-white p-4 ${
              today ? 'border-indigo-300 ring-1 ring-indigo-200' : 'border-slate-200'
            }`}
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  {DAY_NAMES_SHORT[dayIdx]}
                </p>
                <p className="text-sm font-semibold text-slate-900">
                  {day.getDate()}.{String(day.getMonth() + 1).padStart(2, '0')}
                </p>
              </div>
              {onEmptyClick && (
                <button
                  type="button"
                  onClick={() => {
                    const d = new Date(day)
                    d.setHours(HOURS_START, 0, 0, 0)
                    onEmptyClick(d)
                  }}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  + Dodaj
                </button>
              )}
            </div>
            <div className="mt-3 space-y-2">
              {dayBlocks.length === 0 ? (
                <p className="text-xs text-slate-500">Brak wpisów</p>
              ) : (
                dayBlocks.map((b) => {
                  const startMin = HOURS_START * 60 + b.slotIdx * SLOT_MINUTES
                  const start = new Date(day)
                  start.setHours(0, 0, 0, 0)
                  start.setMinutes(startMin)
                  const end = addMinutes(start, b.spanSlots * SLOT_MINUTES)
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={b.onClick}
                      className={`flex w-full items-center gap-3 rounded-lg border-l-4 px-3 py-2 text-left text-sm transition hover:brightness-95 ${b.className}`}
                    >
                      <span className="font-medium tabular-nums">
                        {formatTime(start)}–{formatTime(end)}
                      </span>
                      <span className="flex-1 truncate">{b.content}</span>
                    </button>
                  )
                })
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
