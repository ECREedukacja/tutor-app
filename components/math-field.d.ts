// Augmentacja JSX dla custom-elementu <math-field> z MathLive.
//
// Trzymamy ją w osobnym pliku .d.ts (a nie w math-editor.tsx) z dwóch
// powodów:
//   1. `declare module 'react' { namespace JSX { ... } }` musi używać
//      składni `namespace`, której eslint `@typescript-eslint/no-namespace`
//      nie dopuszcza w plikach .ts/.tsx. Reguła z definicji dopuszcza
//      namespace w plikach .d.ts (allowDefinitionFiles=true), więc tu
//      jest właściwe miejsce.
//   2. To czysta deklaracja typów — nie generuje runtime'u.

import type React from 'react'

type MathFieldAttrs = React.HTMLAttributes<HTMLElement> & {
  ref?: React.Ref<HTMLElement>
  placeholder?: string
  disabled?: boolean
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'math-field': MathFieldAttrs
    }
  }
}
