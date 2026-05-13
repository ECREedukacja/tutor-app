'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

type Role = 'student' | 'teacher'

export function DashboardNav({
  role,
  pendingCount,
  proposalsPending,
}: {
  role: Role
  pendingCount: number
  proposalsPending: number
}) {
  const pathname = usePathname()

  const links: { href: string; label: string; badge?: number }[] = [
    { href: '/dashboard', label: 'Dashboard' },
    {
      href: '/dashboard/schedule',
      label: 'Terminarz',
      badge: proposalsPending,
    },
  ]
  if (role === 'student') {
    links.push({ href: '/dashboard/teachers', label: 'Moi nauczyciele' })
  } else {
    links.push({
      href: '/dashboard/students',
      label: 'Moi uczniowie',
      badge: pendingCount,
    })
  }
  links.push({ href: '/dashboard/profile', label: 'Mój profil' })

  return (
    <nav className="border-t border-slate-100">
      <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4">
        {links.map((l) => {
          const active =
            l.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(l.href)
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`relative whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition ${
                active
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {l.label}
              {l.badge && l.badge > 0 ? (
                <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
                  {l.badge}
                </span>
              ) : null}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
