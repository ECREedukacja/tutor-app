'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Role = 'student' | 'teacher'

export default function RegisterPage() {
  const router = useRouter()
  const supabase = createClient()

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [role, setRole] = useState<Role>('student')

  const [error, setError] = useState<string | null>(null)
  const [oauthNote, setOauthNote] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (!success) return
    const t = setTimeout(() => router.push('/login'), 4000)
    return () => clearTimeout(t)
  }, [success, router])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Hasło musi mieć co najmniej 8 znaków.')
      return
    }
    if (password !== passwordConfirm) {
      setError('Hasła nie są identyczne.')
      return
    }

    setSubmitting(true)
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
          phone: phone || null,
          role,
        },
      },
    })
    setSubmitting(false)

    if (signUpError) {
      setError(signUpError.message)
      return
    }
    setSuccess(true)
  }

  const signUpWithGoogle = async () => {
    setError(null)
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (oauthError) {
      setError(oauthError.message)
    }
  }

  const oauthSoon = () => {
    setOauthNote('Wkrótce dostępne')
    setTimeout(() => setOauthNote(null), 2500)
  }

  if (success) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
        <Link
          href="/"
          className="mb-6 text-xl font-semibold tracking-tight text-slate-900 transition hover:text-indigo-600"
        >
          Tutor App
        </Link>
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
          <h1 className="text-2xl font-semibold text-slate-900">Sprawdź swoją skrzynkę</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Wysłaliśmy na adres <span className="font-medium text-slate-900">{email}</span> link
            weryfikacyjny. Kliknij go, aby aktywować konto. Za chwilę przeniesiemy Cię na stronę
            logowania.
          </p>
          <Link
            href="/login"
            className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
          >
            Przejdź do logowania
          </Link>
        </div>
      </main>
    )
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
        <h1 className="text-2xl font-semibold text-slate-900">Załóż konto</h1>
        <p className="mt-1 text-sm text-slate-600">Zacznij korzystać z platformy korepetycyjnej.</p>

        <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Imię"
              type="text"
              value={firstName}
              onChange={setFirstName}
              required
              autoComplete="given-name"
            />
            <Field
              label="Nazwisko"
              type="text"
              value={lastName}
              onChange={setLastName}
              required
              autoComplete="family-name"
            />
          </div>
          <Field
            label="E-mail"
            type="email"
            value={email}
            onChange={setEmail}
            required
            autoComplete="email"
          />
          <Field
            label="Telefon (opcjonalny)"
            type="tel"
            value={phone}
            onChange={setPhone}
            autoComplete="tel"
          />
          <Field
            label="Hasło"
            type="password"
            value={password}
            onChange={setPassword}
            required
            autoComplete="new-password"
            hint="Minimum 8 znaków."
          />
          <Field
            label="Powtórz hasło"
            type="password"
            value={passwordConfirm}
            onChange={setPasswordConfirm}
            required
            autoComplete="new-password"
          />

          <fieldset>
            <legend className="block text-sm font-medium text-slate-700">Rola</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(['student', 'teacher'] as const).map((r) => (
                <label
                  key={r}
                  className={`flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2 text-sm transition ${
                    role === r
                      ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    value={r}
                    checked={role === r}
                    onChange={() => setRole(r)}
                    className="sr-only"
                  />
                  {r === 'student' ? 'Uczeń' : 'Nauczyciel'}
                </label>
              ))}
            </div>
          </fieldset>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Rejestrowanie...' : 'Zarejestruj się'}
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
            onClick={signUpWithGoogle}
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Zarejestruj się przez Google
          </button>
          <button
            type="button"
            onClick={oauthSoon}
            className="w-full rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Zarejestruj się przez Facebook
          </button>
          {oauthNote && (
            <p className="text-center text-xs text-slate-500">{oauthNote}</p>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-slate-600">
          Masz już konto?{' '}
          <Link href="/login" className="font-medium text-indigo-600 hover:text-indigo-700">
            Zaloguj się
          </Link>
        </p>
      </div>
    </main>
  )
}

function Field({
  label,
  hint,
  value,
  onChange,
  ...rest
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-700">{label}</span>
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-600/20"
      />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}
