// Wspólne typy + helpery dla widoków czatu.

export type ConversationSummary = {
  id: string
  other_id: string
  other_name: string
  last_message_at: string
  last_message_preview: string | null
  unread_count: number
}

export type MessageRow = {
  id: string
  conversation_id: string
  sender_id: string
  content: string | null
  file_url: string | null
  file_name: string | null
  file_size: number | null
  file_type: string | null
  read_at: string | null
  created_at: string
}

export type FileItem = {
  message_id: string
  path: string
  name: string
  size: number | null
  type: string | null
  sender_id: string
  created_at: string
  signed_url: string | null
}

// Skraca podgląd wiadomości na liście konwersacji.
export function previewLine(m: {
  content: string | null
  file_name: string | null
} | null): string | null {
  if (!m) return null
  if (m.content && m.content.trim().length > 0) {
    const trimmed = m.content.trim().replace(/\s+/g, ' ')
    return trimmed.length > 50 ? trimmed.slice(0, 50) + '…' : trimmed
  }
  if (m.file_name) return '📎 ' + m.file_name
  return null
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function isImage(type: string | null | undefined): boolean {
  return !!type && type.startsWith('image/')
}

export function isPdf(type: string | null | undefined): boolean {
  return type === 'application/pdf'
}
