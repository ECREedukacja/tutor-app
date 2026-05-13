import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TeacherSchedule } from './teacher-schedule'
import { StudentSchedule, type TeacherInfo } from './student-schedule'

export default async function SchedulePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, address')
    .eq('id', user.id)
    .single()

  if (profile?.role === 'teacher') {
    type TLink = {
      student_id: string
      student: { first_name: string; last_name: string } | null
    }
    const { data: tStudentsRaw } = await supabase
      .from('teacher_students')
      .select(
        'student_id, student:profiles!teacher_students_student_id_fkey(first_name, last_name)',
      )
      .eq('teacher_id', user.id)
    const tStudents = (tStudentsRaw ?? []) as unknown as TLink[]

    return (
      <TeacherSchedule
        teacherId={user.id}
        teacherAddress={profile.address ?? null}
        students={tStudents.map((s) => ({
          id: s.student_id,
          first_name: s.student?.first_name ?? '',
          last_name: s.student?.last_name ?? '',
        }))}
      />
    )
  }

  // Uczeń: musimy pobrać listę powiązanych nauczycieli, żeby przekazać do
  // klienta dane do legendy kolorów (kolor = hash(teacher_id)) oraz adres
  // potrzebny w modalu zapisu (wybór online / stacjonarnie).
  type LinkRow = {
    teacher_id: string
    teacher: { first_name: string; last_name: string; address: string | null } | null
  }
  const { data: linksRaw } = await supabase
    .from('teacher_students')
    .select(
      'teacher_id, teacher:profiles!teacher_students_teacher_id_fkey(first_name, last_name, address)',
    )
    .eq('student_id', user.id)

  const links = (linksRaw ?? []) as unknown as LinkRow[]
  const teachers: TeacherInfo[] = links.map((l) => ({
    id: l.teacher_id,
    first_name: l.teacher?.first_name ?? '',
    last_name: l.teacher?.last_name ?? '',
    address: l.teacher?.address ?? null,
  }))

  return <StudentSchedule studentId={user.id} teachers={teachers} />
}
