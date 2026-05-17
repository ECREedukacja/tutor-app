-- Moduł 2: chat pisemny 1-na-1 z plikami.
--
-- Architektura:
--   • conversations — para nauczyciel+uczeń (UNIQUE), wymaga aktywnego
--     powiązania w teacher_students. last_message_at sortuje listę po lewej.
--   • messages — wiadomości (tekst, plik lub oba), read_at z RPC.
--
-- Powiadomienia: rozszerzamy notification_type o 'new_message', trigger po
-- INSERT do messages. Frontend zdecyduje czy pokazać toast/dźwięk (ignoruje
-- gdy użytkownik jest aktualnie na /dashboard/chat).
--
-- Pliki: bucket 'chat-files' (private). Polityki na storage.objects niżej.

-- ============================================================================
-- 1) Enum: rozszerzenie notification_type
-- ============================================================================

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'new_message';

-- ============================================================================
-- 2) Tabele
-- ============================================================================

CREATE TABLE public.conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, student_id)
);

CREATE INDEX conversations_teacher_idx
  ON public.conversations (teacher_id, last_message_at DESC);

CREATE INDEX conversations_student_idx
  ON public.conversations (student_id, last_message_at DESC);

CREATE TABLE public.messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content         text,
  file_url        text,
  file_name       text,
  file_size       integer,
  file_type       text,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Musi być content LUB plik (lub oba).
  CONSTRAINT messages_content_or_file CHECK (
    (content IS NOT NULL AND length(trim(content)) > 0)
    OR file_url IS NOT NULL
  )
);

CREATE INDEX messages_conversation_created_idx
  ON public.messages (conversation_id, created_at);

CREATE INDEX messages_sender_idx
  ON public.messages (sender_id);

CREATE INDEX messages_unread_idx
  ON public.messages (conversation_id, sender_id)
  WHERE read_at IS NULL;

-- ============================================================================
-- 3) Walidacja: powiązanie nauczyciel-uczeń przy tworzeniu konwersacji
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_conversation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_teacher_role public.user_role;
  v_student_role public.user_role;
  v_link_exists  boolean;
BEGIN
  SELECT role INTO v_teacher_role FROM public.profiles WHERE id = NEW.teacher_id;
  IF v_teacher_role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'teacher_id musi wskazywać na profil z rolą teacher.';
  END IF;

  SELECT role INTO v_student_role FROM public.profiles WHERE id = NEW.student_id;
  IF v_student_role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'student_id musi wskazywać na profil z rolą student.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.teacher_students
    WHERE teacher_id = NEW.teacher_id AND student_id = NEW.student_id
  ) INTO v_link_exists;
  IF NOT v_link_exists THEN
    RAISE EXCEPTION 'Brak aktywnego powiązania nauczyciel-uczeń.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_validate
  BEFORE INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.validate_conversation();

-- ============================================================================
-- 4) Walidacja: sender musi być stroną konwersacji
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_teacher_id uuid;
  v_student_id uuid;
BEGIN
  SELECT teacher_id, student_id INTO v_teacher_id, v_student_id
    FROM public.conversations WHERE id = NEW.conversation_id;
  IF v_teacher_id IS NULL THEN
    RAISE EXCEPTION 'Konwersacja nie istnieje.';
  END IF;
  IF NEW.sender_id NOT IN (v_teacher_id, v_student_id) THEN
    RAISE EXCEPTION 'sender_id musi być stroną tej konwersacji.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_validate
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.validate_message();

-- ============================================================================
-- 5) Trigger po INSERT messages: aktualizuj last_message_at + notyfikacja
-- ============================================================================

CREATE OR REPLACE FUNCTION public.on_new_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_teacher_id uuid;
  v_student_id uuid;
  v_recipient  uuid;
  v_sender_name text;
  v_body       text;
BEGIN
  SELECT teacher_id, student_id INTO v_teacher_id, v_student_id
    FROM public.conversations WHERE id = NEW.conversation_id;

  -- Aktualizacja czasu ostatniej wiadomości (do sortowania listy).
  UPDATE public.conversations
     SET last_message_at = NEW.created_at
   WHERE id = NEW.conversation_id;

  -- Powiadomienie dla drugiej strony. Frontend zdecyduje, czy
  -- zatuszować toast/dźwięk (gdy odbiorca jest na ekranie czatu).
  v_recipient := CASE
    WHEN NEW.sender_id = v_teacher_id THEN v_student_id
    ELSE v_teacher_id
  END;
  v_sender_name := public.notif_display_name(NEW.sender_id);

  v_body := CASE
    WHEN NEW.content IS NOT NULL AND length(trim(NEW.content)) > 0
      THEN left(NEW.content, 100)
    WHEN NEW.file_name IS NOT NULL
      THEN 'Wysłano plik: ' || NEW.file_name
    ELSE 'Nowa wiadomość'
  END;

  PERFORM public.create_notification(
    v_recipient,
    'new_message',
    'Nowa wiadomość od ' || v_sender_name,
    v_body,
    NEW.sender_id,
    NULL, NULL, NULL,
    '/dashboard/chat/' || NEW.conversation_id
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_after_insert
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.on_new_message();

-- ============================================================================
-- 6) Row Level Security
-- ============================================================================

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages      ENABLE ROW LEVEL SECURITY;

