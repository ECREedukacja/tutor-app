'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { updateProfile } from './actions'

type Profile = {
  first_name: string
  last_name: string
  phone: string | null
  address: string | null
  role: 'teacher' | 'student'
}

const MAX_ADDRESS = 200

export function ProfileForm({ initial, email }: { initial: Profile; email: string }) {
  const router = useRouter()
  const [firstName, setFirstName] = useState(initial.first_name)
  const [lastName, setLastName] = useState(initial.last_name)
  const [phone, setPhone] = useState(initial.phone ?? '')
  const [address, setAddress] = useState(initial.address ?? '')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [pending, startTransition] = useTransition()

  const isTeacher = initial.role === 'teacher'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    startTransition(async () => {
      try {
        await updateProfile({
          first_name: firstName,
          last_name: lastName,
          phone,
          address: isTeacher ? address : '',
        })
        setSuccess(true)
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Nie udało się zapisać.')
      }
    })
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200"
    >
      <h1 className="text-xl font-semibold text-slate-900">Mój profil</h1>
      <p className="mt-1 text-sm text-slate-600">
        {isTeacher
          ? 'Te dane widzą uczniowie powiązani z Tobą.'
          : 'Te dane widzą nauczyciele, z którymi jesteś powiązany.'}
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-900">Imię</span>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
            maxLength={80}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-900">Nazwisko</span>
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
            maxLength={80}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium text-slate-900">
            E-mail
            <span className="ml-2 text-xs font-normal text-slate-500">
              (niezmienialny)
            </span>
          </span>
          <input
            type="email"
            value={email}
            disabled
            className="w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium text-slate-900">
            Telefon
            <span className="ml-2 text-xs font-normal text-slate-500">
              (opcjonalnie)
            </span>
          </span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
            placeholder="np. 600 123 456"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </label>
        {isTeacher && (
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 flex items-baseline justify-between font-medium text-slate-900">
              <span>
                Adres miejsca lekcji stacjonarnych
                <span className="ml-2 text-xs font-normal text-slate-500">
                  (opcjonalnie)
                </span>
              </span>
              <span className="text-xs font-normal text-slate-400">
                {address.length}/{MAX_ADDRESS}
              </span>
            </span>
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value.slice(0, MAX_ADDRESS))}
              rows={2}
              maxLength={MAX_ADDRESS}
              placeholder="np. ul. Marszałkowska 1, 00-001 Warszawa"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <span className="mt-1 block text-xs text-slate-500">
              Jeśli wypełnisz, uczniowie będą mogli wybrać między lekcją online
              a stacjonarną w tym adresie.
            </span>
          </label>
        )}
      </div>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Zmiany zapisane.
        </p>
      )}

      <div className="mt-6 flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Zapisywanie…' : 'Zapisz zmiany'}
        </button>
      </div>
    </form>
  )
}
