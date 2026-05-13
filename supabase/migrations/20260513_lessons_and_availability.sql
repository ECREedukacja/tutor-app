-- Moduł 2.A: Terminarz — wolne terminy (availability) i lekcje (lessons).
-- Nauczyciel publikuje wolne terminy → uczeń się zapisuje → tworzy się lekcja,
-- a wpis w availability znika (slot jest zajęty). Cała operacja zapisu jest
-- transakcyjna i opakowana w funkcję RPC book_lesson().

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE public.lesson_status AS ENUM ('scheduled', 'cancelled', 'completed');

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE public.availability (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  start_at         timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 45,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Sloty są na siatce 15-minutowej; sekundy muszą być zerowe.
  CONSTRAINT availability_minutes_quantized
    CHECK (EXTRACT(MINUTE FROM start_at)::int % 15 = 0
       AND EXTRACT(SECOND FROM start_at) = 0)
);

CREATE INDEX availability_teacher_start_idx
  ON public.availability (teacher_id, start_at);

CREATE TABLE public.lessons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  start_at         timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 45,
  status           public.lesson_status NOT NULL DEFAULT 'scheduled',
  cancelled_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancelled_at     timestamptz,
  cancel_reason    text,
  -- Skąd pochodzi lekcja. ON DELETE SET NULL = po usunięciu slotu lekcja
  -- nie znika; w praktyce book_lesson() usuwa slot tuż po insert, więc pole
  -- zazwyczaj kończy jako NULL — zostaje jednak struktura dla przyszłych
  -- przepływów (np. ręczne dodawanie lekcji bez slotu).
  availability_id  uuid REFERENCES public.availability(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lessons_minutes_quantized
    CHECK (EXTRACT(MINUTE FROM start_at)::int % 15 = 0
       AND EXTRACT(SECOND FROM start_at) = 0)
);

CREATE INDEX lessons_teacher_start_idx ON public.lessons (teacher_id, start_at);
CREATE INDEX lessons_student_start_idx ON public.lessons (student_id, start_at);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Wymuszenie roli teacher i przyszłej daty. now() jest volatile, więc CHECK
-- constraint nie zadziała wiarygodnie — używamy triggera SECURITY DEFINER,
-- żeby móc czytać public.profiles niezależnie od RLS klienta.
CREATE OR REPLACE FUNCTION public.validate_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role public.user_role;
BEGIN
  IF NEW.start_at <= now() THEN
    RAISE EXCEPTION 'Termin musi być w przyszłości.';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = NEW.teacher_id;
  IF v_role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'teacher_id musi wskazywać na profil z rolą teacher.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER availability_validate
  BEFORE INSERT OR UPDATE ON public.availability
  FOR EACH ROW EXECUTE FUNCTION public.validate_availability();

-- Walidacja lekcji przy INSERT: role obu stron + istniejące powiązanie w
-- teacher_students. Trigger SECURITY DEFINER, żeby ominąć RLS.
CREATE OR REPLACE FUNCTION public.validate_lesson()
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

CREATE TRIGGER lessons_validate
  BEFORE INSERT ON public.lessons
  FOR EACH ROW EXECUTE FUNCTION public.validate_lesson();

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lessons      ENABLE ROW LEVEL SECURITY;

-- ---- availability ----

-- Nauczyciel: pełny CRUD na swoich slotach.
CREATE POLICY "Teachers manage own availability"
  ON public.availability FOR ALL
  TO authenticated
  USING      (auth.uid() = teacher_id)
  WITH CHECK (auth.uid() = teacher_id);

-- Uczeń: widzi sloty wyłącznie tych nauczycieli, z którymi jest powiązany.
CREATE POLICY "Students read availability of their teachers"
  ON public.availability FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.student_id = auth.uid()
        AND ts.teacher_id = availability.teacher_id
    )
  );

-- ---- lessons ----

CREATE POLICY "Teachers read own lessons"
  ON public.lessons FOR SELECT
  TO authenticated
  USING (auth.uid() = teacher_id);

-- UPDATE zostawiamy obu stronom — w Zadaniu C ruszy odwoływanie lekcji.
CREATE POLICY "Teachers update own lessons"
  ON public.lessons FOR UPDATE
  TO authenticated
  USING      (auth.uid() = teacher_id)
  WITH CHECK (auth.uid() = teacher_id);

CREATE POLICY "Students read own lessons"
  ON public.lessons FOR SELECT
  TO authenticated
  USING (auth.uid() = student_id);

CREATE POLICY "Students update own lessons"
  ON public.lessons FOR UPDATE
  TO authenticated
  USING      (auth.uid() = student_id)
  WITH CHECK (auth.uid() = student_id);

-- INSERT lekcji odbywa się przez book_lesson() (SECURITY DEFINER), ale
-- zostawiamy też politykę awaryjną — uczeń może wstawić wpis tylko w swoim
-- imieniu i tylko z aktywnym powiązaniem.
CREATE POLICY "Students book own lessons"
  ON public.lessons FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = student_id
    AND EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.student_id = auth.uid()
        AND ts.teacher_id = lessons.teacher_id
    )
  );

-- ============================================================================
-- RPC: book_lesson
-- ============================================================================

-- Transakcyjna rezerwacja: zapis lekcji + usunięcie slotu w jednej operacji.
-- SECURITY DEFINER omija RLS na availability (DELETE) — funkcja sama sprawdza
-- uprawnienia (auth.uid() = p_student_id, istnienie powiązania, dostępność
-- slotu). FOR UPDATE blokuje równoczesne rezerwacje tego samego slotu.
CREATE OR REPLACE FUNCTION public.book_lesson(
  p_availability_id uuid,
  p_student_id      uuid
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
    teacher_id, student_id, start_at, duration_minutes, availability_id
  ) VALUES (
    v_availability.teacher_id,
    p_student_id,
    v_availability.start_at,
    v_availability.duration_minutes,
    v_availability.id
  ) RETURNING id INTO v_lesson_id;

  DELETE FROM public.availability WHERE id = p_availability_id;

  RETURN v_lesson_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.book_lesson(uuid, uuid) TO authenticated;

-- ============================================================================
-- Realtime
-- Frontend subskrybuje zmiany w obu tabelach, żeby kalendarz odświeżał się
-- bez pełnego reloada po dodaniu/usunięciu slotu lub zapisaniu się na lekcję.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.availability;
ALTER PUBLICATION supabase_realtime ADD TABLE public.lessons;
