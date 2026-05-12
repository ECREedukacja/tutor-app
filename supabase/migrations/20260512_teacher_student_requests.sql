-- Moduł 1.1: prośby ucznia o powiązanie z nauczycielem.
-- Uczeń wysyła prośbę → nauczyciel akceptuje/odrzuca → po akceptacji
-- automatycznie tworzy się wpis w teacher_students.

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE public.request_status AS ENUM ('pending', 'accepted', 'rejected');

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE public.student_teacher_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  teacher_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status       public.request_status NOT NULL DEFAULT 'pending',
  message      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz
);

-- Tylko jedna "żywa" prośba (pending lub accepted) między daną parą.
-- Odrzucone prośby nie blokują ponownego wysłania.
CREATE UNIQUE INDEX student_teacher_requests_active_pair_idx
  ON public.student_teacher_requests (student_id, teacher_id)
  WHERE status IN ('pending', 'accepted');

CREATE INDEX student_teacher_requests_student_id_idx
  ON public.student_teacher_requests (student_id);

CREATE INDEX student_teacher_requests_teacher_id_idx
  ON public.student_teacher_requests (teacher_id);

CREATE INDEX student_teacher_requests_status_idx
  ON public.student_teacher_requests (status);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Walidacja przy INSERT: student_id musi należeć do profilu z rolą 'student',
-- teacher_id z rolą 'teacher'. SECURITY DEFINER, żeby trigger mógł
-- czytać profiles niezależnie od RLS klienta.
CREATE OR REPLACE FUNCTION public.validate_request_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student_role public.user_role;
  teacher_role public.user_role;
BEGIN
  SELECT role INTO student_role FROM public.profiles WHERE id = NEW.student_id;
  SELECT role INTO teacher_role FROM public.profiles WHERE id = NEW.teacher_id;

  IF student_role IS DISTINCT FROM 'student' THEN
    RAISE EXCEPTION 'student_id must reference a profile with role=student';
  END IF;

  IF teacher_role IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'teacher_id must reference a profile with role=teacher';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER student_teacher_requests_validate_roles
  BEFORE INSERT ON public.student_teacher_requests
  FOR EACH ROW EXECUTE FUNCTION public.validate_request_roles();

-- Po zmianie statusu: ustaw responded_at i jeśli accepted — utwórz powiązanie
-- w teacher_students (trigger SECURITY DEFINER omija RLS na teacher_students).
CREATE OR REPLACE FUNCTION public.handle_request_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.responded_at := now();
    IF NEW.status = 'accepted' THEN
      INSERT INTO public.teacher_students (teacher_id, student_id)
      VALUES (NEW.teacher_id, NEW.student_id)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER student_teacher_requests_handle_response
  BEFORE UPDATE ON public.student_teacher_requests
  FOR EACH ROW EXECUTE FUNCTION public.handle_request_response();

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.student_teacher_requests ENABLE ROW LEVEL SECURITY;

-- Uczeń wysyła prośbę tylko w swoim imieniu.
CREATE POLICY "Students create their own requests"
  ON public.student_teacher_requests FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = student_id);

-- Uczeń widzi swoje wysłane prośby.
CREATE POLICY "Students read own requests"
  ON public.student_teacher_requests FOR SELECT
  TO authenticated
  USING (auth.uid() = student_id);

-- Nauczyciel widzi prośby skierowane do siebie.
CREATE POLICY "Teachers read incoming requests"
  ON public.student_teacher_requests FOR SELECT
  TO authenticated
  USING (auth.uid() = teacher_id);

-- Nauczyciel może aktualizować (akceptować/odrzucać) swoje przychodzące prośby.
CREATE POLICY "Teachers respond to incoming requests"
  ON public.student_teacher_requests FOR UPDATE
  TO authenticated
  USING      (auth.uid() = teacher_id)
  WITH CHECK (auth.uid() = teacher_id);

-- ============================================================================
-- Dodatkowe polityki SELECT na profiles
-- Strony "Moi nauczyciele"/"Moi uczniowie" oraz lista próśb muszą wyświetlać
-- imię/nazwisko drugiej strony — bez tego standardowa polityka "własny profil"
-- nie pozwoli odczytać tych danych.
-- ============================================================================

-- Uczeń może czytać profile swoich (zaakceptowanych) nauczycieli.
CREATE POLICY "Students can read their teachers profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.student_id = auth.uid()
        AND ts.teacher_id = profiles.id
    )
  );

-- Obie strony aktywnej prośby (pending/accepted/rejected) widzą wzajemnie
-- swoje profile, żeby UI mogło pokazać imię i nazwisko obok prośby.
CREATE POLICY "Request participants read each other profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.student_teacher_requests r
      WHERE (r.student_id = auth.uid() AND r.teacher_id = profiles.id)
         OR (r.teacher_id = auth.uid() AND r.student_id = profiles.id)
    )
  );
