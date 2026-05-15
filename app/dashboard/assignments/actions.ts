'use server'

import Anthropic from '@anthropic-ai/sdk'
import { revalidatePath } from 'next/cache'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// Centralna stała modelu — wszystkie wywołania Claude API w tym module
// używają tej wartości. Łatwo przełączyć na tańszy model (haiku) w razie
// testów lub awarii Sonnet.
const AI_MODEL = 'claude-sonnet-4-6'

// Typ pojedynczego zadania w odpowiedzi z modelu / w podglądzie kreatora.
// Pole hint jest opcjonalne — tolerujemy starsze odpowiedzi (przed dodaniem
// generowania wskazówek) oraz sytuacje, w których model je pominie.
export type GeneratedTask = {
  order_index: number
  content: string
  task_type: 'open' | 'closed' | 'calculation' | 'proof'
  expected_answer: string
  hint?: string
}

export type GenerationResult = {
  assignment_title: string
  tasks: GeneratedTask[]
}

export type GenerationParams = {
  subject: 'mathematics'
  topic: string
  grade_level: string
  difficulty: 'easy' | 'medium' | 'hard' | 'mixed'
  task_count: number
  custom_prompt: string
}

// Stały system prompt — trzymamy poza ciałem funkcji, żeby był deterministycznie
// ten sam string przy każdym wywołaniu (warunek skutecznego prompt cachingu).
//
// UWAGA: Nie prosimy modelu o JSON tekstowy — używamy tool use (patrz niżej).
// SDK zwraca już zparsowany obiekt, więc unikamy problemów z escapowaniem
// LaTeX-owych ukośników, cudzysłowów i znaków kontrolnych.
const SYSTEM_PROMPT = `Jesteś asystentem korepetytora matematyki. Generujesz zadania matematyczne dla uczniów.

ZASADY:
1. Wszystkie zadania w języku polskim
2. Wzory matematyczne ZAWSZE w formacie LaTeX:
   - Inline: $wzór$
   - Block (na osobnej linii): $$wzór$$
3. Treść zadań jako Markdown
4. Diagramy/wykresy: opisuj słownie LUB używaj składni TikZ w bloku kodu (renderowanie po stronie frontu)
5. Każde zadanie musi mieć przykładową odpowiedź / rozwiązanie (do wglądu nauczyciela)
6. Zadania dopasowane do poziomu (klasa/matura) i trudności

WSKAZÓWKI:
- Każde zadanie musi mieć pole "hint"
- Wskazówka kieruje ucznia, ale NIE rozwiązuje zadania
- Przykład dobry: "Zauważ, że wzór można rozłożyć jako $(x+a)(x+b)$. Spróbuj znaleźć takie $a$ i $b$."
- Przykład zły: "Odpowiedź to $x=2$ i $x=3$" (to już rozwiązanie!)
- 1-2 zdania max
- Może zawierać LaTeX (inline)

WYWOŁAJ NARZĘDZIE submit_assignment_tasks — nie odpowiadaj tekstowo. Wszystkie pola tekstowe (content, expected_answer, hint) traktuj jako zwykły tekst (Markdown z LaTeX); ukośniki, cudzysłowy i nowe linie umieszczaj naturalnie, system serializuje JSON za Ciebie.`

// System prompt do oceny pojedynczego zadania.
const GRADING_SYSTEM_PROMPT = `Jesteś asystentem korepetytora matematyki. Twoim zadaniem jest ocena odpowiedzi ucznia na zadanie matematyczne.

ZASADY:
1. Bądź obiektywny i konstruktywny
2. Zwracaj uwagę na poprawność matematyczną (nie tylko końcową odpowiedź, ale i tok rozumowania jeśli widoczny)
3. Komentarz po polsku, max 200 znaków, w drugiej osobie ("Dobrze rozwiązałeś...", "Sprawdź jeszcze...", "Pamiętaj że...")
4. Wzory matematyczne w komentarzu w formacie LaTeX (inline: $...$)
5. Jeśli odpowiedź jest pusta lub bardzo niekompletna - is_correct=false, komentarz zachęcający
6. Jeśli odpowiedź ma drobny błąd ale pokazuje dobre rozumienie - is_correct=false z konkretną wskazówką co poprawić
7. Jeśli odpowiedź jest poprawna - is_correct=true z pozytywnym komentarzem

WYWOŁAJ NARZĘDZIE submit_task_grade — nie odpowiadaj tekstowo.`

