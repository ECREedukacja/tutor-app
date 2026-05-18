'use client'

import { useCallback, useRef, useSyncExternalStore } from 'react'

// Hooki do czytania z session/localStorage BEZ setState w useEffect.
//
// Dlaczego useSyncExternalStore:
//   • setState wewnątrz useEffect (klasyczny pattern „read on mount") jest
//     flagowane przez react-hooks/set-state-in-effect w React 19.
//   • storage NIE jest dostępny na serwerze → SSR snapshot musi być stały.
//   • useSyncExternalStore z noop subscribe + memoized getSnapshot daje:
//       — SSR: getServerSnapshot() → wartość domyślna
//       — Client: getSnapshot() → odczyt ze storage (cached przez ref)
//     Bez setState, bez re-renderów po pierwszym renderze.
//
// Brak nasłuchu na 'storage' event — ten hook obsługuje TYLKO odczyt
// startowy + zapis przez setter. Inne karty nie synchronizują się w czasie
// rzeczywistym (świadoma decyzja — to nie jest cel tych hooków).

type Storage = 'session' | 'local'

function storageOf(kind: Storage): globalThis.Storage | null {
  if (typeof window === 'undefined') return null
  return kind === 'session' ? window.sessionStorage : window.localStorage
}

const noopSubscribe = () => () => {}

// ─── useStoredFlag: boolean reprezentowany jako '1' / '0' ───
export function useStoredFlag(
  key: string,
  defaultValue: boolean,
  storage: Storage = 'session',
): readonly [boolean, (next: boolean) => void] {
  // Cache snapshotu — useSyncExternalStore wymaga referencyjnej stabilności
  // dla typów referencyjnych. Dla boolean nie jest to konieczne, ale trzymamy
  // ref na wszelki wypadek (np. żeby setState w setter był poprawny natychmiast).
  const cacheRef = useRef<{ key: string; value: boolean } | null>(null)

  const getSnapshot = useCallback((): boolean => {
    if (cacheRef.current?.key === key) return cacheRef.current.value
    const s = storageOf(storage)
    if (!s) return defaultValue
    const raw = s.getItem(key)
    const value = raw === '1' ? true : raw === '0' ? false : defaultValue
    cacheRef.current = { key, value }
    return value
  }, [key, defaultValue, storage])

  const value = useSyncExternalStore(noopSubscribe, getSnapshot, () => defaultValue)

  const setValue = useCallback(
    (next: boolean) => {
      const s = storageOf(storage)
      if (s) {
        try {
          s.setItem(key, next ? '1' : '0')
        } catch {
          // Tryb prywatny / quota — ignorujemy, wartość w pamięci się odświeży
          // dopiero przy reload.
        }
      }
      cacheRef.current = { key, value: next }
    },
    [key, storage],
  )

  return [value, setValue] as const
}

// ─── useStoredJSON: dowolna JSON-serializowalna wartość ───
// Zwraca tuple [value, setValue]. Setter zapisuje stringified JSON.
export function useStoredJSON<T>(
  key: string,
  defaultValue: T,
  storage: Storage = 'local',
): readonly [T, (next: T) => void] {
  const cacheRef = useRef<{ key: string; value: T } | null>(null)

  const getSnapshot = useCallback((): T => {
    if (cacheRef.current?.key === key) return cacheRef.current.value
    const s = storageOf(storage)
    if (!s) return defaultValue
    const raw = s.getItem(key)
    let value: T = defaultValue
    if (raw !== null) {
      try {
        value = JSON.parse(raw) as T
      } catch {
        value = defaultValue
      }
    }
    cacheRef.current = { key, value }
    return value
  }, [key, defaultValue, storage])

  const value = useSyncExternalStore(noopSubscribe, getSnapshot, () => defaultValue)

  const setValue = useCallback(
    (next: T) => {
      const s = storageOf(storage)
      if (s) {
        try {
          s.setItem(key, JSON.stringify(next))
        } catch {}
      }
      cacheRef.current = { key, value: next }
    },
    [key, storage],
  )

  return [value, setValue] as const
}
