'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export async function updateProfile(form: {
  first_name: string
  last_name: string
  phone: string
  address: string
}): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Nie jesteś zalogowany.')

  const firstName = form.first_name.trim()
  const lastName = form.last_name.trim()
  if (firstName.length === 0) throw new Error('Imię jest wymagane.')
  if (lastName.length === 0) throw new Error('Nazwisko jest wymagane.')
  if (firstName.length > 80) throw new Error('Imię jest za długie.')
  if (lastName.length > 80) throw new Error('Nazwisko jest za długie.')

  const phone = form.phone.trim()
  if (phone.length > 40) throw new Error('Numer telefonu jest za długi.')

  const address = form.address.trim()
  if (address.length > 200) throw new Error('Adres jest za długi (max 200 znaków).')

  // Sprawdzamy rolę, żeby nie pisać adresu uczniowi (gdyby ktoś podstawił JSON).
  const { data: me } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  const updates: Record<string, string | null> = {
    first_name: firstName,
    last_name: lastName,
    phone: phone.length > 0 ? phone : null,
  }
  if (me?.role === 'teacher') {
    updates.address = address.length > 0 ? address : null
  }

  const { error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', user.id)
  if (error) throw new Error(error.message)

  // Layout pokazuje first_name w pasku — wymuszamy odświeżenie.
  revalidatePath('/dashboard', 'layout')
}