// System prompt do oceny ogólnej całej pracy — na podstawie wyników per-task.
const OVERALL_GRADING_SYSTEM_PROMPT = `Jesteś asystentem korepetytora matematyki. Dostajesz listę zadań ze sprawdzonej pracy domowej (każde z is_correct + komentarzem AI). Twoim zadaniem jest zaproponować OGÓLNĄ ocenę całej pracy.

ZASADY:
1. Skala ocen polska szkolna: 1, 1+, 2-, 2, 2+, 3-, 3, 3+, 4-, 4, 4+, 5-, 5, 5+, 6
2. Bierz pod uwagę zarówno liczbę poprawnych zadań, jak i jakość rozumowania widoczną w komentarzach AI
3. Komentarz ogólny po polsku, max 300 znaków, w drugiej osobie ("Bardzo dobrze poradziłeś sobie z...", "Warto popracować nad...")
4. Konstruktywny ton, możliwy LaTeX inline w komentarzu

WYWOŁAJ NARZĘDZIE submit_overall_grade — nie odpowiadaj tekstowo.`

// ===========================================================================
// Definicje narzędzi (tool use) — Claude API serializuje za nas, więc nie ma
// potrzeby ręcznego parsowania JSON. To eliminuje klasę błędów escapowania
// LaTeX-owych ukośników w polach tekstowych.
// ===========================================================================

