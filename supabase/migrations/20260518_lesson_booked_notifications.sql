-- Moduł 1.3 — uzupełnienie: powiadomienie nauczyciela o zapisie ucznia
-- na wolny termin.
--
-- Kontekst: book_lesson() (RPC) wstawia lekcję z domyślnym source='direct'.
-- W triggerze notify_lesson_created świadomie pomijamy notyfikacje, gdy
-- auth.uid() = NEW.student_id (czyli to uczeń sam się zapisuje) — dlatego
-- nauczyciel dotąd nic nie dostawał. Teraz dokładamy jawne
-- create_notification() bezpośrednio w book_lesson(), z nowym typem
-- 'lesson_booked' (żeby UI mógł odróżnić zapis ucznia od umówienia przez
-- nauczyciela).
--
-- Drugą stronę (uczeń odwołuje lekcję) obsługuje już istniejący trigger
-- notify_lesson_updated:
--   cancelled_by = student_id → v_actor = student_id → v_recipient = teacher_id.
-- Czyli nauczyciel automatycznie dostaje 'lesson_cancelled'. Tu tylko
-- dopracowujemy tekst powiadomienia, żeby zawierał datę/godzinę.

-- ============================================================================
-- 1) Nowa wartość enum notification_type
--
-- ALTER TYPE ... ADD VALUE działa od PG 12 wewnątrz transakcji, ale wartości
-- nie można jeszcze użyć w tej samej transakcji. Funkcje plpgsql odwołują
-- się do enum-ów leniwie (przy CALL-u, nie przy CREATE), więc redefinicja
-- book_lesson() poniżej jest bezpieczna — funkcja zostanie pierwszy raz
-- wywołana już po commit-cie tej migracji.
-- ============================================================================

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'lesson_booked';

-- ============================================================================
-- 2) Redefinicja book_lesson — bez zmiany sygnatury.
-- Cała logika identyczna jak w 20260514_lesson_mode.sql; tylko po INSERT do
-- lessons + DELETE z availability dokładamy create_notification dla
-- nauczyciela.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.book_lesson(
  p_availability_id uuid,
  p_student_id      uuid,
  p_mode            public.lesson_mode DEFAULT 'online'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_availability public.availability%ROWTYPE;
  v_link_exists  boolean;
  v_lesson_id    uuid;
  v_date_label   text;
  v_time_label   text;
BEGIN
  IF auth.uid() IS DISTINCT FROM p_student_id THEN
    RAISE EXCEPTION 'Nie możesz zapisać innego użytkownika.';
  END IF;

  SELECT * INTO v_availability
  FROM public.availability
  WHERE id = p_availability_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Termin nie istnieje lub został właśnie zajęty.';
  END IF;

  IF v_availability.start_at <= now() THEN
    RAISE EXCEPTION 'Termin już minął.';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.teacher_students
    WHERE teacher_id = v_availability.teacher_id
      AND student_id = p_student_id
  ) INTO v_link_exists;
  IF NOT v_link_exists THEN
    RAISE EXCEPTION 'Brak aktywnego powiązania z tym nauczycielem.';
  END IF;

  INSERT INTO public.lessons (
    teacher_id, student_id, start_at, duration_minutes, availability_id, mode
  ) VALUES (
    v_availability.teacher_id,
    p_student_id,
    v_availability.start_at,
    v_availability.duration_minutes,
    v_availability.id,
    p_mode
  ) RETURNING id INTO v_lesson_id;

  DELETE FROM public.availability WHERE id = p_availability_id;

  -- Powiadomienie dla nauczyciela. Format daty/godziny w strefie PL.
  v_date_label := to_char(
    v_availability.start_at AT TIME ZONE 'Europe/Warsaw', 'DD.MM.YYYY'
  );
  v_time_label := to_char(
    v_availability.start_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI'
  );

  PERFORM public.create_notification(
    v_availability.teacher_id,
    'lesson_booked',
    'Nowy zapis na lekcję',
    public.notif_display_name(p_student_id) || ' zapisał(a) się na ' ||
      v_date_label || ' o ' || v_time_label || '.',
    p_student_id,
    v_lesson_id,
    NULL,
    NULL,
    '/dashboard/schedule'
  );

  RETURN v_lesson_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.book_lesson(uuid, uuid, public.lesson_mode) TO authenticated;

-- ============================================================================
-- 3) Doprecyzowanie tekstu powiadomienia „lesson_cancelled" — dokładamy datę
-- i godzinę odwoływanej lekcji. Reszta logiki triggera bez zmian.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_lesson_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient   uuid;
  v_actor       uuid;
  v_actor_name  text;
  v_date_label  text;
  v_time_label  text;
  v_actor_role  text;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  v_date_label := to_char(NEW.start_at AT TIME ZONE 'Europe/Warsaw', 'DD.MM.YYYY');
  v_time_label := to_char(NEW.start_at AT TIME ZONE 'Europe/Warsaw', 'HH24:MI');

  -- Odwołanie lekcji (scheduled → cancelled)
  IF NEW.status = 'cancelled' AND OLD.status = 'scheduled' THEN
    v_actor := COALESCE(NEW.cancelled_by, auth.uid());
    v_recipient := CASE
      WHEN v_actor = NEW.teacher_id THEN NEW.student_id
      ELSE NEW.teacher_id
    END;
    v_actor_name := public.notif_display_name(v_actor);
    v_actor_role := CASE
      WHEN v_actor = NEW.student_id THEN 'Uczeń odwołał lekcję'
      ELSE 'Lekcja odwołana'
    END;
    PERFORM public.create_notification(
      v_recipient,
      'lesson_cancelled',
      v_actor_role,
      v_actor_name || ' odwołał(a) lekcję ' || v_date_label ||
        ' o ' || v_time_label || '.',
      v_actor, NEW.id, NULL, NULL,
      '/dashboard/schedule'
    );
    RETURN NEW;
  END IF;

  -- Przeniesienie (bezpośrednio): zmiana start_at bez zmiany statusu.
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
      v_actor_name || ' przeniósł(-a) lekcję na ' || v_date_label ||
        ' o ' || v_time_label || '.',
      v_actor, NEW.id, NULL, NULL,
      '/dashboard/schedule'
    );
  END IF;
  RETURN NEW;
END;
$$;
