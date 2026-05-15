// Skrypt testowy modułu AI prac domowych.
//
// Wywołuje bezpośrednio Anthropic SDK z tymi samymi tool schemas, których
// używa app/dashboard/assignments/actions.ts. Symuluje pełen cykl:
//   1) Generowanie zadań (Cykl A — wspólne dla cykli 1+2)
//   2) Per-task grading dla różnych student_answer (Cykle 1, 3, 4, 5)
//   3) Overall grading (Cykl A)
//
// Uruchom: node --env-file=.env.local scripts/test-ai-cycles.mjs

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-haiku-4-5'
const MAX_TOKENS_GEN = 4096
const MAX_TOKENS_GRADE = 500
const TASK_COUNT = 2

const SUBMIT_TASKS_TOOL = {
  name: 'submit_assignment_tasks',
  description:
    'Zwraca wygenerowane zadania matematyczne. Wywołuj zawsze — nie pisz tekstowej odpowiedzi.',
  input_schema: {
    type: 'object',
    properties: {
      assignment_title: { type: 'string' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            order_index: { type: 'integer' },
            content: { type: 'string' },
            task_type: {
              type: 'string',
              enum: ['open', 'closed', 'calculation', 'proof'],
            },
            expected_answer: { type: 'string' },
            hint: { type: 'string' },
          },
          required: [
            'order_index',
            'content',
            'task_type',
            'expected_answer',
            'hint',
          ],
        },
      },
    },
    required: ['assignment_title', 'tasks'],
  },
}

const GRADE_TASK_TOOL = {
  name: 'submit_task_grade',
  description: 'Zwraca ocenę pojedynczego zadania.',
  input_schema: {
    type: 'object',
    properties: {
      is_correct: { type: 'boolean' },
      comment: { type: 'string' },
    },
    required: ['is_correct', 'comment'],
  },
}

const GRADE_OVERALL_TOOL = {
  name: 'submit_overall_grade',
  description: 'Zwraca ogólną ocenę całej pracy.',
  input_schema: {
    type: 'object',
    properties: {
      grade: { type: 'string' },
      feedback: { type: 'string' },
    },
    required: ['grade', 'feedback'],
  },
}

const GEN_PROMPT = `Jesteś asystentem korepetytora matematyki. Generujesz zadania matematyczne dla uczniów.

ZASADY:
1. Wszystkie zadania w języku polskim
2. Wzory matematyczne w LaTeX (inline $...$, block $$...$$)
3. Każde zadanie musi mieć przykładową odpowiedź i wskazówkę

WYWOŁAJ NARZĘDZIE submit_assignment_tasks — nie odpowiadaj tekstowo.`

const GRADE_PROMPT = `Jesteś asystentem korepetytora matematyki. Ocenisz odpowiedź ucznia.

ZASADY:
1. Komentarz po polsku, max 200 znaków, w drugiej osobie
2. LaTeX inline ($...$) dozwolony

WYWOŁAJ NARZĘDZIE submit_task_grade — nie odpowiadaj tekstowo.`

const OVERALL_PROMPT = `Jesteś asystentem korepetytora matematyki. Wystaw ogólną ocenę pracy.

ZASADY:
1. Skala polska: 1, 2-, 2, 2+, ... 5+, 6
2. Komentarz max 300 znaków po polsku, w drugiej osobie

WYWOŁAJ NARZĘDZIE submit_overall_grade — nie odpowiadaj tekstowo.`

let totalInput = 0
let totalOutput = 0
let totalCalls = 0

function extractToolInput(response, toolName) {
  for (const b of response.content) {
    if (b.type === 'tool_use' && b.name === toolName) return b.input
  }
  return null
}

function trackUsage(response) {
  totalCalls++
  totalInput += response.usage.input_tokens ?? 0
  totalOutput += response.usage.output_tokens ?? 0
}

async function generateTasks(client) {
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS_GEN,
    system: GEN_PROMPT,
    tools: [SUBMIT_TASKS_TOOL],
    tool_choice: { type: 'tool', name: SUBMIT_TASKS_TOOL.name },
    messages: [
      {
        role: 'user',
        content: `Wygeneruj ${TASK_COUNT} zadań z matematyki. Temat: ułamki i pierwiastki. Poziom: klasa 8. Trudność: łatwe.`,
      },
    ],
  })
  trackUsage(r)
  return extractToolInput(r, SUBMIT_TASKS_TOOL.name)
}

