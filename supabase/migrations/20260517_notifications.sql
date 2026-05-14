-- Moduł 1.3: powiadomienia in-app.
--
-- Centralna tabela `notifications` + trigger-pipeline generujący wpisy przy
-- kluczowych zdarzeniach (prośba, propozycja, lekcja, cykl). Powiadomienia
-- są wyłącznie in-app — bez e-maili — i podlegają realtime (UI ma toasty
-- i dzwoneczek z licznikiem nieprzeczytanych).
--
-- Pliki migracji wcześniejsze niż ten:
--   • 20260516_recurring_lessons.sql — wprowadziło recurring_lessons + funkcje.
-- W tej migracji rozszerzamy `lessons` o kolumnę `source` (ustawianą przez
-- triggery propozycji i generator cyklu), żeby odróżnić źródło pojawienia się
-- lekcji i poprawnie kierować powiadomienia.

-- ============================================================================
-- lessons.source — z czego pochodzi lekcja
-- ============================================================================

ALTER TABLE public.lessons
  ADD COLUMN source text NOT NULL DEFAULT 'direct'
    CHECK (source IN ('direct', 'proposal', 'recurring'));

CREATE INDEX lessons_source_idx ON public.lessons (source);

-- Redefinicja handle_proposal_response — ustawia source='proposal' przy
-- automatycznym INSERT po akceptacji propozycji.
CREATE OR REPLACE FUNCTION public.handle_proposal_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.responded_at := now();
    IF NEW.status = 'accepted' THEN
      IF NEW.kind = 'new_lesson' THEN
        INSERT INTO public.lessons (
          teacher_id, student_id, start_at, duration_minutes, mode, source
        ) VALUES (
          NEW.teacher_id, NEW.student_id, NEW.start_at,
          NEW.duration_minutes, NEW.mode, 'proposal'
        );
      ELSE -- reschedule
        UPDATE public.lessons
        SET start_at         = NEW.start_at,
            duration_minutes = NEW.duration_minutes,
            mode             = NEW.mode
        WHERE id = NEW.original_lesson_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Redefinicja generate_recurring_lessons — ustawia source='recurring' na
