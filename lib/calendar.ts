// Wspólne helpery kalendarza tygodniowego. Cała logika operuje na lokalnym
// czasie przeglądarki użytkownika — dane z bazy (timestamptz) konwertujemy
// przez new Date(iso), a do bazy wysyłamy iso z lokalnej daty.

export const HOURS_START = 6
export const HOURS_END = 21 // ostatnia rysowana godzina (label)
export const SLOT_MINUTES = 15
export const SLOTS_PER_DAY = ((HOURS_END - HOURS_START) * 60) / SLOT_MINUTES // 60
export const LESSON_MINUTES = 45
export const LESSON_SPAN = LESSON_MINUTES / SLOT_MINUTES // 3

export const DAY_NAMES_SHORT = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd']
export const DAY_NAMES_LONG = [
  'Poniedziałek',
  'Wtorek',
  'Środa',
  'Czwartek',
  'Piątek',
  'Sobota',
  'Niedziela',
]

// Poniedziałek 00:00:00 lokalnego tygodnia zawierającego datę d.
export function getWeekStart(d: Date): Date {
  const r = new Date(d)
  const dow = r.getDay() // 0=Nd, 1=Pn ... 6=Sb
  const diff = dow === 0 ? -6 : 1 - dow
  r.setDate(r.getDate() + diff)
  r.setHours(0, 0, 0, 0)
  return r
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000)
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

// Zaokrąglenie w dół do najbliższej 15-minutowej kratki.
export function quantize15(d: Date): Date {
  const r = new Date(d)
  r.setSeconds(0, 0)
  r.setMinutes(Math.floor(r.getMinutes() / SLOT_MINUTES) * SLOT_MINUTES)
  return r
}

// Indeks 15-minutowego slotu od początku doby (0..95). Używamy do mapowania
// na wiersz w gridzie kalendarza, pamiętając o offsetcie HOURS_START.
export function slotIndexInDay(d: Date): number {
  return (d.getHours() * 60 + d.getMinutes()) / SLOT_MINUTES
}

// Wiersz w gridzie kalendarza (1-based, w obrębie widocznych godzin).
// Zwraca null, gdy moment leży poza widocznymi godzinami.
export function gridRowFor(d: Date): number | null {
  const minutesFromStart = d.getHours() * 60 + d.getMinutes() - HOURS_START * 60
  if (minutesFromStart < 0) return null
  const row = Math.floor(minutesFromStart / SLOT_MINUTES) + 1
  if (row > SLOTS_PER_DAY) return null
  return row
}

// Kolumna w gridzie (1=poniedziałek tygodnia, 7=niedziela). Zwraca null,
// gdy data spoza tygodnia.
export function dayIndexInWeek(d: Date, weekStart: Date): number | null {
  const ms = d.getTime() - weekStart.getTime()
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days < 0 || days > 6) return null
  return days
}

// Formatery dat — DETERMINISTYCZNE, ręczne, niezależne od ICU/locale środowiska.
//
// Dlaczego ręcznie a nie Intl.DateTimeFormat('pl-PL', …)?
// Node (SSR) bez pełnej polskiej ICU dawał inne stringi niż przeglądarka
// (klient) — efekt: hydration mismatch w komponentach client. Ręczny format
// gwarantuje, że SSR i CSR generują dokładnie te same znaki.
//
// Daty czytamy w STREFIE LOKALNEJ użytkownika (getDate/getMonth/...) — taka
// była dotychczasowa semantyka kalendarza tygodniowego i zostawiamy ją.

const MONTHS_GENITIVE = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
]
const MONTHS_SHORT = [
  'sty', 'lut', 'mar', 'kwi', 'maj', 'cze',
  'lip', 'sie', 'wrz', 'paź', 'lis', 'gru',
]
// Intl pl-PL z weekday:'short' daje "pon.", "wt." itd.
const WEEKDAYS_SHORT = ['nd.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.']

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

export function formatDateLong(d: Date): string {
  return `${d.getDate()} ${MONTHS_GENITIVE[d.getMonth()]} ${d.getFullYear()}`
}
export function formatDateShort(d: Date): string {
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`
}
export function formatDateWithWeekday(d: Date): string {
  return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`
}
export function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

