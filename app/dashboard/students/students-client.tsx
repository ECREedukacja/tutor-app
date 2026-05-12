'use client'

import { useTransition, useState } from 'react'
import { useRouter } from 'next/navigation'
import { respondToRequest } from '../actions'

export function RequestActions({ requestId }: { requestId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const respond = (accept: boolean) => {
    setError(null)
    startTransition(async () => {
      try {
        await respondToRequest(requestId, accept)
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Operacja nie powiodła się.')
      }
    })
  }

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => respond(true)}
          disabled={pending}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Akceptuj
        </button>
        <button
          type="button"
          onClick={() => respond(false)}
          disabled={pending}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Odrzuć
        </button>
      </div>
      {error && (
        <p className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p>
      )}
    </div>
  )
}