const SUBMIT_TASKS_TOOL = {
  name: 'submit_assignment_tasks',
  description:
    'Zwraca wygenerowane zadania matematyczne. Wywołuj zawsze — nie pisz tekstowej odpowiedzi.',
  input_schema: {
    type: 'object' as const,
    properties: {
      assignment_title: {
        type: 'string',
        description: 'Krótki tytuł całej pracy domowej',
      },
      tasks: {
        type: 'array',
        description: 'Lista zadań w kolejności prezentacji.',
        items: {
          type: 'object',
          properties: {
            order_index: { type: 'integer' },
            content: {
              type: 'string',
              description:
                'Treść zadania — Markdown z LaTeX (inline $...$, block $$...$$)',
            },
            task_type: {
              type: 'string',
              enum: ['open', 'closed', 'calculation', 'proof'],
            },
            expected_answer: {
              type: 'string',
              description:
                'Wzorcowe rozwiązanie / odpowiedź — do wglądu nauczyciela',
            },
            hint: {
              type: 'string',
              description:
                'Wskazówka dla ucznia (1-2 zdania, kierunkuje, ale NIE rozwiązuje)',
            },
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
} satisfies Anthropic.Tool

const GRADE_TASK_TOOL = {
  name: 'submit_task_grade',
  description: 'Zwraca ocenę pojedynczego zadania.',
  input_schema: {
    type: 'object' as const,
    properties: {
      is_correct: { type: 'boolean' },
      comment: {
        type: 'string',
        description:
          'Krótki komentarz po polsku, max ~200 znaków, w 2. osobie, LaTeX inline dozwolony.',
      },
    },
    required: ['is_correct', 'comment'],
  },
} satisfies Anthropic.Tool

const GRADE_OVERALL_TOOL = {
  name: 'submit_overall_grade',
  description: 'Zwraca ogólną ocenę całej pracy.',
  input_schema: {
    type: 'object' as const,
    properties: {
      grade: {
        type: 'string',
        description: 'Ocena w polskiej skali szkolnej (1, 1+, 2-, … 5+, 6).',
      },
      feedback: {
        type: 'string',
        description:
          'Komentarz ogólny po polsku, max ~300 znaków, LaTeX inline dozwolony.',
      },
    },
    required: ['grade', 'feedback'],
  },
} satisfies Anthropic.Tool

const DIFFICULTY_LABELS: Record<GenerationParams['difficulty'], string> = {
  easy: 'łatwe',
  medium: 'średnie',
  hard: 'trudne',
  mixed: 'mieszane (różne poziomy trudności w obrębie pracy)',
}

// Wyciąga `input` z bloku `tool_use` o podanej nazwie. Anthropic SDK
// dostarcza już zparsowany obiekt (bez JSON-parsowania po naszej stronie),
// więc problem escapingu LaTeX-owych ukośników / cudzysłowów / znaków
// kontrolnych po prostu nie istnieje.
function extractToolInput(
  response: Anthropic.Message,
  toolName: string,
): unknown {
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === toolName) {
      return block.input
    }
  }
  // Surowy output do dziennika serwera — pomocne przy debugowaniu (model
  // może uparcie zignorować tool_choice i odpowiedzieć tekstem).
  const text = response.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim()
  console.error(
    `[ai] Model nie wywołał narzędzia ${toolName}. Stop reason=${response.stop_reason}. Tekstowa odpowiedź (skrócona):`,
    text.slice(0, 800),
  )
  throw new Error(
    `Model nie wywołał oczekiwanego narzędzia (${toolName}). Spróbuj ponownie.`,
  )
}

function isGenerationResult(value: unknown): value is GenerationResult {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.assignment_title !== 'string') return false
  if (!Array.isArray(v.tasks)) return false
  for (const t of v.tasks) {
    if (!t || typeof t !== 'object') return false
    const tt = t as Record<string, unknown>
    if (typeof tt.content !== 'string') return false
    if (typeof tt.task_type !== 'string') return false
    if (typeof tt.expected_answer !== 'string') return false
    // hint opcjonalny — jeśli model go pominie, normalizujemy później na pusty
    if (tt.hint !== undefined && tt.hint !== null && typeof tt.hint !== 'string') {
      return false
    }
  }
  return true
}

async function assertTeacher(): Promise<{ userId: string }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  if (profile?.role !== 'teacher') {
    throw new Error('Tę operację może wykonać wyłącznie nauczyciel.')
  }
  return { userId: user.id }
}

// ----------------------------------------------------------------------------
// Generowanie zadań przez Claude API (claude-sonnet-4-6).
//
// Używamy prompt cachingu na system prompt — przy ponownych wywołaniach
// (np. „wygeneruj kolejne") system prompt jest serwowany z cache (~10% kosztu).
// ----------------------------------------------------------------------------

export async function generateAssignmentTasks(
  params: GenerationParams,
  options?: { existingTasks?: GeneratedTask[] }, // do trybu „dogeneruj"
): Promise<GenerationResult> {
  await assertTeacher()

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey === 'PLACEHOLDER') {
    throw new Error(
      'Brak klucza ANTHROPIC_API_KEY w środowisku. Skontaktuj się z administratorem.',
    )
  }

  const client = new Anthropic({ apiKey })

  const userPromptParts: string[] = [
    `Wygeneruj ${params.task_count} zadań z matematyki.`,
    `Temat: ${params.topic || '(dowolny)'}.`,
    `Poziom: ${params.grade_level || '(nieokreślony)'}.`,
    `Trudność: ${DIFFICULTY_LABELS[params.difficulty]}.`,
  ]
  if (params.custom_prompt.trim()) {
    userPromptParts.push(`Dodatkowe wskazówki nauczyciela: ${params.custom_prompt.trim()}`)
  }
  if (options?.existingTasks && options.existingTasks.length > 0) {
    userPromptParts.push(
      `WAŻNE: Wygeneruj NOWE zadania, RÓŻNE od poniższych już istniejących. Numeruj order_index zaczynając od ${options.existingTasks.length + 1}.`,
      'Istniejące zadania:',
      ...options.existingTasks.map(
        (t) => `${t.order_index}. ${t.content.slice(0, 200)}`,
      ),
    )
  }

  let response: Anthropic.Message
  try {
    response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [SUBMIT_TASKS_TOOL],
      tool_choice: { type: 'tool', name: SUBMIT_TASKS_TOOL.name },
      messages: [{ role: 'user', content: userPromptParts.join('\n\n') }],
    })
  } catch (err) {
    throw wrapAnthropicError(err, 'Generowanie zadań')
  }

  const parsed = extractToolInput(response, SUBMIT_TASKS_TOOL.name)
  if (!isGenerationResult(parsed)) {
    console.error(
      '[ai] submit_assignment_tasks zwróciło nieprawidłowy kształt:',
      JSON.stringify(parsed).slice(0, 800),
    )
    throw new Error(
      'Model zwrócił niepoprawną odpowiedź, spróbuj ponownie.',
    )
  }

  // Normalizacja — gwarantujemy ciągłą numerację 1..N (lub kontynuację przy
  // dogenerowaniu) niezależnie od tego, co zwrócił model.
  const startIndex = (options?.existingTasks?.length ?? 0) + 1
  parsed.tasks = parsed.tasks.map((t, i) => ({
    order_index: startIndex + i,
    content: t.content,
    task_type: ['open', 'closed', 'calculation', 'proof'].includes(t.task_type)
      ? t.task_type
      : 'open',
    expected_answer: t.expected_answer,
    hint: typeof t.hint === 'string' ? t.hint : '',
  }))

  return parsed
}

