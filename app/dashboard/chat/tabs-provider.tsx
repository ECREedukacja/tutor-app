'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { usePathname, useRouter } from 'next/navigation'

// TabsProvider — stan otwartych zakładek czatu (jak karty w przeglądarce).
//
// Persystencja: sessionStorage (przeżywa odświeżenie strony w tej karcie, ale
// resetuje się przy nowej sesji / nowej karcie przeglądarki).
// Aktywna zakładka NIE jest zapisywana — pochodzi z URL (/dashboard/chat/[id]).
//
// Hydratacja: useState startuje pustą listą (żeby zgadzało się z SSR), a w
// useEffect dociągamy z sessionStorage i mergujemy z ewentualnymi zakładkami,
// które AutoTab zdążył już dodać (effecty dzieci odpalają się przed parentem).

export type Tab = { id: string; name: string }

type TabsContextValue = {
  tabs: Tab[]
  activeId: string | null
  openTab: (id: string, name: string) => void
  closeTab: (id: string) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)
const STORAGE_KEY = 'chat-tabs-v1'

function readStored(): Tab[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is Tab =>
        t != null &&
        typeof t === 'object' &&
        typeof (t as Tab).id === 'string' &&
        typeof (t as Tab).name === 'string',
    )
  } catch {
    return []
  }
}

export function TabsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [tabs, setTabs] = useState<Tab[]>([])
  const hydratedRef = useRef(false)

  const activeId = useMemo(() => {
    const m = pathname?.match(/^\/dashboard\/chat\/([^/]+)/)
    return m ? m[1] : null
  }, [pathname])

  // Hydratacja z sessionStorage + merge z tym, co AutoTab zdążył dodać.
  useEffect(() => {
    const stored = readStored()
    setTabs((prev) => {
      if (stored.length === 0) {
        hydratedRef.current = true
        return prev
      }
      const ids = new Set(stored.map((t) => t.id))
      const merged = [...stored, ...prev.filter((t) => !ids.has(t.id))]
      hydratedRef.current = true
      return merged
    })
  }, [])

  // Persystencja po każdej zmianie (po hydratacji, żeby nie zapisać pustki).
  useEffect(() => {
    if (!hydratedRef.current) return
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs))
    } catch {}
  }, [tabs])

  const openTab = useCallback((id: string, name: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id)
      if (idx === -1) return [...prev, { id, name }]
      if (prev[idx].name === name) return prev
      const next = prev.slice()
      next[idx] = { id, name }
      return next
    })
  }, [])

  const closeTab = useCallback(
    (id: string) => {
      // Wszystko liczymy SYNCHRONICZNIE z bieżącego stanu (a nie z callbacka
      // setTabs), bo router.push wewnątrz setState'owego callbacka triggeruje
      // re-render Link/router'a podczas naszego re-renderu — błąd:
      // „Cannot update a component while rendering a different component".
      const idx = tabs.findIndex((t) => t.id === id)
      if (idx === -1) return
      const next = tabs.filter((t) => t.id !== id)

      let nextRoute: string | null = null
      if (id === activeId) {
        // Sąsiad: najpierw po lewej (idx-1), inaczej po prawej (teraz pod idx),
        // a jeśli nic nie zostało — placeholder /dashboard/chat.
        const neighbor = next[idx - 1] ?? next[idx] ?? null
        nextRoute = neighbor ? `/dashboard/chat/${neighbor.id}` : '/dashboard/chat'
      }

      setTabs(next)
      if (nextRoute) router.push(nextRoute)
    },
    [tabs, activeId, router],
  )

  const value = useMemo(
    () => ({ tabs, activeId, openTab, closeTab }),
    [tabs, activeId, openTab, closeTab],
  )

  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>
}

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('useTabs musi być wewnątrz TabsProvider.')
  return ctx
}
