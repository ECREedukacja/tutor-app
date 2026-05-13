import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ProfileForm } from './profile-form'

export default async function ProfilePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name, phone, address, role')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/login')

  return (
    <ProfileForm
      initial={{
        first_name: profile.first_name,
        last_name: profile.last_name,
        phone: profile.phone,
        address: profile.address,
        role: profile.role,
      }}
      email={user.email ?? ''}
    />
  )
}