// ----------------------------------------------------------------------------
// Zapis zaakceptowanej pracy do bazy (status='draft').
// ----------------------------------------------------------------------------

export type SaveAssignmentInput = {
  studentId: string
  title: string
  topic: string
  gradeLevel: string
  difficulty: GenerationParams['difficulty']
  customPrompt: string
  tasks: GeneratedTask[]
  autoGradeEnabled: boolean
}

export async function saveAssignment(
  input: SaveAssignmentInput,
): Promise<{ id: string }> {
  const { userId } = await assertTeacher()
  const supabase = await createClient()

  if (input.tasks.length === 0) {
    throw new Error('Praca musi zawierać co najmniej jedno zadanie.')
  }

  const { data: assignment, error: aErr } = await supabase
    .from('assignments')
    .insert({
      teacher_id: userId,
      student_id: input.studentId,
      title: input.title.trim() || 'Praca domowa',
      subject: 'mathematics',
      topic: input.topic.trim() || null,
      grade_level: input.gradeLevel.trim() || null,
      difficulty: input.difficulty,
      custom_prompt: input.customPrompt.trim() || null,
      status: 'draft',
      auto_grade_enabled: input.autoGradeEnabled,
    })
    .select('id')
    .single()

  if (aErr || !assignment) {
    throw new Error(aErr?.message ?? 'Nie udało się zapisać pracy.')
  }

  const tasksRows = input.tasks.map((t, i) => ({
    assignment_id: assignment.id,
    order_index: i + 1,
    content: t.content,
    task_type: t.task_type,
    expected_answer: t.expected_answer || null,
    hint: t.hint?.trim() ? t.hint.trim() : null,
  }))

  const { error: tErr } = await supabase.from('tasks').insert(tasksRows)
  if (tErr) {
    // Cofamy assignments, żeby nie zostawiać sieroty.
    await supabase.from('assignments').delete().eq('id', assignment.id)
    throw new Error(`Błąd zapisu zadań: ${tErr.message}`)
  }

  revalidatePath('/dashboard/assignments')
  return { id: assignment.id }
}

// ----------------------------------------------------------------------------
// Wysyłka pracy do ucznia — status='sent', sent_at, due_date.
// Trigger `notify_assignment_received` wyśle uczniowi powiadomienie.
// ----------------------------------------------------------------------------

