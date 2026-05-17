'use client'

import { useEffect, useRef, useState } from 'react'

// Hybrydowy edytor blokowy: tekst i wzór matematyczny jako oddzielne bloki.
// Wzory edytuje webcomponent <math-field> z MathLive (WYSIWYG — użytkownik
// widzi sformatowany wzór, nie kod LaTeX).
//
// FORMAT ZAPISU
// =============
// Zachowujemy istniejący format markdown + LaTeX (np. „Odpowiedź: $x=5$").
// Dzięki temu:
//   • istniejące dane w bazie renderują się jak dotychczas (przez MathContent)
//   • nie ma potrzeby migracji
//   • komponent renderujący (MathContent + KaTeX) pozostaje bez zmian
//
// Bloki są PARSOWANE z istniejącego stringa przy mount-ie i SERIALIZOWANE
// z powrotem przy każdej zmianie.
//
// SSR / Next.js App Router
// ========================
// MathLive używa custom elements (Web Components) — niedostępnych w Node.
// Dlatego:
//   • komponent jest `'use client'`
//   • bibliotekę ładujemy dynamicznie w useEffect
//   • przed załadowaniem renderujemy zwykłą textareę (SSR fallback)

// ----------------------------------------------------------------------------
// TypeScript: deklaracja JSX dla custom-elementu <math-field> siedzi w
// components/math-field.d.ts — eslint nie pozwala na `namespace` w .tsx,
// ale w .d.ts już tak.
// ----------------------------------------------------------------------------

// ----------------------------------------------------------------------------
// Model danych: blok tekstu lub blok wzoru.
// ----------------------------------------------------------------------------

type Block =
  | { kind: 'text'; value: string; id: string }
  | { kind: 'math'; value: string; id: string }

let blockIdSeq = 0
function nextId(): string {
  blockIdSeq += 1
  return `b-${blockIdSeq}`
}

// Parsuje markdown z `$...$` (inline) i `$$...$$` (blok) na bloki.
// Tekst pomiędzy dolarami trafia do bloku 'text'. Tekst wewnątrz dolarów to
// blok 'math'. Niedomknięte $ — całość jako tekst.
function parseToBlocks(value: string): Block[] {
  const v = value ?? ''
  const blocks: Block[] = []
  let textStart = 0
  let i = 0

  while (i < v.length) {
    if (v[i] === '$') {
      const isBlockMath = v[i + 1] === '$'
      const delim = isBlockMath ? '$$' : '$'
      const mathStart = i + delim.length
      const mathEnd = v.indexOf(delim, mathStart)
      if (mathEnd === -1) break // brak zamykającego — reszta jako tekst

      if (i > textStart) {
        blocks.push({ kind: 'text', value: v.slice(textStart, i), id: nextId() })
      }
      blocks.push({
        kind: 'math',
        value: v.slice(mathStart, mathEnd),
        id: nextId(),
      })
      i = mathEnd + delim.length
      textStart = i
    } else {
      i += 1
    }
  }

  if (textStart < v.length) {
    blocks.push({ kind: 'text', value: v.slice(textStart), id: nextId() })
  }
  if (blocks.length === 0) {
    blocks.push({ kind: 'text', value: '', id: nextId() })
  }
  return blocks
}

function serializeBlocks(blocks: Block[]): string {
  return blocks
    .map((b) => (b.kind === 'text' ? b.value : `$${b.value}$`))
    .join('')
}

// ----------------------------------------------------------------------------
// Główny komponent
// ----------------------------------------------------------------------------

