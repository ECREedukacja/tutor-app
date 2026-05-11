import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export default async function HomePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    redirect('/dashboard')
  }

  return (
    <main className="flex min-h-screen flex-col bg-slate-50">
      <header className="px-6 py-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <span className="text-lg font-semibold text-slate-900">Tutor App</span>
          <Link
            href="/login"
            className="text-sm font-medium text-slate-700 hover:text-slate-900"
          >
            Zaloguj się
          </Link>
        </div>
      </header>

      <section className="flex flex-1 items-center px-6">
        <div className="mx-auto grid max-w-5xl gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              Korepetycje w nowoczesnej formie
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">
              Platforma łącząca uczniów i nauczycieli w jednym miejscu — planowanie lekcji,
              chat z plikami, generator zadań AI oraz lekcje na żywo z interaktywną tablicą
              i rozmową głosową.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/register"
                className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-indigo-700"
              >
                Zarejestruj się
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                Zaloguj się
              </Link>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Feature title="Terminarz" desc="Planuj i zarządzaj lekcjami w jednym kalendarzu." />
            <Feature title="Chat z plikami" desc="Wymieniaj materiały i wiadomości na bieżąco." />
            <Feature title="Generator zadań AI" desc="Automatyczne ćwiczenia dopasowane do ucznia." />
            <Feature title="Lekcje na żywo" desc="Interaktywna tablica i rozmowa głosowa." />
          </div>
        </div>
      </section>

      <footer className="px-6 py-8 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} Tutor App
      </footer>
    </main>
  )
}

function Feature({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-xl bg-white p-5 ring-1 ring-slate-200">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-sm leading-6 text-slate-600">{desc}</p>
    </div>
  )
}