export async function sendAssignment(
  assignmentId: string,
  dueDate: string | null,
  message: string,
): Promise<void> {
  const { userId } = await assertTeacher()
  const supabase = await createClient()

  const { error } = await supabase
    .from('assignments')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      due_date: dueDate,
      teacher_message: message.trim() || null,
    })
    .eq('id', assignmentId)
    .eq('teacher_id', userId)
    .eq('status', 'draft')

  if (error) throw new Error(error.message)

  revalidatePath('/dashboard/assignments')
  revalidatePath(`/dashboard/assignments/${assignmentId}`)
  revalidatePath('/dashboard', 'layout')
}

// ----------------------------------------------------------------------------
// Usunięcie pracy (tylko draft i sent — po oddaniu zostawiamy historię).
// ----------------------------------------------------------------------------

export async function deleteAssignment(assignmentId: string): Promise<void> {
  const { userId } = await assertTeacher()
  const supabase = await createClient()

  const { error } = await supabase
    .from('assignments')
    .delete()
    .eq('id', assignmentId)
    .eq('teacher_id', userId)
    .in('status', ['draft', 'sent'])

  if (error) throw new Error(error.message)
  revalidatePath('/dashboard/assignments')
}

// ----------------------------------------------------------------------------
// Auto-save odpowiedzi ucznia. Uczeń może updatować TYLKO student_answer
// (egzekwuje to RLS + trigger). Przy pierwszym zapisie podnosimy status
// 'sent' → 'in_progress'.
// ----------------------------------------------------------------------------

export async function saveStudentAnswer(
  taskId: string,
  answer: string,
  assignmentId: string,
): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const { error: tErr } = await supabase
    .from('tasks')
    .update({ student_answer: answer })
    .eq('id', taskId)

  if (tErr) throw new Error(tErr.message)

  // Status: jeśli był 'sent', podnieś na 'in_progress'.
  const { data: assignment } = await supabase
    .from('assignments')
    .select('status')
    .eq('id', assignmentId)
    .single()

  if (assignment?.status === 'sent') {
    await supabase
      .from('assignments')
      .update({ status: 'in_progress' })
      .eq('id', assignmentId)
      .eq('student_id', user.id)
  }
}

// ----------------------------------------------------------------------------
// Oddanie pracy przez ucznia — status='submitted'.
// ----------------------------------------------------------------------------

export async function submitAssignment(assignmentId: string): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  // Najpierw sprawdzamy czy auto_grade_enabled — przed zmianą statusu, żeby
  // wiedzieć, czy zaplanować AI w tle. RLS pozwala uczniowi czytać własne
  // assignment.
  const { data: assignmentBefore } = await supabase
    .from('assignments')
    .select('auto_grade_enabled')
    .eq('id', assignmentId)
    .single<{ auto_grade_enabled: boolean }>()

  const { error } = await supabase
    .from('assignments')
    .update({ status: 'submitted' })
    .eq('id', assignmentId)
    .eq('student_id', user.id)
    .in('status', ['sent', 'in_progress'])

  if (error) throw new Error(error.message)

  revalidatePath('/dashboard/assignments')
  revalidatePath(`/dashboard/assignments/${assignmentId}`)
  revalidatePath('/dashboard', 'layout')

  // Auto-grading po stronie serwera, w tle. Klient ucznia odpowiedzi nie
  // czeka — Next.js dokończy zadanie po zwrocie response (after()).
  if (assignmentBefore?.auto_grade_enabled) {
    console.log(
      `[ai-grading] ${new Date().toISOString()} submitAssignment(${assignmentId}): scheduling after() callback`,
    )
    after(async () => {
      console.log(
        `[ai-grading] ${new Date().toISOString()} after() callback firing for ${assignmentId}`,
      )
      try {
        await runAIGradingCore(assignmentId)
        console.log(
          `[ai-grading] ${new Date().toISOString()} after() callback completed for ${assignmentId}`,
        )
      } catch (e) {
        console.error(
          `[ai-grading] ${new Date().toISOString()} Auto AI grading failed for ${assignmentId}:`,
          e,
        )
      }
    })
  } else {
    console.log(
      `[ai-grading] ${new Date().toISOString()} submitAssignment(${assignmentId}): auto_grade_enabled=false, skipping`,
    )
  }
}

