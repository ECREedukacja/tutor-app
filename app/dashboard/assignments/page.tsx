import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TeacherAssignments, type StudentLite } from './teacher-list'
import { StudentAssignments } from './student-list'

export const dynamic = 'force-dynamic'

export default async function AssignmentsPage() {
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

  if (profile?.role === 'teacher') {
    type TLink = {
      student_id: string
      student: { first_name: string; last_name: string } | null
    }
    const { data: linksRaw } = await supabase
      .from('teacher_students')
      .select(
        'student_id, student:profiles!teacher_students_student_id_fkey(first_name, last_name)',
      )
      .eq('teacher_id', user.id)
    const links = (linksRaw ?? []) as unknown as TLink[]
    const students: StudentLite[] = links.map((l) => ({
      id: l.student_id,
      first_name: l.student?.first_name ?? '',
      last_name: l.student?.last_name ?? '',
    }))

    type AssignmentRow = {
      id: string
      title: string
      status: string
      created_at: string
      sent_at: string | null
      due_date: string | null
      submitted_at: string | null
      grade: string | null
      student_id: string
    }
    const { data: rows } = await supabase
      .from('assignments')
      .select(
        'id, title, status, created_at, sent_at, due_date, submitted_at, grade, student_id',
      )
      .eq('teacher_id', user.id)
      .order('created_at', { ascending: false })

    return (
      <TeacherAssignments
        teacherId={user.id}
        students={students}
        assignments={(rows ?? []) as AssignmentRow[]}
      />
    )
  }

  // Uczeń
  type StudentAssignmentRow = {
    id: string
    title: string
    status: string
    sent_at: string | null
    due_date: string | null
    submitted_at: string | null
    grade: string | null
    teacher_id: string
    teacher: { first_name: string; last_name: string } | null
  }

  const { data: rows } = await supabase
    .from('assignments')
    .select(
      'id, title, status, sent_at, due_date, submitted_at, grade, teacher_id, teacher:profiles!assignments_teacher_id_fkey(first_name, last_name)',
    )
    .eq('student_id', user.id)
    .order('sent_at', { ascending: false, nullsFirst: false })

  const items = (rows ?? []) as unknown as StudentAssignmentRow[]
  return <StudentAssignments items={items} />
}