// "12 - 18 maja 2026" lub "27 kwi - 3 maja 2026" gdy tydzień łapie dwa miesiące.
export function formatWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6)
  const yEnd = end.getFullYear()
  const yStart = weekStart.getFullYear()
  if (yStart !== yEnd) {
    return `${formatDateLong(weekStart)} – ${formatDateLong(end)}`
  }
  if (weekStart.getMonth() === end.getMonth()) {
    return `${weekStart.getDate()} – ${formatDateLong(end)}`
  }
  return `${formatDateShort(weekStart)} – ${formatDateLong(end)}`
}

// Deterministyczna paleta kolorów dla nauczycieli (widok ucznia). Bazuje na
// hashu UUID i 6-kolorowej palecie spójnej stylistycznie z resztą UI.
//
// Każda pozycja ma dwa warianty z tej samej rodziny kolorystycznej:
//   • light  — używany dla wolnych terminów (availability). Pastelowe tło,
//              ciemny tekst, średnio nasycony border.
//   • strong — używany dla zapisanych lekcji (lessons). Mocne nasycone tło,
//              biały tekst.
// `dot` to mała kropka w chipach legendy (kolor strong, dla rozpoznawalności).
export type TeacherColorVariant = {
  bg: string
  border: string
  text: string
}

export type TeacherColor = {
  light: TeacherColorVariant
  strong: TeacherColorVariant
  dot: string
}

export const TEACHER_PALETTE: readonly TeacherColor[] = [
  {
    light:  { bg: 'bg-indigo-100',  border: 'border-indigo-300',  text: 'text-indigo-900'  },
    strong: { bg: 'bg-indigo-500',  border: 'border-indigo-600',  text: 'text-white'       },
    dot: 'bg-indigo-500',
  },
  {
    light:  { bg: 'bg-emerald-100', border: 'border-emerald-300', text: 'text-emerald-900' },
    strong: { bg: 'bg-emerald-500', border: 'border-emerald-600', text: 'text-white'       },
    dot: 'bg-emerald-500',
  },
  {
    light:  { bg: 'bg-amber-100',   border: 'border-amber-300',   text: 'text-amber-900'   },
    strong: { bg: 'bg-amber-500',   border: 'border-amber-600',   text: 'text-white'       },
    dot: 'bg-amber-500',
  },
  {
    light:  { bg: 'bg-rose-100',    border: 'border-rose-300',    text: 'text-rose-900'    },
    strong: { bg: 'bg-rose-500',    border: 'border-rose-600',    text: 'text-white'       },
    dot: 'bg-rose-500',
  },
  {
    light:  { bg: 'bg-sky-100',     border: 'border-sky-300',     text: 'text-sky-900'     },
    strong: { bg: 'bg-sky-500',     border: 'border-sky-600',     text: 'text-white'       },
    dot: 'bg-sky-500',
  },
  {
    light:  { bg: 'bg-violet-100',  border: 'border-violet-300',  text: 'text-violet-900'  },
    strong: { bg: 'bg-violet-500',  border: 'border-violet-600',  text: 'text-white'       },
    dot: 'bg-violet-500',
  },
] as const

export type LessonMode = 'online' | 'in_person'

export function modeIcon(mode: LessonMode): string {
  return mode === 'online' ? '💻' : '📍'
}

export function modeLabel(mode: LessonMode): string {
  return mode === 'online' ? 'Online' : 'Stacjonarnie'
}

export function teacherColor(teacherId: string): TeacherColor {
  // djb2 (Bernstein). Wcześniejsza wersja używała `hash * 31 + c` z `>>> 0`,
  // ale na 36-znakowych UUID-ach niskie bity haszu zlewały się — wynik mod 6
  // klastrował się na 2-3 koszykach (np. wszyscy nauczyciele wpadali na ten
  // sam kolor). djb2 z multiplerem 33 lepiej dyfunduje bity i daje równy
  // rozkład na palecie.
  let hash = 5381
  for (let i = 0; i < teacherId.length; i++) {
    hash = (((hash << 5) + hash) + teacherId.charCodeAt(i)) >>> 0
  }
  return TEACHER_PALETTE[hash % TEACHER_PALETTE.length]
}
