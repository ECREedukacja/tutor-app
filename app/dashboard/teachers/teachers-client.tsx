'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { searchTeachers, sendRequest } from '../actions'
import type { TeacherSearchResult } from '../types'

export function TeacherSearch() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TeacherSearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [target, setTarget] = useState<TeacherSearchResult | null>(null)

  const onSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    setSearchError(null)
    if (query.trim().length < 2) {
      setSearchError('Wpisz co najmniej 2 znaki.')
      return
    }
    setSearching(true)
    try {
      const res = await searchTeachers(query)
      setResults(res)
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Wystąpił błąd.')
      setResults(null)
    } finally {
      setSearching(false)
    }
  }

  return (
    <>
      <form onSubmit={onSearch} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Imię, nazwisko lub e-mail"
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
        />
        <button
          type="submit"
          disabled={searching}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {searching ? 'Szukam...' : 'Szukaj'}
        </button>
      </form>

      {searchError && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {searchError}
        </p>
      )}

      {results !== null && (
        <div className="mt-4">
          {results.length === 0 ? (
            <p className="text-sm text-slate-600">Brak wyników.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {results.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-col gap-2 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {t.first_name} {t.last_name}
                    </p>
                    <p className="text-xs text-slate-500">{t.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTarget(t)}
                    className="mt-1 self-start rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700"
                  >
                    Wyślij prośbę
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {target && (
        <SendRequestModal
          teacher={target}
          onClose={() => setTarget(null)}
          onSent={() => {
            setTarget(null)
            setResults(null)
            setQuery('')
            router.refresh()
          }}
        />
      )}
    </>
  )
}

function SendRequestModal({
  teacher,
  onClose,
  onSent,
}: {
  teacher: TeacherSearchResult
  onClose: () => void
  onSent: () => void
}) {
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        await sendRequest(teacher.id, message)
        setSuccess(true)
        setTimeout(onSent, 1500)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się wysłać prośby.')
      }
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-slate-900">
          Wyślij prośbę
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Do: <span className="font-medium text-slate-900">{teacher.first_name} {teacher.last_name}</span>
        </p>

        {success ? (
          <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Prośba została wysłana.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <label className="block">
              <span className="block text-sm font-medium text-slate-700">
                Wiadomość (opcjonalna)
              </span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={500}
                placeholder="Napisz parę słów o sobie i czego chciałbyś się uczyć..."
                className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
              />
            </label>

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
              >
                Anuluj
              </button>
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? 'Wysyłanie...' : 'Wyślij prośbę'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
