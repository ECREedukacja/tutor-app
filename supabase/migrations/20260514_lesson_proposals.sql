-- Moduł 2.A — propozycje lekcji (nauczyciel umawia + przenoszenie lekcji).
-- Propozycja może być nowej lekcji (new_lesson) albo zmiany istniejącej
-- (reschedule). Po akceptacji trigger tworzy/aktualizuje wpis w lessons.

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE public.proposal_kind   AS ENUM ('new_lesson', 'reschedule');
CREATE TYPE public.proposal_status AS ENUM ('pending', 'accepted', 'rejected', 'cancelled', 'expired');

-- ============================================================================
-- Polityka INSERT na lessons dla nauczyciela
-- Potrzebna do „Zaplanuj od razu" (nauczyciel tworzy lekcję bezpośrednio).
-- ============================================================================

CREATE POLICY "Teachers schedule own lessons"
  ON public.lessons FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = teacher_id
    AND EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.teacher_id = auth.uid()
        AND ts.student_id = lessons.student_id
    )
  );

-- ============================================================================
-- Tabela
-- ============================================================================

CREATE TABLE public.lesson_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               public.proposal_kind NOT NULL,
  teacher_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  proposer_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  original_lesson_id uuid REFERENCES public.lessons(id) ON DELETE CASCADE,
  start_at           timestamptz NOT NULL,
  duration_minutes   integer NOT NULL DEFAULT 45,
  mode               public.lesson_mode NOT NULL,
  status             public.proposal_status NOT NULL DEFAULT 'pending',
  created_at         timestamptz NOT NULL DEFAULT now(),
  responded_at       timestamptz,
  CONSTRAINT proposal_kind_matches CHECK (
    (kind = 'reschedule' AND original_lesson_id IS NOT NULL) OR
    (kind = 'new_lesson' AND original_lesson_id IS NULL)
  ),
  CONSTRAINT proposer_is_party CHECK (
    proposer_id = teacher_id OR proposer_id = student_id
  ),
  CONSTRAINT proposal_minutes_quantized
    CHECK (EXTRACT(MINUTE FROM start_at)::int % 15 = 0
       AND EXTRACT(SECOND FROM start_at) = 0)
);

CREATE INDEX lesson_proposals_teacher_status_idx
  ON public.lesson_proposals (teacher_id, status);
CREATE INDEX lesson_proposals_student_status_idx
  ON public.lesson_proposals (student_id, status);
CREATE INDEX lesson_proposals_original_lesson_idx
  ON public.lesson_proposals (original_lesson_id);

-- ============================================================================
-- Triggery
-- ============================================================================

-- Walidacja przy INSERT: role obu stron, powiązanie, oraz dla 'reschedule'
-- spójność z original_lesson (ta sama para teacher/student).
CREATE OR REPLACE FUNCTION public.validate_lesson_proposal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_teacher_role public.user_role;
  v_student_role public.user_role;
  v_link_exists  boolean;
  v_orig_teacher uuid;
  v_orig_student uuid;
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

  IF NEW.kind = 'reschedule' THEN
    SELECT teacher_id, student_id
      INTO v_orig_teacher, v_orig_student
      FROM public.lessons
      WHERE id = NEW.original_lesson_id;
    IF v_orig_teacher IS NULL THEN
      RAISE EXCEPTION 'Lekcja źródłowa nie istnieje.';
    END IF;
    IF v_orig_teacher <> NEW.teacher_id OR v_orig_student <> NEW.student_id THEN
      RAISE EXCEPTION 'Lekcja źródłowa należy do innej pary nauczyciel-uczeń.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER lesson_proposals_validate
  BEFORE INSERT ON public.lesson_proposals
  FOR EACH ROW EXECUTE FUNCTION public.validate_lesson_proposal();

-- Po zmianie statusu: ustaw responded_at i jeśli accepted — utwórz/zaktualizuj
-- wpis w lessons. SECURITY DEFINER, bo INSERT/UPDATE na lessons mogą wymagać
-- RLS, którego nie spełnia akceptujący (np. nauczyciel akceptujący prośbę
-- od ucznia o nową lekcję — ma politykę INSERT, ale przez SD nie zależymy
-- od tego).
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
          teacher_id, student_id, start_at, duration_minutes, mode
        ) VALUES (
          NEW.teacher_id, NEW.student_id, NEW.start_at, NEW.duration_minutes, NEW.mode
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

CREATE TRIGGER lesson_proposals_handle_response
  BEFORE UPDATE ON public.lesson_proposals
  FOR EACH ROW EXECUTE FUNCTION public.handle_proposal_response();

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.lesson_proposals ENABLE ROW LEVEL SECURITY;

-- Obie strony widzą propozycje swojej pary.
CREATE POLICY "Parties read own proposals"
  ON public.lesson_proposals FOR SELECT
  TO authenticated
  USING (auth.uid() = teacher_id OR auth.uid() = student_id);

-- Tylko proposer tworzy propozycje (w swoim imieniu).
CREATE POLICY "Proposer creates proposals"
  ON public.lesson_proposals FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = proposer_id
    AND (auth.uid() = teacher_id OR auth.uid() = student_id)
  );

-- Druga strona (nie proposer) może akceptować/odrzucać; proposer może anulować.
-- Logikę „kto co może" zostawiamy aplikacji — RLS pilnuje tylko, że obie strony
-- pary mogą edytować propozycję.
CREATE POLICY "Parties update proposals"
  ON public.lesson_proposals FOR UPDATE
  TO authenticated
  USING      (auth.uid() = teacher_id OR auth.uid() = student_id)
  WITH CHECK (auth.uid() = teacher_id OR auth.uid() = student_id);

-- ============================================================================
-- Realtime
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.lesson_proposals;