export function MathEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  onBlur?: () => void
  placeholder?: string
  disabled?: boolean
}) {
  const [mounted, setMounted] = useState(false)
  const [blocks, setBlocks] = useState<Block[]>(() => parseToBlocks(value))
  // Ostatnia wartość, którą wyemitowaliśmy do rodzica. Pozwala odróżnić
  // zewnętrzną zmianę value (np. pre-fill z AI) od własnej.
  const lastSerializedRef = useRef<string>(value ?? '')

  // Dynamiczny import MathLive po stronie klienta — webcomponent rejestruje
  // się przy imporcie. SSR i pierwszy hydration render zostają z textareą.
  useEffect(() => {
    let cancelled = false
    import('mathlive')
      .then(() => {
        if (!cancelled) setMounted(true)
      })
      .catch((err) => {
        // Awaryjnie: zostaw textareę (mounted=false) i zaloguj.
        console.error('[math-editor] Nie udało się załadować MathLive:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Re-parsowanie przy zewnętrznej zmianie value (np. AI wypełnił sugestię).
  useEffect(() => {
    if ((value ?? '') !== lastSerializedRef.current) {
      setBlocks(parseToBlocks(value ?? ''))
      lastSerializedRef.current = value ?? ''
    }
  }, [value])

  function emit(next: Block[]) {
    const s = serializeBlocks(next)
    lastSerializedRef.current = s
    setBlocks(next)
    onChange(s)
  }

  function updateBlock(id: string, newValue: string) {
    emit(blocks.map((b) => (b.id === id ? { ...b, value: newValue } : b)))
  }

  function addBlock(kind: 'text' | 'math') {
    emit([...blocks, { kind, value: '', id: nextId() }])
  }

  function removeBlock(id: string) {
    const filtered = blocks.filter((b) => b.id !== id)
    // Pusty edytor nie ma sensu — zostaw co najmniej jeden blok tekstowy.
    if (filtered.length === 0) {
      filtered.push({ kind: 'text', value: '', id: nextId() })
    }
    emit(filtered)
  }

  // SSR / pre-hydration / błąd ładowania MathLive: textarea z surowym LaTeX-em.
  if (!mounted) {
    return (
      <textarea
        value={value}
        onChange={(e) => {
          lastSerializedRef.current = e.target.value
          onChange(e.target.value)
        }}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        rows={3}
        className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
      />
    )
  }

  return (
    <div
      className={`rounded-lg border border-slate-300 p-2 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 ${
        disabled ? 'bg-slate-50' : 'bg-white'
      }`}
    >
      <div className="space-y-1.5">
        {blocks.map((block) => (
          <BlockRow
            key={block.id}
            block={block}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(v) => updateBlock(block.id, v)}
            onBlur={onBlur}
            onRemove={
              blocks.length > 1 ? () => removeBlock(block.id) : undefined
            }
          />
        ))}
      </div>
      {!disabled ? (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-slate-100 pt-2">
          <button
            type="button"
            onClick={() => addBlock('text')}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            + Akapit
          </button>
          <button
            type="button"
            onClick={() => addBlock('math')}
            className="rounded border border-indigo-300 bg-white px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
          >
            + Wzór
          </button>
        </div>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------------------
// Pojedynczy blok (tekst lub wzór) — wewnętrzny komponent.
// ----------------------------------------------------------------------------

function BlockRow({
  block,
  placeholder,
  disabled,
  onChange,
  onBlur,
  onRemove,
}: {
  block: Block
  placeholder?: string
  disabled?: boolean
  onChange: (next: string) => void
  onBlur?: () => void
  onRemove?: () => void
}) {
  // math-field wymaga imperatywnego ustawienia value — przez ref + useEffect,
  // bo React nie zarządza atrybutami custom elements w pełni.
  const mfRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (block.kind !== 'math') return
    const el = mfRef.current as (HTMLElement & { value?: string }) | null
    if (el && el.value !== block.value) {
      el.value = block.value
    }
  }, [block.kind, block.value])

  return (
    <div className="flex items-start gap-1.5">
      {block.kind === 'text' ? (
        <textarea
          value={block.value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder ?? 'Tekst…'}
          disabled={disabled}
          rows={Math.max(1, Math.min(6, block.value.split('\n').length))}
          className="flex-1 resize-y rounded border border-slate-200 bg-white px-2 py-1 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 disabled:bg-slate-50"
        />
      ) : (
        <div className="flex-1 rounded border border-indigo-200 bg-white p-1">
          <math-field
            ref={mfRef}
            onInput={(e) => {
              const target = e.currentTarget as HTMLElement & {
                value?: string
              }
              onChange(target.value ?? '')
            }}
            onBlur={onBlur}
            disabled={disabled || undefined}
            placeholder="Wzór…"
            // math-field korzysta z shadow DOM + zmiennych CSS; dla spójności
            // rozmiaru z resztą formularza ustawiamy font-size i wysokość
            // bezpośrednio.
            style={{
              display: 'block',
              width: '100%',
              minHeight: '2rem',
              fontSize: '1rem',
            }}
          />
        </div>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          title="Usuń blok"
          aria-label="Usuń blok"
          className="shrink-0 rounded p-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600"
        >
          ✕
        </button>
      ) : null}
    </div>
  )
}