// ----------------------------------------------------------------------------
// Ocenianie pracy przez nauczyciela.
// ----------------------------------------------------------------------------

export type TaskGrading = {
  taskId: string
  isCorrect: boolean | null
  comment: string
}

export async function gradeAssignment(
  assignmentId: string,
  grade: string,
  feedback: string,
  perTask: TaskGrading[],
): Promise<void> {
  const { userId } = await assertTeacher()
  const supabase = await createClient()

  // Aktualizujemy zadania pojedynczo — Supabase nie wspiera batch update
  // z różnymi wartościami per-row, a liczba zadań jest mała (≤ 10).
  for (const t of perTask) {
    const { error: tErr } = await supabase
      .from('tasks')
      .update({
        is_correct: t.isCorrect,
        teacher_comment: t.comment.trim() || null,
      })
      .eq('id', t.taskId)
      .eq('assignment_id', assignmentId)
    if (tErr) throw new Error(`Zadanie ${t.taskId}: ${tErr.message}`)
  }

  const { error: aErr } = await supabase
    .from('assignments')
    .update({
      status: 'graded',
      grade: grade.trim() || null,
      teacher_feedback: feedback.trim() || null,
    })
    .eq('id', assignmentId)
    .eq('teacher_id', userId)

  if (aErr) throw new Error(aErr.message)

  revalidatePath('/dashboard/assignments')
  revalidatePath(`/dashboard/assignments/${assignmentId}`)
  revalidatePath('/dashboard', 'layout')
}

// ----------------------------------------------------------------------------
// AI grading — szczegóły implementacji.
//
// runAIGradingCore — wewnętrzna funkcja wykonująca pełny pipeline:
//   1) per-task grading (Claude API, równolegle Promise.all)
//   2) ocena ogólna (drugi prompt na podstawie wyników z 1)
//   3) zapis wyników w bazie (admin client — bo wywołanie z `after()` po
//      submitAssignment nie ma uprawnień nauczyciela; manualne wywołanie
//      gradeAssignmentWithAI też używa tego samego trybu, dla spójności)
//
// W razie błędu API: throw — żadne częściowe wyniki nie idą do bazy
// (Promise.all rejects on first failure → nic się nie zapisuje).
// ----------------------------------------------------------------------------

type PerTaskGradingResult = {
  taskId: string
  is_correct: boolean
  comment: string
}

type OverallGradingResult = {
  grade: string
  feedback: string
}

function isPerTaskResult(v: unknown): v is { is_correct: boolean; comment: string } {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.is_correct === 'boolean' && typeof o.comment === 'string'
}

function isOverallResult(v: unknown): v is OverallGradingResult {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.grade === 'string' && typeof o.feedback === 'string'
}

function wrapAnthropicError(err: unknown, prefix: string): Error {
  if (err instanceof Anthropic.RateLimitError) {
    return new Error(`${prefix}: przekroczono limit zapytań do Claude API. Spróbuj ponownie za chwilę.`)
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error(`${prefix}: nieprawidłowy klucz ANTHROPIC_API_KEY.`)
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`${prefix}: błąd Claude API (${err.status ?? '?'}): ${err.message}`)
  }
  if (err instanceof Error) return new Error(`${prefix}: ${err.message}`)
  return new Error(prefix)
}

