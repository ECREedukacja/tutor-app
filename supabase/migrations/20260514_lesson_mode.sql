-- Moduł 2.A — uzupełnienie: forma lekcji (online / stacjonarnie).
-- Stacjonarna lekcja odbywa się pod adresem nauczyciela z profiles.address.
-- Domyślna wartość = 'online', więc istniejące lekcje nie wymagają backfillu.

CREATE TYPE public.lesson_mode AS ENUM ('online', 'in_person');

ALTER TABLE public.lessons
  ADD COLUMN mode public.lesson_mode NOT NULL DEFAULT 'online';

-- Aktualizujemy book_lesson o trzeci parametr (forma). Stara sygnatura
-- (uuid, uuid) staje się nieaktualna — droppujemy ją, żeby uniknąć
-- dwuznaczności po stronie PostgREST.
DROP FUNCTION IF EXISTS public.book_lesson(uuid, uuid);

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

  RETURN v_lesson_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.book_lesson(uuid, uuid, public.lesson_mode) TO authenticated;
