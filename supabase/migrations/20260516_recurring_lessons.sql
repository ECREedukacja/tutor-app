-- Moduł 1.3: cykliczne lekcje tygodniowe.
--
-- Cykl tworzy nauczyciel z konkretnym uczniem. Przy tworzeniu generujemy
-- N tygodni naprzód (parametryzowalnie), resztę można dogenerować ręcznie.
-- Edycja/usunięcie cyklu zawsze należy do nauczyciela:
--   • „tylko ten termin"   → zwykła operacja na pojedynczej lekcji
--   • „ten i przyszłe"     → cancel_recurring_series(...) od daty wybranej lekcji.
-- Uczeń może odwołać / zaproponować zmianę WYŁĄCZNIE pojedynczej lekcji z
-- cyklu — sam cykl pozostaje nietknięty od jego strony.

-- ============================================================================
-- Tabela recurring_lessons
-- ============================================================================

CREATE TABLE public.recurring_lessons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- 0=niedziela, 1=poniedziałek, ..., 6=sobota — zgodnie z PostgreSQL extract(dow).
  day_of_week      integer NOT NULL,
  time_of_day      time NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 45,
  mode             public.lesson_mode NOT NULL,
  starts_on        date NOT NULL,
  -- NULL = cykl bez daty końcowej („bez końca"). Generator używa wtedy p_until
  -- jako limitu.
  ends_on          date,
  cancelled        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_dow_range
    CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT recurring_minutes_quantized
    CHECK (EXTRACT(MINUTE FROM time_of_day)::int % 15 = 0
       AND EXTRACT(SECOND FROM time_of_day) = 0),
  CONSTRAINT recurring_ends_on_after_start
    CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX recurring_lessons_teacher_idx ON public.recurring_lessons (teacher_id);
CREATE INDEX recurring_lessons_student_idx ON public.recurring_lessons (student_id);

-- Powiązanie konkretnej lekcji z cyklem. ON DELETE SET NULL — usunięcie wzorca
-- cyklu nie kasuje już wygenerowanych lekcji, traktujemy je jako samodzielne.
ALTER TABLE public.lessons
  ADD COLUMN recurring_lesson_id uuid
    REFERENCES public.recurring_lessons(id) ON DELETE SET NULL;

CREATE INDEX lessons_recurring_idx ON public.lessons (recurring_lesson_id);

-- ============================================================================
-- Triggery — walidacja przy INSERT
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_recurring_lesson()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_t_role public.user_role;
  v_s_role public.user_role;
  v_link   boolean;
BEGIN
  SELECT role INTO v_t_role FROM public.profiles WHERE id = NEW.teacher_id;
  IF v_t_role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'teacher_id musi wskazywać profil z rolą teacher.';
  END IF;
  SELECT role INTO v_s_role FROM public.profiles WHERE id = NEW.student_id;
  IF v_s_role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'student_id musi wskazywać profil z rolą student.';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.teacher_students
    WHERE teacher_id = NEW.teacher_id AND student_id = NEW.student_id
  ) INTO v_link;
  IF NOT v_link THEN
    RAISE EXCEPTION 'Brak aktywnego powiązania nauczyciel-uczeń.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER recurring_lessons_validate
  BEFORE INSERT ON public.recurring_lessons
  FOR EACH ROW EXECUTE FUNCTION public.validate_recurring_lesson();

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.recurring_lessons ENABLE ROW LEVEL SECURITY;

-- Nauczyciel: pełen CRUD na swoich cyklach.
CREATE POLICY "Teachers manage own recurring lessons"
  ON public.recurring_lessons FOR ALL
  TO authenticated
  USING      (auth.uid() = teacher_id)
  WITH CHECK (auth.uid() = teacher_id);

-- Uczeń: tylko odczyt swoich cykli (potrzebne do oznaczenia 🔁 i komunikatów).
CREATE POLICY "Students read own recurring lessons"
  ON public.recurring_lessons FOR SELECT
  TO authenticated
  USING (auth.uid() = student_id);

-- ============================================================================
-- Funkcja: generate_recurring_lessons
--
-- Generuje instancje lekcji w tabeli `lessons` na podstawie wzorca. Funkcja
-- jest idempotentna — wielokrotne wywołanie nie duplikuje rekordów:
--   • pomija daty z istniejącą (niezakasowaną) lekcją u tego nauczyciela na
--     tę samą godzinę,
--   • pomija daty przeszłe (w strefie Europe/Warsaw — aplikacja jest dla PL),
--   • generuje do MIN(ends_on, p_until); dla ends_on IS NULL używa p_until.
-- ============================================================================

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

  -- Limit: dla cykli z ends_on bierzemy MIN(ends_on, p_until); dla cykli
  -- otwartych — sam p_until.
  v_limit := CASE
    WHEN v_rec.ends_on IS NULL THEN p_until
    ELSE LEAST(v_rec.ends_on, p_until)
  END;

  -- Pierwsza data >= starts_on, której dzień tygodnia pasuje do wzorca.
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
          teacher_id, student_id, start_at, duration_minutes, mode, recurring_lesson_id
        ) VALUES (
          v_rec.teacher_id, v_rec.student_id, v_start,
          v_rec.duration_minutes, v_rec.mode, v_rec.id
        );
        v_count := v_count + 1;
      END IF;
    END IF;
    v_date := v_date + 7;
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_recurring_lessons(uuid, date) TO authenticated;

-- ============================================================================
-- Funkcja: cancel_recurring_series
--
-- Kończy cykl od podanej daty (włącznie). Anuluje wszystkie scheduled lekcje
-- z cyklu, których start_at >= p_from_date. Aktualizuje ends_on / cancelled
-- na wzorcu zgodnie z kontraktem:
--   • p_from_date > starts_on → ends_on = p_from_date - 1
--   • p_from_date ≤ starts_on → cancelled = true, ends_on = NULL (cały cykl).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cancel_recurring_series(
  p_recurring_id uuid,
  p_from_date    date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rec    public.recurring_lessons%ROWTYPE;
  v_cutoff timestamptz;
  v_count  integer;
BEGIN
  SELECT * INTO v_rec FROM public.recurring_lessons
    WHERE id = p_recurring_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cykl nie istnieje.';
  END IF;
  IF auth.uid() IS DISTINCT FROM v_rec.teacher_id THEN
    RAISE EXCEPTION 'Tylko nauczyciel cyklu może go zakończyć.';
  END IF;

  v_cutoff := (p_from_date::timestamp) AT TIME ZONE 'Europe/Warsaw';

  UPDATE public.lessons
  SET status       = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = now()
  WHERE recurring_lesson_id = p_recurring_id
    AND start_at >= v_cutoff
    AND status    = 'scheduled';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF p_from_date <= v_rec.starts_on THEN
    UPDATE public.recurring_lessons
    SET cancelled = true,
        ends_on   = NULL
    WHERE id = p_recurring_id;
  ELSE
    UPDATE public.recurring_lessons
    SET ends_on = p_from_date - 1
    WHERE id = p_recurring_id;
  END IF;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_recurring_series(uuid, date) TO authenticated;

-- ============================================================================
-- Realtime
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.recurring_lessons;