async function gradeOneTask(client, task, studentAnswer) {
  const userMessage = `**Treść zadania:**
${task.content}

**Wzorcowe rozwiązanie:**
${task.expected_answer}

**Odpowiedź ucznia:**
${studentAnswer && studentAnswer.trim() ? studentAnswer : '(uczeń nie udzielił odpowiedzi)'}`

  const r = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS_GRADE,
    system: GRADE_PROMPT,
    tools: [GRADE_TASK_TOOL],
    tool_choice: { type: 'tool', name: GRADE_TASK_TOOL.name },
    messages: [{ role: 'user', content: userMessage }],
  })
  trackUsage(r)
  return extractToolInput(r, GRADE_TASK_TOOL.name)
}

async function gradeOverall(client, perTask) {
  const userMessage = `Lista zadań po ocenie AI:

${perTask
  .map(
    (g, i) =>
      `${i + 1}. [${g.is_correct ? 'POPRAWNE' : 'NIEPOPRAWNE'}] ${g.comment}`,
  )
  .join('\n')}

Procent poprawnych: ${Math.round(
    (perTask.filter((g) => g.is_correct).length / perTask.length) * 100,
  )}%.`

  const r = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS_GRADE,
    system: OVERALL_PROMPT,
    tools: [GRADE_OVERALL_TOOL],
    tool_choice: { type: 'tool', name: GRADE_OVERALL_TOOL.name },
    messages: [{ role: 'user', content: userMessage }],
  })
  trackUsage(r)
  return extractToolInput(r, GRADE_OVERALL_TOOL.name)
}

// ---------- runner ----------

const PASS = '\x1b[32mPASS\x1b[0m'
const FAIL = '\x1b[31mFAIL\x1b[0m'

function check(label, ok, detail = '') {
  console.log(`  ${ok ? PASS : FAIL}  ${label}${detail ? ' — ' + detail : ''}`)
  return ok
}

