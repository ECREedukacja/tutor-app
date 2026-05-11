'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const supabase = createClient()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oauthNote, setOauthNote] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (signInError) {
      setSubmitting(false)
      setError(signInError.message)
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  const oauthSoon = () => {
    setOauthNote('Wkrótce dostępne')
    setTimeout(() => setOauthNote(null), 2500)
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <Link
        href="/"
        className="mb-6 text-xl font-semibold tracking-tight text-slate-900 transition hover:text-indigo-600"
      >
        Tutor App
      </Link>
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-2xl font-semibold text-slate-900">Zaloguj się</h1>
        <p className="mt-1 text-sm text-slate-600">Wróć do swoich lekcji i materiałów.</p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <label className="block">
            <span className="block text-sm font-medium text-slate-700">E-mail</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-slate-700">Hasło</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
            />
          </label>

          <div className="text-right">
            <Link
              href="/forgot-password"
              className="text-sm text-indigo-600 hover:text-indigo-700"
            >
              Zapomniałeś hasła?
            </Link>
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Logowanie...' : 'Zaloguj się'}
          </button>
        </form>

        <div className="my-6 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          lub
          <span className="h-px flex-1 bg-slate-200" />
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={oauthSoon}
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Zaloguj się przez Google
          </button>
          <button
            type="button"
            onClick={oauthSoon}
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Zaloguj się przez Facebook
          </button>
          {oauthNote && (
            <p className="text-center text-xs text-slate-500">{oauthNote}</p>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-slate-600">
          Nie masz konta?{' '}
          <Link href="/register" className="font-medium text-indigo-600 hover:text-indigo-700">
            Zarejestruj się
          </Link>
        </p>
      </div>
    </main>
  )
}