-- ---- conversations ----

CREATE POLICY "Users read own conversations"
  ON public.conversations FOR SELECT
  TO authenticated
  USING (auth.uid() = teacher_id OR auth.uid() = student_id);

CREATE POLICY "Users insert own conversations"
  ON public.conversations FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = teacher_id OR auth.uid() = student_id);

-- UPDATE/DELETE brak — last_message_at aktualizowane przez trigger
-- (SECURITY DEFINER w on_new_message obchodzi RLS), użytkownicy nie modyfikują
-- konwersacji bezpośrednio.

-- ---- messages ----

CREATE POLICY "Users read messages in own conversations"
  ON public.messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (c.teacher_id = auth.uid() OR c.student_id = auth.uid())
    )
  );

CREATE POLICY "Users send messages in own conversations"
  ON public.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (c.teacher_id = auth.uid() OR c.student_id = auth.uid())
    )
  );

-- UPDATE blokujemy z poziomu RLS — read_at ustawia tylko RPC mark_messages_read
-- (SECURITY DEFINER). Brak polityki UPDATE = brak dostępu.

-- ============================================================================
-- 7) RPC: get_or_create_conversation
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_or_create_conversation(p_other_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_me_role     public.user_role;
  v_other_role  public.user_role;
  v_teacher_id  uuid;
  v_student_id  uuid;
  v_link_exists boolean;
  v_id          uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Wymagane uwierzytelnienie.';
  END IF;
  IF p_other_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Nie można rozmawiać z samym sobą.';
  END IF;

  SELECT role INTO v_me_role    FROM public.profiles WHERE id = auth.uid();
  SELECT role INTO v_other_role FROM public.profiles WHERE id = p_other_user_id;

  IF v_me_role = 'teacher' AND v_other_role = 'student' THEN
    v_teacher_id := auth.uid();
    v_student_id := p_other_user_id;
  ELSIF v_me_role = 'student' AND v_other_role = 'teacher' THEN
    v_teacher_id := p_other_user_id;
    v_student_id := auth.uid();
  ELSE
    RAISE EXCEPTION 'Rozmowa wymaga pary nauczyciel + uczeń.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.teacher_students
    WHERE teacher_id = v_teacher_id AND student_id = v_student_id
  ) INTO v_link_exists;
  IF NOT v_link_exists THEN
    RAISE EXCEPTION 'Brak aktywnego powiązania nauczyciel-uczeń.';
  END IF;

  SELECT id INTO v_id FROM public.conversations
   WHERE teacher_id = v_teacher_id AND student_id = v_student_id;

  IF v_id IS NULL THEN
    INSERT INTO public.conversations (teacher_id, student_id)
    VALUES (v_teacher_id, v_student_id)
    RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_conversation(uuid) TO authenticated;

-- ============================================================================
-- 8) RPC: mark_messages_read
-- ============================================================================

CREATE OR REPLACE FUNCTION public.mark_messages_read(p_conversation_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_teacher_id uuid;
  v_student_id uuid;
  v_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Wymagane uwierzytelnienie.';
  END IF;

  SELECT teacher_id, student_id INTO v_teacher_id, v_student_id
    FROM public.conversations WHERE id = p_conversation_id;
  IF v_teacher_id IS NULL THEN
    RAISE EXCEPTION 'Konwersacja nie istnieje.';
  END IF;
  IF auth.uid() NOT IN (v_teacher_id, v_student_id) THEN
    RAISE EXCEPTION 'Brak dostępu do tej konwersacji.';
  END IF;

  UPDATE public.messages
     SET read_at = now()
   WHERE conversation_id = p_conversation_id
     AND sender_id <> auth.uid()
     AND read_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_messages_read(uuid) TO authenticated;

-- ============================================================================
-- 9) Realtime
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;

-- ============================================================================
-- 10) Storage: bucket 'chat-files'
--
-- UWAGA: tworzenie bucketu w SQL wymaga uprawnień do schematu storage —
-- pewniejsze jest utworzenie go w Supabase Dashboard (Storage → New bucket,
-- nazwa "chat-files", private). Poniższy INSERT jest idempotentny i NIE
-- powinien wybuchnąć, jeśli bucket już istnieje (ON CONFLICT DO NOTHING).
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-files', 'chat-files', false)
ON CONFLICT (id) DO NOTHING;

-- Policies na storage.objects — ścieżka pliku ma postać
--   {conversation_id}/{uuid}_{original_name}
-- czyli pierwszy segment ścieżki to UUID konwersacji.

-- SELECT: użytkownik widzi pliki z konwersacji których jest stroną.
DROP POLICY IF EXISTS "chat-files read own" ON storage.objects;
CREATE POLICY "chat-files read own"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-files'
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id::text = (storage.foldername(name))[1]
        AND (c.teacher_id = auth.uid() OR c.student_id = auth.uid())
    )
  );

-- INSERT: tylko gdy user jest stroną konwersacji do której uploaduje.
DROP POLICY IF EXISTS "chat-files insert own" ON storage.objects;
CREATE POLICY "chat-files insert own"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-files'
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id::text = (storage.foldername(name))[1]
        AND (c.teacher_id = auth.uid() OR c.student_id = auth.uid())
    )
  );

-- Brak polityki UPDATE / DELETE — pliki są immutowalne.