async function gradeOneTask(
  client: Anthropic,
  task: { id: string; content: string; expected_answer: string | null; student_answer: string | null },
): Promise<PerTaskGradingResult> {
  const userMessage = `**Treść zadania:**
${task.content}

**Wzorcowe rozwiązanie (do Twojej wiedzy, nie pokazujemy uczniowi):**
${task.expected_answer ?? '(brak)'}

**Odpowiedź ucznia:**
${task.student_answer && task.student_answer.trim() ? task.student_answer : '(uczeń nie udzielił odpowiedzi)'}`

  let response: Anthropic.Message
  try {
    response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 500,
      system: [
        {
          type: 'text',
          text: GRADING_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [GRADE_TASK_TOOL],
      tool_choice: { type: 'tool', name: GRADE_TASK_TOOL.name },
      messages: [{ role: 'user', content: userMessage }],
    })
  } catch (err) {
    throw wrapAnthropicError(err, `Ocena zadania ${task.id.slice(0, 8)}`)
  }

  const parsed = extractToolInput(response, GRADE_TASK_TOOL.name)
  if (!isPerTaskResult(parsed)) {
    console.error(
      `[ai] submit_task_grade dla ${task.id.slice(0, 8)} zwróciło nieprawidłowy kształt:`,
      JSON.stringify(parsed).slice(0, 400),
    )
    throw new Error(
      'Model zwrócił niepoprawną odpowiedź przy ocenianiu zadania, spróbuj ponownie.',
    )
  }
  return { taskId: task.id, is_correct: parsed.is_correct, comment: parsed.comment }
}

async function gradeOverall(
  client: Anthropic,
  perTask: PerTaskGradingResult[],
): Promise<OverallGradingResult> {
  const correct = perTask.filter((t) => t.is_correct).length
  const pct = perTask.length > 0 ? Math.round((correct / perTask.length) * 100) : 0

  const userMessage = `Lista zadań po ocenie AI:

${perTask
  .map(
    (g, i) =>
      `${i + 1}. [${g.is_correct ? 'POPRAWNE' : 'NIEPOPRAWNE'}] ${g.comment}`,
  )
  .join('\n')}

Procent poprawnych zadań: ${pct}% (${correct}/${perTask.length}).`

  let response: Anthropic.Message
  try {
    response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 500,
      system: [
        {
          type: 'text',
          text: OVERALL_GRADING_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [GRADE_OVERALL_TOOL],
      tool_choice: { type: 'tool', name: GRADE_OVERALL_TOOL.name },
      messages: [{ role: 'user', content: userMessage }],
    })
  } catch (err) {
    throw wrapAnthropicError(err, 'Ocena ogólna pracy')
  }

  const parsed = extractToolInput(response, GRADE_OVERALL_TOOL.name)
  if (!isOverallResult(parsed)) {
    console.error(
      '[ai] submit_overall_grade zwróciło nieprawidłowy kształt:',
      JSON.stringify(parsed).slice(0, 400),
    )
    throw new Error(
      'Model zwrócił niepoprawną odpowiedź przy ocenie ogólnej, spróbuj ponownie.',
    )
  }
  return parsed
}