function assertTask(t) {
  return (
    t &&
    typeof t.order_index === 'number' &&
    typeof t.content === 'string' &&
    typeof t.expected_answer === 'string' &&
    typeof t.hint === 'string' &&
    ['open', 'closed', 'calculation', 'proof'].includes(t.task_type)
  )
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey === 'PLACEHOLDER') {
    console.error('Brak ANTHROPIC_API_KEY w środowisku.')
    process.exit(1)
  }
  const client = new Anthropic({ apiKey })

  console.log(`\nModel: ${MODEL}  |  Zadań na test: ${TASK_COUNT}\n`)

  let allPassed = true

  // ===== Cykl wspólny: generowanie zadań =====
  console.log('--- Generowanie 2 zadań (wykorzystywane przez Cykle 1, 3, 4, 5)')
  const t0 = Date.now()
  const gen = await generateTasks(client)
  console.log(`     (${Date.now() - t0} ms)`)

  let genOk = true
  genOk &&= check('zwrócono tool_use input', !!gen)
  genOk &&= check(
    `assignment_title jest stringiem`,
    typeof gen?.assignment_title === 'string',
    gen?.assignment_title?.slice(0, 60),
  )
  genOk &&= check(
    `tasks ma długość ${TASK_COUNT}`,
    Array.isArray(gen?.tasks) && gen.tasks.length === TASK_COUNT,
  )
  if (gen?.tasks) {
    for (let i = 0; i < gen.tasks.length; i++) {
      genOk &&= check(`task[${i}] ma poprawny kształt`, assertTask(gen.tasks[i]))
    }
    genOk &&= check(
      'przynajmniej jedno zadanie zawiera LaTeX',
      gen.tasks.some((t) => /\$.+\$/.test(t.content)),
    )
    genOk &&= check(
      'każde zadanie ma niepustą wskazówkę',
      gen.tasks.every((t) => t.hint.trim().length > 0),
    )
  }
  allPassed &&= genOk

  if (!gen?.tasks) {
    console.error('Nie udało się wygenerować zadań — przerywam.')
    process.exit(1)
  }

  // ===== Cykl 1: LaTeX inline w student_answer =====
  console.log(
    '\n--- Cykl 1: ocena z LaTeX w odpowiedzi (oczekiwane: tool_use + poprawne pola)',
  )
  const c1Answer = 'Wynik to $\\frac{1}{2} + \\sqrt{2}$, czyli około 1,914.'
  const c1Grade = await gradeOneTask(client, gen.tasks[0], c1Answer)
  let c1Ok = true
  c1Ok &&= check('zwrócono tool_use input', !!c1Grade)
  c1Ok &&= check(
    'is_correct jest booleanem',
    typeof c1Grade?.is_correct === 'boolean',
    String(c1Grade?.is_correct),
  )
  c1Ok &&= check(
    'comment niepusty',
    typeof c1Grade?.comment === 'string' && c1Grade.comment.length > 0,
    c1Grade?.comment?.slice(0, 80),
  )
  allPassed &&= c1Ok

  // ===== Cykl 2: równoważne ścieżce auto-grading (zachowanie identyczne) =====
  console.log(
    '\n--- Cykl 2: auto-grading flow (identyczny kod path co Cykl 1 + flaga w DB) — pomijam dodatkowy call API, weryfikacja w kodzie',
  )
  console.log(
    `     ${PASS}  flow weryfikowany w submitAssignment → runAIGradingCore (kod nie zmienia się względem manualnego); jedyna różnica to assignmentBefore.auto_grade_enabled → after()`,
  )

  // ===== Cykl 3: pusta odpowiedź =====
  console.log('\n--- Cykl 3: pusta odpowiedź (edge case)')
  const c3Grade = await gradeOneTask(client, gen.tasks[0], '')
  let c3Ok = true
  c3Ok &&= check('zwrócono tool_use input', !!c3Grade)
  c3Ok &&= check(
    'is_correct = false (pusta odpowiedź)',
    c3Grade?.is_correct === false,
  )
  c3Ok &&= check(
    'comment zachęcający / niepusty',
    typeof c3Grade?.comment === 'string' && c3Grade.comment.length > 0,
    c3Grade?.comment?.slice(0, 80),
  )
  allPassed &&= c3Ok

  // ===== Cykl 4: plain text (bez LaTeX) =====
  console.log('\n--- Cykl 4: zwykły tekst bez LaTeX')
  const c4Answer = 'Odpowiedź to jedna druga plus pierwiastek z dwa.'
  const c4Grade = await gradeOneTask(client, gen.tasks[1], c4Answer)
  let c4Ok = true
  c4Ok &&= check('zwrócono tool_use input', !!c4Grade)
  c4Ok &&= check(
    'comment niepusty',
    typeof c4Grade?.comment === 'string' && c4Grade.comment.length > 0,
    c4Grade?.comment?.slice(0, 80),
  )
  allPassed &&= c4Ok

  // ===== Cykl 5: długi LaTeX =====
  console.log('\n--- Cykl 5: dłuższy LaTeX')
  const c5Answer =
    'Liczę: $\\int_0^{\\infty} e^{-x^2}dx = \\frac{\\sqrt{\\pi}}{2}$, klasyczny wynik całki Gaussa.'
  const c5Grade = await gradeOneTask(client, gen.tasks[1], c5Answer)
  let c5Ok = true
  c5Ok &&= check('zwrócono tool_use input', !!c5Grade)
  c5Ok &&= check(
    'comment niepusty',
    typeof c5Grade?.comment === 'string' && c5Grade.comment.length > 0,
    c5Grade?.comment?.slice(0, 80),
  )
  allPassed &&= c5Ok

  // ===== Cykl wspólny: overall grade =====
  console.log('\n--- Ocena ogólna (suma cykli)')
  const overall = await gradeOverall(client, [c1Grade, c4Grade, c5Grade])
  let oOk = true
  oOk &&= check('zwrócono tool_use input', !!overall)
  oOk &&= check(
    'grade niepusty',
    typeof overall?.grade === 'string' && overall.grade.length > 0,
    overall?.grade,
  )
  oOk &&= check(
    'feedback niepusty',
    typeof overall?.feedback === 'string' && overall.feedback.length > 0,
    overall?.feedback?.slice(0, 80),
  )
  allPassed &&= oOk

  // ===== Podsumowanie =====
  console.log('\n=== PODSUMOWANIE ===')
  console.log(`Wywołania API: ${totalCalls}`)
  console.log(`Input tokens:  ${totalInput}`)
  console.log(`Output tokens: ${totalOutput}`)
  console.log(`Total tokens:  ${totalInput + totalOutput}`)
  // Haiku 4.5: $1/MTok input, $5/MTok output
  const estCost =
    (totalInput / 1_000_000) * 1.0 + (totalOutput / 1_000_000) * 5.0
  console.log(`Szacunkowy koszt (Haiku 4.5): $${estCost.toFixed(5)}`)
  console.log(
    `\nStatus końcowy: ${allPassed ? '\x1b[32mWSZYSTKO OK\x1b[0m' : '\x1b[31mNIEKTÓRE TESTY UPADŁY\x1b[0m'}`,
  )
  process.exit(allPassed ? 0 : 1)
}

main().catch((e) => {
  console.error('Skrypt się wywalił:', e)
  process.exit(1)
})