-- wstawianych lekcjach. Pozostała logika identyczna jak w migracji recurring.
CREATE OR REPLACE FUNCTION public.generate_recurring_lessons(
  p_recurring_id uuid,
  p_until        date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rec      public.recurring_lessons%ROWTYPE;
  v_limit    date;
  v_date     date;
  v_start    timestamptz;
  v_today    date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_now      timestamptz := now();
  v_count    integer := 0;
  v_conflict boolean;
BEGIN
  SELECT * INTO v_rec FROM public.recurring_lessons WHERE id = p_recurring_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cykl nie istnieje.';
  END IF;
  IF v_rec.cancelled THEN
    RETURN 0;
  END IF;

  v_limit := CASE
    WHEN v_rec.ends_on IS NULL THEN p_until
    ELSE LEAST(v_rec.ends_on, p_until)
  END;

  v_date := v_rec.starts_on;
  WHILE EXTRACT(DOW FROM v_date)::int <> v_rec.day_of_week LOOP
    v_date := v_date + 1;
  END LOOP;

  WHILE v_date <= v_limit LOOP
    IF v_date >= v_today THEN
      v_start := (v_date::timestamp + v_rec.time_of_day) AT TIME ZONE 'Europe/Warsaw';

      SELECT EXISTS (
        SELECT 1 FROM public.lessons
        WHERE teacher_id = v_rec.teacher_id
          AND start_at  = v_start
          AND status   <> 'cancelled'
      ) INTO v_conflict;

      IF NOT v_conflict AND v_start > v_now THEN
        INSERT INTO public.lessons (
          teacher_id, student_id, start_at, duration_minutes, mode,
          recurring_lesson_id, source
        ) VALUES (
          v_rec.teacher_id, v_rec.student_id, v_start,
          v_rec.duration_minutes, v_rec.mode, v_rec.id, 'recurring'
        );
        v_count := v_count + 1;
      END IF;
    END IF;
    v_date := v_date + 7;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ============================================================================
-- Enum typu powiadomienia
-- ============================================================================

CREATE TYPE public.notification_type AS ENUM (
  'request_received',
  'request_accepted',
  'request_rejected',
  'lesson_proposal_received',
  'lesson_proposal_accepted',
  'lesson_proposal_rejected',
  'lesson_proposal_cancelled',
  'lesson_cancelled',
  'lesson_scheduled',
  'lesson_rescheduled',
  'recurring_series_cancelled',
  'lesson_reminder'
);

-- ============================================================================
-- Tabela notifications
-- ============================================================================

CREATE TABLE public.notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type                public.notification_type NOT NULL,
  title               text NOT NULL,
  body                text,
  related_user_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  related_lesson_id   uuid REFERENCES public.lessons(id) ON DELETE SET NULL,
  related_proposal_id uuid REFERENCES public.lesson_proposals(id) ON DELETE SET NULL,
  related_request_id  uuid REFERENCES public.student_teacher_requests(id) ON DELETE SET NULL,
  link                text,
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Sortowanie nieprzeczytanych pierwszych, potem chronologicznie.
CREATE INDEX notifications_user_unread_idx
  ON public.notifications (user_id, read_at NULLS FIRST, created_at DESC);

CREATE INDEX notifications_user_created_idx
  ON public.notifications (user_id, created_at DESC);

-- Pomocniczy indeks dla idempotencji przypomnień.
CREATE INDEX notifications_lesson_type_idx
  ON public.notifications (related_lesson_id, type)
  WHERE related_lesson_id IS NOT NULL;

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Użytkownik czyta tylko swoje powiadomienia.
CREATE POLICY "Users read own notifications"
  ON public.notifications FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Użytkownik aktualizuje tylko swoje (oznaczanie jako przeczytane).
CREATE POLICY "Users update own notifications"
  ON public.notifications FOR UPDATE
  TO authenticated
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Brak polityki INSERT — wpisy tworzą wyłącznie triggery (SECURITY DEFINER).

-- ============================================================================
-- create_notification — pomocnicza funkcja do INSERT-u z poziomu triggerów
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_notification(
  p_user_id             uuid,
  p_type                public.notification_type,
  p_title               text,
  p_body                text,
  p_related_user_id     uuid,
  p_related_lesson_id   uuid,
  p_related_proposal_id uuid,
  p_related_request_id  uuid,
  p_link                text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.notifications (
    user_id, type, title, body,
    related_user_id, related_lesson_id, related_proposal_id, related_request_id,
    link
  ) VALUES (
    p_user_id, p_type, p_title, p_body,
    p_related_user_id, p_related_lesson_id, p_related_proposal_id, p_related_request_id,
    p_link
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Pomocnicze: zbuduj „Imię Nazwisko" lub fallback „Użytkownik".
CREATE OR REPLACE FUNCTION public.notif_display_name(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_first text;
  v_last  text;
BEGIN
  SELECT first_name, last_name INTO v_first, v_last
    FROM public.profiles WHERE id = p_user_id;
  IF v_first IS NULL THEN RETURN 'Użytkownik'; END IF;
  RETURN trim(concat_ws(' ', v_first, v_last));
END;
$$;

-- ============================================================================
-- Trigger a) prośby — INSERT
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_request_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM public.create_notification(
      NEW.teacher_id,
      'request_received',
      'Nowa prośba o powiązanie',
      public.notif_display_name(NEW.student_id) || ' prosi o powiązanie jako uczeń.',
      NEW.student_id,
      NULL, NULL, NEW.id,
      '/dashboard/students'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_request_received
  AFTER INSERT ON public.student_teacher_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_request_received();

-- ============================================================================
-- Trigger b) prośby — UPDATE statusu
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_request_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_teacher text := public.notif_display_name(NEW.teacher_id);
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'accepted' THEN
    PERFORM public.create_notification(
      NEW.student_id,
      'request_accepted',
      'Prośba zaakceptowana',
      v_teacher || ' zaakceptował(a) Twoją prośbę o powiązanie.',
      NEW.teacher_id, NULL, NULL, NEW.id,
      '/dashboard/teachers'
    );
  ELSIF NEW.status = 'rejected' THEN
    PERFORM public.create_notification(
      NEW.student_id,
      'request_rejected',
      'Prośba odrzucona',
      v_teacher || ' odrzucił(a) Twoją prośbę o powiązanie.',
      NEW.teacher_id, NULL, NULL, NEW.id,
      '/dashboard/teachers'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_request_response
  AFTER UPDATE OF status ON public.student_teacher_requests
  FOR EACH ROW EXECUTE FUNCTION public.notify_request_response();

-- ============================================================================
-- Trigger c) lesson_proposals — INSERT (nowa propozycja)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_proposal_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient uuid;
  v_proposer  text := public.notif_display_name(NEW.proposer_id);
  v_title     text;
  v_body      text;
BEGIN
  -- Druga strona = ta, której proposer != NEW.proposer_id.
  v_recipient := CASE
    WHEN NEW.proposer_id = NEW.teacher_id THEN NEW.student_id
    ELSE NEW.teacher_id
  END;

  IF NEW.kind = 'new_lesson' THEN
    v_title := 'Nowa propozycja lekcji';
    v_body  := v_proposer || ' proponuje nową lekcję.';
  ELSE
    v_title := 'Propozycja zmiany terminu';
    v_body  := v_proposer || ' proponuje przeniesienie lekcji.';
  END IF;

  PERFORM public.create_notification(
    v_recipient,
    'lesson_proposal_received',
    v_title, v_body,
    NEW.proposer_id, NEW.original_lesson_id, NEW.id, NULL,
    '/dashboard/schedule'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_proposal_received
  AFTER INSERT ON public.lesson_proposals
  FOR EACH ROW EXECUTE FUNCTION public.notify_proposal_received();

-- ============================================================================
-- Trigger d) lesson_proposals — UPDATE statusu
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_proposal_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_other     uuid;
  v_responder text;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  v_other := CASE
    WHEN NEW.proposer_id = NEW.teacher_id THEN NEW.student_id
    ELSE NEW.teacher_id
  END;
  v_responder := public.notif_display_name(v_other);

  IF NEW.status = 'accepted' THEN
    PERFORM public.create_notification(
      NEW.proposer_id,
      'lesson_proposal_accepted',
      'Propozycja zaakceptowana',
      v_responder || ' zaakceptował(a) Twoją propozycję lekcji.',
      v_other, NULL, NEW.id, NULL,
      '/dashboard/schedule'
    );
  ELSIF NEW.status = 'rejected' THEN
    PERFORM public.create_notification(
      NEW.proposer_id,
      'lesson_proposal_rejected',
      'Propozycja odrzucona',
      v_responder || ' odrzucił(a) Twoją propozycję lekcji.',
      v_other, NULL, NEW.id, NULL,
      '/dashboard/schedule'
    );
  ELSIF NEW.status = 'cancelled' THEN
    -- Propozycję anuluje proposer → powiadamiamy drugą stronę.
    PERFORM public.create_notification(
      v_other,
      'lesson_proposal_cancelled',
      'Propozycja wycofana',
      public.notif_display_name(NEW.proposer_id) ||
        ' wycofał(a) swoją propozycję lekcji.',
      NEW.proposer_id, NULL, NEW.id, NULL,
      '/dashboard/schedule'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_proposal_response
  AFTER UPDATE OF status ON public.lesson_proposals
  FOR EACH ROW EXECUTE FUNCTION public.notify_proposal_response();

-- ============================================================================
-- Trigger e) lessons — INSERT bezpośredni / pierwsza lekcja cyklu
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_lesson_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_other_count   integer;
  v_teacher_name  text;
  v_dow           integer;
  v_dow_label     text;
  v_time_label    text;
BEGIN
  -- 1) source='direct' → nauczyciel zaplanował lekcję bezpośrednio dla ucznia.
  --    Booking przez ucznia (book_lesson RPC) też ma source='direct', ale tam
  --    auth.uid() = student_id; nie chcemy wysyłać sobie powiadomienia, więc
  --    pomijamy gdy aktualny użytkownik to uczeń.
  IF NEW.source = 'direct' THEN
    IF auth.uid() IS DISTINCT FROM NEW.student_id THEN
      PERFORM public.create_notification(
        NEW.student_id,
        'lesson_scheduled',
        'Nowa lekcja w terminarzu',
        public.notif_display_name(NEW.teacher_id) ||
          ' zaplanował(a) dla Ciebie lekcję.',
        NEW.teacher_id, NEW.id, NULL, NULL,
        '/dashboard/schedule'
      );
    END IF;

  -- 2) source='recurring' → generator cyklu. Powiadamiamy ucznia raz przy
  --    pierwszej lekcji nowego cyklu.
  ELSIF NEW.source = 'recurring' AND NEW.recurring_lesson_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_other_count
      FROM public.lessons
      WHERE recurring_lesson_id = NEW.recurring_lesson_id
        AND id <> NEW.id;
    IF v_other_count = 0 THEN
      v_teacher_name := public.notif_display_name(NEW.teacher_id);
      SELECT day_of_week INTO v_dow
        FROM public.recurring_lessons WHERE id = NEW.recurring_lesson_id;
      v_dow_label := CASE v_dow
        WHEN 0 THEN 'niedzielę'
        WHEN 1 THEN 'poniedziałek'
        WHEN 2 THEN 'wtorek'
        WHEN 3 THEN 'środę'
        WHEN 4 THEN 'czwartek'
        WHEN 5 THEN 'piątek'
        WHEN 6 THEN 'sobotę'
        ELSE '?' END;
      v_time_label := to_char(NEW.start_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI');
      PERFORM public.create_notification(
        NEW.student_id,
        'lesson_scheduled',
        'Nowy cykl lekcji',
        v_teacher_name || ' utworzył(a) cykliczne lekcje co ' ||
          v_dow_label || ' o ' || v_time_label || '.',
        NEW.teacher_id, NEW.id, NULL, NULL,
        '/dashboard/schedule'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_lesson_created
  AFTER INSERT ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION public.notify_lesson_created();

-- ============================================================================
-- Trigger f) lessons — UPDATE (odwołanie / przeniesienie)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_lesson_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient uuid;
  v_actor     uuid;
  v_actor_name text;
BEGIN
  -- Pomiń aktualizacje wywołane przez inny trigger (np. handle_proposal_response
  -- po akceptacji propozycji rescheduli — powiadomienie generuje już trigger
  -- akceptacji). pg_trigger_depth() > 1 oznacza zagnieżdżenie.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Odwołanie lekcji (scheduled → cancelled)
  IF NEW.status = 'cancelled' AND OLD.status = 'scheduled' THEN
    v_actor := COALESCE(NEW.cancelled_by, auth.uid());
    v_recipient := CASE
      WHEN v_actor = NEW.teacher_id THEN NEW.student_id
      ELSE NEW.teacher_id
    END;
    v_actor_name := public.notif_display_name(v_actor);
    PERFORM public.create_notification(
      v_recipient,
      'lesson_cancelled',
      'Lekcja odwołana',
      v_actor_name || ' odwołał(a) lekcję.',
      v_actor, NEW.id, NULL, NULL,
      '/dashboard/schedule'
    );
    RETURN NEW;
  END IF;

  -- Przeniesienie (bezpośrednio przez nauczyciela): zmiana start_at bez
  -- zmiany statusu. auth.uid() = nauczyciel; uczeń = odbiorca.
  IF NEW.start_at IS DISTINCT FROM OLD.start_at
     AND NEW.status = OLD.status THEN
    v_actor := COALESCE(auth.uid(), NEW.teacher_id);
    v_recipient := CASE
      WHEN v_actor = NEW.teacher_id THEN NEW.student_id
      ELSE NEW.teacher_id
    END;
    v_actor_name := public.notif_display_name(v_actor);
    PERFORM public.create_notification(
      v_recipient,
      'lesson_rescheduled',
      'Lekcja przeniesiona',
      v_actor_name || ' przeniósł(-a) lekcję na inny termin.',
      v_actor, NEW.id, NULL, NULL,
      '/dashboard/schedule'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_lesson_updated
  AFTER UPDATE ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION public.notify_lesson_updated();

-- ============================================================================
-- Trigger g) recurring_lessons — koniec cyklu
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_recurring_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_should_notify boolean := false;
BEGIN
  -- Cały cykl zakończony.
  IF NEW.cancelled = true AND OLD.cancelled = false THEN
    v_should_notify := true;
  -- Cykl skrócony tak, że ends_on wpada w przeszłość lub dziś.
  ELSIF NEW.ends_on IS NOT NULL
        AND OLD.ends_on IS DISTINCT FROM NEW.ends_on
        AND NEW.ends_on <= v_today THEN
    v_should_notify := true;
  END IF;

  IF v_should_notify THEN
    PERFORM public.create_notification(
      NEW.student_id,
      'recurring_series_cancelled',
      'Cykl lekcji zakończony',
      public.notif_display_name(NEW.teacher_id) ||
        ' zakończył(a) cykl cotygodniowych lekcji.',
      NEW.teacher_id, NULL, NULL, NULL,
      '/dashboard/schedule'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_recurring_cancelled
  AFTER UPDATE ON public.recurring_lessons
  FOR EACH ROW EXECUTE FUNCTION public.notify_recurring_cancelled();

-- ============================================================================
-- create_lesson_reminders — 1h przed lekcją
--
-- Pobiera lekcje, których start_at mieści się w oknie [now+59min, now+61min],
-- i tworzy parę powiadomień (nauczyciel + uczeń) — o ile nie istnieją jeszcze
-- dla tej lekcji (idempotencja po related_lesson_id + type='lesson_reminder').
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_lesson_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lesson record;
  v_count integer := 0;
  v_time_label text;
BEGIN
  FOR v_lesson IN
    SELECT id, teacher_id, student_id, start_at
    FROM public.lessons
    WHERE status = 'scheduled'
      AND start_at BETWEEN now() + interval '59 minutes'
                       AND now() + interval '61 minutes'
  LOOP
    v_time_label := to_char(
      v_lesson.start_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI'
    );

    -- Nauczyciel
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications
      WHERE user_id = v_lesson.teacher_id
        AND related_lesson_id = v_lesson.id
        AND type = 'lesson_reminder'
    ) THEN
      PERFORM public.create_notification(
        v_lesson.teacher_id,
        'lesson_reminder',
        'Lekcja za godzinę',
        'O ' || v_time_label || ' masz lekcję z ' ||
          public.notif_display_name(v_lesson.student_id) || '.',
        v_lesson.student_id, v_lesson.id, NULL, NULL,
        '/dashboard/schedule'
      );
      v_count := v_count + 1;
    END IF;

    -- Uczeń
    IF NOT EXISTS (
      SELECT 1 FROM public.notifications
      WHERE user_id = v_lesson.student_id
        AND related_lesson_id = v_lesson.id
        AND type = 'lesson_reminder'
    ) THEN
      PERFORM public.create_notification(
        v_lesson.student_id,
        'lesson_reminder',
        'Lekcja za godzinę',
        'O ' || v_time_label || ' masz lekcję z ' ||
          public.notif_display_name(v_lesson.teacher_id) || '.',
        v_lesson.teacher_id, v_lesson.id, NULL, NULL,
        '/dashboard/schedule'
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_lesson_reminders() TO authenticated;

-- ============================================================================
-- pg_cron — harmonogram co minutę
--
-- UWAGA: pg_cron wymaga rozszerzenia (Supabase: Dashboard → Database →
-- Extensions → włącz pg_cron). Na free tier rozszerzenie zwykle jest
-- dostępne; jeśli nie — patrz fallback w README/komentarzu poniżej.
-- DO-block łapie wyjątek, żeby migracja nie wybuchła, gdy extension jest
-- niedostępne; w takim przypadku użytkownik musi włączyć harmonogram
-- alternatywnym sposobem.
-- ============================================================================

DO $cron$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE
      'pg_cron niedostępne — przypomnienia o lekcji uruchom przez Vercel Cron + Edge Function (POST do /rest/v1/rpc/create_lesson_reminders co minutę).';
    RETURN;
  END;

  -- Idempotencja: jeśli wpis o tej samej nazwie istnieje, najpierw go usuń.
  BEGIN
    PERFORM cron.unschedule('lesson_reminders');
  EXCEPTION WHEN OTHERS THEN
    -- ignorujemy — wpis mógł nie istnieć
    NULL;
  END;

  PERFORM cron.schedule(
    'lesson_reminders',
    '* * * * *',
    $job$ SELECT public.create_lesson_reminders(); $job$
  );
END $cron$;

-- ============================================================================
-- Realtime
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
