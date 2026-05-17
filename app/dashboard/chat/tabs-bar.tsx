'use client'

import Link from 'next/link'
import type { MouseEvent } from 'react'
import { useTabs } from './tabs-provider'

// Poziomy pasek zakładek nad środkową kolumną — wzorowany na kartach
// przeglądarki. Klik środkowym przyciskiem myszy zamyka zakładkę.

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

export function TabsBar() {
  const { tabs, activeId, closeTab } = useTabs()

  if (tabs.length === 0) return null

  const onMiddleClick = (e: MouseEvent, id: string) => {
    if (e.button === 1) {
      e.preventDefault()
      closeTab(id)
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Otwarte konwersacje"
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-slate-200 bg-slate-100"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onMouseDown={(e) => onMiddleClick(e, tab.id)}
            className={`group relative flex shrink-0 items-center gap-1.5 border-r border-slate-200 pl-3 pr-1.5 transition ${
              isActive
                ? 'bg-white'
                : 'bg-slate-100 hover:bg-slate-200'
            }`}
          >
            {isActive ? (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-0.5 bg-indigo-600"
              />
            ) : null}
            <Link
              href={`/dashboard/chat/${tab.id}`}
              className="flex items-center gap-2 py-2 outline-none"
              title={tab.name}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  isActive
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-slate-300 text-slate-700'
                }`}
                aria-hidden
              >
                {initials(tab.name) || '?'}
              </span>
              <span
                className={`max-w-[140px] truncate text-sm ${
                  isActive
                    ? 'font-semibold text-slate-900'
                    : 'text-slate-700'
                }`}
              >
                {tab.name}
              </span>
            </Link>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                closeTab(tab.id)
              }}
              className="rounded p-1 text-slate-400 transition hover:bg-slate-200 hover:text-red-600 group-hover:text-slate-500"
              aria-label={`Zamknij zakładkę: ${tab.name}`}
              title="Zamknij (lub kliknij środkowym przyciskiem myszy)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-3.5 w-3.5"
              >
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 0 1 1.414 0L10 8.586l4.293-4.293a1 1 0 1 1 1.414 1.414L11.414 10l4.293 4.293a1 1 0 0 1-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 0 1-1.414-1.414L8.586 10 4.293 5.707a1 1 0 0 1 0-1.414Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        )
      })}
    </div>
  )
}
