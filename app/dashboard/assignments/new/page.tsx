import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AssignmentWizard } from './wizard'

export const dynamic = 'force-dynamic'

export default async function NewAssignmentPage() {
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
  if (profile?.role !== 'teacher') redirect('/dashboard/assignments')

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
  const students = links.map((l) => ({
    id: l.student_id,
    first_name: l.student?.first_name ?? '',
    last_name: l.student?.last_name ?? '',
  }))

  if (students.length === 0) {
    redirect('/dashboard/assignments')
  }

  return <AssignmentWizard students={students} />
}
