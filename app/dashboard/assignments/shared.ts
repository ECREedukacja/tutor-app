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

const dateTimeFmt = new Intl.DateTimeFormat('pl-PL', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Europe/Warsaw',
})

const dateFmt = new Intl.DateTimeFormat('pl-PL', {
  dateStyle: 'short',
  timeZone: 'Europe/Warsaw',
})

export function formatDateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso))
}

export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso))
}
