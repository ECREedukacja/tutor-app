'use client'

import { useEffect } from 'react'
import { useTabs } from '../tabs-provider'

// Po wejściu na /dashboard/chat/[id] rejestrujemy tę konwersację jako otwartą
// zakładkę. Idempotent — openTab tylko dopisuje (lub aktualizuje nazwę).
export function AutoTab({ id, name }: { id: string; name: string }) {
  const { openTab } = useTabs()
  useEffect(() => {
    openTab(id, name)
  }, [id, name, openTab])
  return null
}
