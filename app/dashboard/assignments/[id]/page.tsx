import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TeacherAssignmentDetail } from './teacher-detail'
import { StudentAssignmentDetail } from './student-detail'

export const dynamic = 'force-dynamic'

type RouteParams = { id: string }

type AssignmentFull = {
  id: string
  teacher_id: string
  student_id: string
  title: string
  topic: string | null
  grade_level: string | null
  difficulty: string | null
  status: string
  due_date: string | null
  sent_at: string | null
  submitted_at: string | null
  grade: string | null
  teacher_feedback: string | null
  teacher_message: string | null
  auto_grade_enabled: boolean
  ai_suggested_grade: string | null
  ai_suggested_feedback: string | null
  created_at: string
}

type TaskRow = {
  id: string
  order_index: number
  content: string
  task_type: string | null
  expected_answer: string | null
  student_answer: string | null
  is_correct: boolean | null
  teacher_comment: string | null
  hint: string | null
  ai_suggested_correct: boolean | null
  ai_suggested_comment: string | null
  ai_graded_at: string | null
}

export default async function AssignmentDetailPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()
  const role = profile?.role ?? 'student'

  const { data: assignment } = await supabase
    .from('assignments')
    .select(
      'id, teacher_id, student_id, title, topic, grade_level, difficulty, status, due_date, sent_at, submitted_at, grade, teacher_feedback, teacher_message, auto_grade_enabled, ai_suggested_grade, ai_suggested_feedback, created_at',
    )
    .eq('id', id)
    .single<AssignmentFull>()

  if (!assignment) notFound()

  // Pobieramy zadania (RLS zwróci tylko te, do których użytkownik ma dostęp).
  const { data: tasksRaw } = await supabase
    .from('tasks')
    .select(
      'id, order_index, content, task_type, expected_answer, student_answer, is_correct, teacher_comment, hint, ai_suggested_correct, ai_suggested_comment, ai_graded_at',
    )
    .eq('assignment_id', id)
    .order('order_index', { ascending: true })

  const tasks = (tasksRaw ?? []) as TaskRow[]

  // Imię drugiej strony (do nagłówka)
  const otherId =
    role === 'teacher' ? assignment.student_id : assignment.teacher_id
  const { data: otherProfile } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('id', otherId)
    .single()
  const otherName =
    `${otherProfile?.first_name ?? ''} ${otherProfile?.last_name ?? ''}`.trim() ||
    (role === 'teacher' ? 'Uczeń' : 'Nauczyciel')

  // Klucz wymusza remount po każdej zmianie statusu LUB po pojawieniu się
  // sugestii AI. Bez tego useState({initial}) w komponencie klienckim
  // ignoruje nowe wartości propsów (stan zostaje stary po router.refresh()).
  const detailKey = `${assignment.id}-${assignment.status}-${assignment.ai_suggested_grade ?? 'no-ai'}`

  if (role === 'teacher' && assignment.teacher_id === user.id) {
    return (
      <TeacherAssignmentDetail
        key={detailKey}
        assignment={assignment}
        tasks={tasks}
        studentName={otherName}
      />
    )
  }
  if (assignment.student_id === user.id) {
    return (
      <StudentAssignmentDetail
        key={detailKey}
        assignment={assignment}
        tasks={tasks}
        teacherName={otherName}
      />
    )
  }
  notFound()
}