async function runAIGradingCore(assignmentId: string): Promise<void> {
  const tag = `[ai-grading] ${assignmentId}`
  const log = (msg: string) =>
    console.log(`[ai-grading] ${new Date().toISOString()} ${assignmentId}: ${msg}`)

  log('runAIGradingCore start')

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || apiKey === 'PLACEHOLDER') {
    throw new Error('Brak klucza ANTHROPIC_API_KEY w środowisku.')
  }
  const client = new Anthropic({ apiKey })
  const admin = createAdminClient()

  type AssignmentBasic = {
    id: string
    teacher_id: string
    student_id: string
    title: string
    status: string
  }
  const { data: assignment } = await admin
    .from('assignments')
    .select('id, teacher_id, student_id, title, status')
    .eq('id', assignmentId)
    .single<AssignmentBasic>()
  if (!assignment) throw new Error('Praca nie istnieje.')
  if (assignment.status !== 'submitted') {
    throw new Error('Praca musi być oddana, żeby AI mogło ją ocenić.')
  }

  type TaskForAI = {
    id: string
    content: string
    expected_answer: string | null
    student_answer: string | null
  }
  const { data: tasksRaw } = await admin
    .from('tasks')
    .select('id, content, expected_answer, student_answer')
    .eq('assignment_id', assignmentId)
    .order('order_index', { ascending: true })
  const tasks = (tasksRaw ?? []) as TaskForAI[]
  if (tasks.length === 0) throw new Error('Praca nie zawiera zadań.')

  log(`fetched ${tasks.length} task(s) for grading`)

  // 1) per-task grading równolegle. Dowolny błąd → cały Promise.all rejects.
  log('starting per-task Claude API calls (parallel)')
  const t0 = Date.now()
  const perTask = await Promise.all(
    tasks.map(async (t) => {
      const tStart = Date.now()
      const result = await gradeOneTask(client, t)
      console.log(
        `${tag} per-task done ${t.id.slice(0, 8)} in ${Date.now() - tStart}ms — is_correct=${result.is_correct}`,
      )
      return result
    }),
  )
  log(`all per-task grading done in ${Date.now() - t0}ms`)

  // 2) ocena ogólna na podstawie wyników z 1)
  log('starting overall grading Claude API call')
  const oStart = Date.now()
  const overall = await gradeOverall(client, perTask)
  log(`overall grading done in ${Date.now() - oStart}ms — grade=${overall.grade}`)

  // 3) zapis: najpierw zadania, potem assignments (trigger
  //    notify_assignment_ai_graded fires na update ai_suggested_grade
  //    z NULL → non-NULL).
  log('writing per-task suggestions to DB')
  const now = new Date().toISOString()
  for (const g of perTask) {
    const { error } = await admin
      .from('tasks')
      .update({
        ai_suggested_correct: g.is_correct,
        ai_suggested_comment: g.comment,
        ai_graded_at: now,
      })
      .eq('id', g.taskId)
    if (error) {
      console.error(
        `${tag} DB write FAILED for task ${g.taskId.slice(0, 8)}: ${error.message}`,
      )
      throw new Error(`Zapis sugestii AI dla zadania nieudany: ${error.message}`)
    }
  }
  log('per-task writes done')

  log('writing overall suggestion to assignments')
  const { error: aErr } = await admin
    .from('assignments')
    .update({
      ai_suggested_grade: overall.grade,
      ai_suggested_feedback: overall.feedback,
    })
    .eq('id', assignmentId)
  if (aErr) {
    console.error(`${tag} DB write FAILED for assignment: ${aErr.message}`)
    throw new Error(`Zapis ogólnej sugestii AI nieudany: ${aErr.message}`)
  }
  log('runAIGradingCore done — trigger notify_assignment_ai_graded fires now')
}

// Publiczna akcja serwerowa wywoływana z UI nauczyciela — przycisk
// „Oceń z pomocą AI". Synchronicznie czeka na wynik (~30-60 s).
export async function gradeAssignmentWithAI(assignmentId: string): Promise<void> {
  const { userId } = await assertTeacher()

  // Sprawdzenie własności pracy.
  const supabase = await createClient()
  const { data: a } = await supabase
    .from('assignments')
    .select('teacher_id')
    .eq('id', assignmentId)
    .single<{ teacher_id: string }>()
  if (!a || a.teacher_id !== userId) {
    throw new Error('Nie masz dostępu do tej pracy.')
  }

  await runAIGradingCore(assignmentId)
  revalidatePath(`/dashboard/assignments/${assignmentId}`)
}

// Edycja wskazówki przez nauczyciela (z teacher-detail). RLS pozwala
// nauczycielowi pełny CRUD na zadaniach swoich prac, a guard_task_student_update
// short-circuituje na auth.uid() = teacher_id.
export async function updateTaskHint(
  taskId: string,
  hint: string,
): Promise<void> {
  await assertTeacher()
  const supabase = await createClient()
  const { error } = await supabase
    .from('tasks')
    .update({ hint: hint.trim() ? hint.trim() : null })
    .eq('id', taskId)
  if (error) throw new Error(error.message)
}
