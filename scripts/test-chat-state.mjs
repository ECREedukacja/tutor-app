// KROK 1: Stan bazy — kto jest, kto jest powiązany, ile konwersacji już mamy.
// Service-role: pełny dostęp, omijamy RLS.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

console.log('━━━ Profile ━━━')
const { data: profiles, error: pErr } = await admin
  .from('profiles')
  .select('id, first_name, last_name, role')
  .order('role')
  .order('last_name')
if (pErr) {
  console.error('ERR:', pErr.message)
  process.exit(1)
}
for (const p of profiles ?? []) {
  console.log(
    `  ${p.role.padEnd(8)}  ${(p.first_name ?? '?') + ' ' + (p.last_name ?? '?')}`.padEnd(40) +
      `  ${p.id}`,
  )
}

console.log('\n━━━ Powiązania teacher_students ━━━')
const { data: links, error: lErr } = await admin
  .from('teacher_students')
  .select('teacher_id, student_id, created_at')
if (lErr) {
  console.error('ERR:', lErr.message)
  process.exit(1)
}
const byId = new Map((profiles ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`]))
for (const l of links ?? []) {
  console.log(`  ${byId.get(l.teacher_id) ?? '?'}  ⇄  ${byId.get(l.student_id) ?? '?'}`)
}

console.log('\n━━━ Istniejące konwersacje ━━━')
const { data: convs, error: cErr } = await admin
  .from('conversations')
  .select('id, teacher_id, student_id, last_message_at')
  .order('last_message_at', { ascending: false })
if (cErr) {
  console.error('ERR:', cErr.message)
  process.exit(1)
}
for (const c of convs ?? []) {
  console.log(
    `  ${c.id}  ${byId.get(c.teacher_id)} ↔ ${byId.get(c.student_id)}  last: ${c.last_message_at?.slice(0, 19) ?? '-'}`,
  )
}

console.log('\n━━━ Bucket chat-files ━━━')
const { data: buckets, error: bErr } = await admin.storage.listBuckets()
if (bErr) {
  console.error('ERR:', bErr.message)
} else {
  const b = buckets?.find((x) => x.name === 'chat-files')
  console.log(
    b
      ? `  ${b.name}  public=${b.public}  fileSizeLimit=${b.file_size_limit ?? '(brak)'}`
      : '  ❌ Bucket chat-files nie istnieje',
  )
}

console.log('\n━━━ Migracja czatu ━━━')
const { data: rpcs } = await admin.rpc('get_or_create_conversation', {
  p_other_user_id: '00000000-0000-0000-0000-000000000000',
})
console.log('  get_or_create_conversation odpowiada (z fake-id zwróci null lub error)')
console.log('  → result:', rpcs)
