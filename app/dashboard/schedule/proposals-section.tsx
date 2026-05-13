'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  addMinutes,
  formatDateLong,
  formatTime,
  modeIcon,
  modeLabel,
} from '@/lib/calendar'
import { cancelProposal, respondToProposal } from './actions'
import type { Proposal, ProposalStatus } from './types'

const statusLabel: Record<ProposalStatus, string> = {
  pending: 'Oczekuje',
  accepted: 'Zaakceptowana',
  rejected: 'Odrzucona',
  cancelled: 'Anulowana',
  expired: 'Wygasła',
}

const statusClass: Record<ProposalStatus, string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  accepted: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  rejected: 'bg-slate-100 text-slate-700 ring-slate-200',
  cancelled: 'bg-slate-100 text-slate-700 ring-slate-200',
  expired: 'bg-slate-100 text-slate-700 ring-slate-200',
}

export function ProposalsSection({
  myProposals,
  incomingProposals,
  teacherAddress,
  getCounterpartLabel,
}: {
  myProposals: Proposal[]
  incomingProposals: Proposal[]
  currentUserId: string
  teacherAddress: string | null
  getCounterpartLabel: (p: Proposal) => string
}) {
  const [openMy, setOpenMy] = useState(true)
  const [openInc, setOpenInc] = useState(true)

  if (myProposals.length === 0 && incomingProposals.length === 0) return null

  return (
    <div className="space-y-3">
      {incomingProposals.length > 0 && (
        <Section
          title="Propozycje do akceptacji"
          count={incomingProposals.length}
          open={openInc}
          onToggle={() => setOpenInc((v) => !v)}
        >
          <ul className="mt-3 space-y-2">
            {incomingProposals.map((p) => (
              <IncomingItem
                key={p.id}
                proposal={p}
                counterpart={getCounterpartLabel(p)}
                teacherAddress={teacherAddress}
              />
            ))}
          </ul>
        </Section>
      )}
      {myProposals.length > 0 && (
        <Section
          title="Moje propozycje"
          count={myProposals.length}
          open={openMy}
          onToggle={() => setOpenMy((v) => !v)}
        >
          <ul className="mt-3 space-y-2">
            {myProposals.map((p) => (
              <MyItem
                key={p.id}
                proposal={p}
                counterpart={getCounterpartLabel(p)}
                teacherAddress={teacherAddress}
              />
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:p-6">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between text-left"
      >
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
          {title}
          <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-700">
            {count}
          </span>
        </h2>
        <span className="text-sm text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && children}
    </div>
  )
}

function ProposalRow({
  proposal,
  counterpart,
  teacherAddress,
}: {
  proposal: Proposal
  counterpart: string
  teacherAddress: string | null
}) {
  const newDate = new Date(proposal.start_at)
  const old = proposal.original_lesson
    ? new Date(proposal.original_lesson.start_at)
    : null
  return (
    <div className="text-sm text-slate-900">
      <p className="font-medium">
        {proposal.kind === 'new_lesson' ? 'Nowa lekcja' : 'Zmiana terminu'} ·{' '}
        {counterpart}
      </p>
      {old && (
        <p className="mt-0.5 text-xs text-slate-500">
          Z: {formatDateLong(old)}, {formatTime(old)}
        </p>
      )}
      <p className="mt-0.5 text-xs text-slate-700">
        {proposal.kind === 'new_lesson' ? 'Termin: ' : 'Na: '}
        {formatDateLong(newDate)}, {formatTime(newDate)}–
        {formatTime(addMinutes(newDate, proposal.duration_minutes))}
      </p>
      <p className="mt-0.5 text-xs text-slate-700">
        Forma: {modeIcon(proposal.mode)} {modeLabel(proposal.mode)}
        {proposal.mode === 'in_person' && teacherAddress
          ? `: ${teacherAddress}`
          : ''}
      </p>
    </div>
  )
}

function IncomingItem({
  proposal,
  counterpart,
  teacherAddress,
}: {
  proposal: Proposal
  counterpart: string
  teacherAddress: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const respond = (accept: boolean) => {
    setError(null)
    startTransition(async () => {
      try {
        await respondToProposal(proposal.id, accept)
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Operacja nie powiodła się.')
      }
    })
  }

  return (
    <li className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <ProposalRow
          proposal={proposal}
          counterpart={counterpart}
          teacherAddress={teacherAddress}
        />
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => respond(true)}
              disabled={pending}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Akceptuj
            </button>
            <button
              type="button"
              onClick={() => respond(false)}
              disabled={pending}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Odrzuć
            </button>
          </div>
          {error && (
            <p className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}

function MyItem({
  proposal,
  counterpart,
  teacherAddress,
}: {
  proposal: Proposal
  counterpart: string
  teacherAddress: string | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const cancel = () => {
    setError(null)
    startTransition(async () => {
      try {
        await cancelProposal(proposal.id)
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Operacja nie powiodła się.')
      }
    })
  }

  return (
    <li className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <ProposalRow
          proposal={proposal}
          counterpart={counterpart}
          teacherAddress={teacherAddress}
        />
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <span
            className={`inline-flex shrink-0 items-center self-end rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${statusClass[proposal.status]}`}
          >
            {statusLabel[proposal.status]}
          </span>
          {proposal.status === 'pending' && (
            <button
              type="button"
              onClick={cancel}
              disabled={pending}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Anuluj
            </button>
          )}
          {error && (
            <p className="rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  )
}
