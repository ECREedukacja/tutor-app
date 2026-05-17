'use client'

import { useMemo, useState } from 'react'
import { formatDateShort } from '@/lib/calendar'
import { formatBytes, isImage, isPdf, type FileItem } from '../shared'

type Filter = 'all' | 'images' | 'pdf'

export function FilesPanel({ files }: { files: FileItem[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [zoom, setZoom] = useState<{ src: string; name: string } | null>(null)

  const visible = useMemo(() => {
    if (filter === 'all') return files
    if (filter === 'images') return files.filter((f) => isImage(f.type))
    return files.filter((f) => isPdf(f.type))
  }, [files, filter])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 p-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Pliki w konwersacji
        </h2>
        <div
          role="radiogroup"
          aria-label="Filtr plików"
          className="mt-2 flex gap-1"
        >
          {(
            [
              { value: 'all', label: 'Wszystkie' },
              { value: 'images', label: 'Obrazy' },
              { value: 'pdf', label: 'PDF' },
            ] as { value: Filter; label: string }[]
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={filter === opt.value}
              onClick={() => setFilter(opt.value)}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition ${
                filter === opt.value
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-500">
          <span className="text-2xl" aria-hidden>
            📂
          </span>
          <p>Brak plików w tej konwersacji.</p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto p-2">
          {visible.map((f) => {
            const url = f.signed_url
            const icon = isImage(f.type) ? '🖼️' : isPdf(f.type) ? '📄' : '📎'

            const onClick = () => {
              if (!url) return
              if (isImage(f.type)) {
                setZoom({ src: url, name: f.name })
              } else {
                window.open(url, '_blank', 'noopener,noreferrer')
              }
            }

            return (
              <li key={f.message_id}>
                <button
                  type="button"
                  onClick={onClick}
                  disabled={!url}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="mt-0.5 text-lg" aria-hidden>
                    {icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900">
                      {f.name}
                    </span>
                    <span
                      className="mt-0.5 block text-[11px] text-slate-500"
                      // Data renderuje się w lokalnej TZ — SSR (Node UTC) i
                      // przeglądarka (np. Europe/Warsaw) mogą trafić w inny
                      // dzień blisko północy. Tłumimy mismatch.
                      suppressHydrationWarning
                    >
                      {formatBytes(f.size)} · {formatDateShort(new Date(f.created_at))}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {zoom ? (
        <div
          onClick={() => setZoom(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
        >
          <img
            src={zoom.src}
            alt={zoom.name}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setZoom(null)}
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
