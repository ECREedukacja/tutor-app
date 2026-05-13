import type { LessonMode } from '@/lib/calendar'

export type ProposalKind = 'new_lesson' | 'reschedule'
export type ProposalStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired'

export type ProposalLesson = {
  start_at: string
  mode: LessonMode
}

export type Proposal = {
  id: string
  kind: ProposalKind
  teacher_id: string
  student_id: string
  proposer_id: string
  original_lesson_id: string | null
  start_at: string
  duration_minutes: number
  mode: LessonMode
  status: ProposalStatus
  created_at: string
  original_lesson: ProposalLesson | null
}
