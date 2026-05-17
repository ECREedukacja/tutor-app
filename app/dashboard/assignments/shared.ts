// Wspólne stałe i helpery dla modułu prac domowych — używane przez:
//   • teacher-list.tsx, student-list.tsx (lista)
//   • [id]/teacher-detail.tsx, [id]/student-detail.tsx (szczegóły)
//   • new/wizard.tsx (kreator)

export const STATUS_LABELS: Record<string, string> = {
  draft: 'Szkic',
  sent: 'Oczekuje',
  in_progress: 'W trakcie',
  submitted: 'Oddana',
  graded: 'Oceniona',
}

export const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  sent: 'bg-amber-100 text-amber-800',
  in_progress: 'bg-indigo-100 text-indigo-800',
  submitted: 'bg-blue-100 text-blue-800',
  graded: 'bg-emerald-100 text-emerald-800',
}

export const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'Łatwe',
  medium: 'Średnie',
  hard: 'Trudne',
  mixed: 'Mieszane',
}

export const TASK_TYPE_LABELS: Record<string, string> = {
  open: 'Zadanie otwarte',
  closed: 'Zadanie zamknięte',
  calculation: 'Obliczeniowe',
  proof: 'Dowód',
}

// Formattery deterministyczne — NIE używamy 'pl-PL' dateStyle, bo Node bez
// pełnego polskiego ICU dawał inny string niż przeglądarka i hydration mismatch
// powstawał w komponentach klienckich. Zamiast tego rozbijamy datę na cyfrowe
// części przez Intl.DateTimeFormat('en-GB' / numeric, …) — wszystkie środowiska
// zwracają te same cyfry — i sklejamy ręcznie do polskiego formatu.
//
// Strefa: Europe/Warsaw (zachowane oryginalne zachowanie — daty w tej samej TZ
// niezależnie od TZ użytkownika).

const tzPartsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

type DateParts = {
  day: string
  month: string
  year: string
  hour: string
  minute: string
}

function partsOf(iso: string): DateParts {
  const out: Partial<DateParts> = {}
  for (const p of tzPartsFmt.formatToParts(new Date(iso))) {
    if (p.type === 'day') out.day = p.value
    else if (p.type === 'month') out.month = p.value
    else if (p.type === 'year') out.year = p.value
    else if (p.type === 'hour') out.hour = p.value
    else if (p.type === 'minute') out.minute = p.value
  }
  return out as DateParts
}

export function formatDateTime(iso: string): string {
  const p = partsOf(iso)
  return `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}`
}

export function formatDate(iso: string): string {
  const p = partsOf(iso)
  return `${p.day}.${p.month}.${p.year}`
}
