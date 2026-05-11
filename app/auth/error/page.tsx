import Link from 'next/link'

type SearchParams = Promise<{ message?: string }>

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const { message } = await searchParams
  const errorMessage =
    message || 'Wystąpił błąd podczas weryfikacji adresu e-mail. Spróbuj ponownie.'

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
          <svg
            className="h-6 w-6 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m0 3.75h.008v.008H12v-.008zM12 3a9 9 0 100 18 9 9 0 000-18z"
            />
          </svg>
        </div>
        <h1 className="mt-4 text-center text-2xl font-semibold text-slate-900">
          Weryfikacja nieudana
        </h1>
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-700">
          {errorMessage}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Link
            href="/register"
            className="inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700"
          >
            Wróć do rejestracji
          </Link>
          <Link
            href="/login"
            className="inline-flex w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Przejdź do logowania
          </Link>
        </div>
      </div>
    </main>
  )
}
