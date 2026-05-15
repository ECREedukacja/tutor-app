-- Moduł 3: prace domowe generowane przez AI (Claude API).
--
-- Architektura:
--   • assignments — kontener (1 praca = 1 nauczyciel + 1 uczeń + N zadań)
--   • tasks       — pojedyncze zadania w kontenerze (treść Markdown z LaTeX)
--   • status flow: draft → sent → in_progress → submitted → graded
--
-- Walidacja roli i powiązania nauczyciel-uczeń identyczna jak w lessons —
-- trigger SECURITY DEFINER, żeby ominąć RLS klienta.
--
-- Powiadomienia (assignment_received / submitted / graded) idą przez ten sam
-- kanał co Moduł 1.3 (notifications + create_notification + realtime). Tutaj
-- tylko rozszerzamy enum notification_type i dokładamy 3 triggery na
-- assignments.

-- ============================================================================
-- 1) Enums
-- ============================================================================

CREATE TYPE public.subject AS ENUM ('mathematics');

CREATE TYPE public.difficulty_level AS ENUM ('easy', 'medium', 'hard', 'mixed');

CREATE TYPE public.assignment_status AS ENUM (
  'draft',        -- wygenerowana, ale jeszcze nie wysłana do ucznia
  'sent',         -- wysłana, czeka aż uczeń otworzy
  'in_progress',  -- uczeń zaczął wpisywać odpowiedzi
  'submitted',    -- uczeń oddał, czeka na ocenę
  'graded'        -- nauczyciel ocenił
);

CREATE TYPE public.task_type AS ENUM ('open', 'closed', 'calculation', 'proof');

-- Rozszerzenie enum notification_type o 3 typy dla prac domowych. Dodajemy
-- po jednej wartości na raz — IF NOT EXISTS pozwala bezpiecznie ponownie
-- uruchomić migrację.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'assignment_received';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'assignment_submitted';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'assignment_graded';

-- ============================================================================
-- 2) Tabele
-- ============================================================================

CREATE TABLE public.assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id        uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title             text NOT NULL,
  subject           public.subject NOT NULL DEFAULT 'mathematics',
  topic             text,
  grade_level       text,
  difficulty        public.difficulty_level,
  custom_prompt     text,
  status            public.assignment_status NOT NULL DEFAULT 'draft',
  due_date          timestamptz,
  sent_at           timestamptz,
  submitted_at      timestamptz,
  grade             text,
  teacher_feedback  text,
  -- Wiadomość od nauczyciela do ucznia przy wysyłce (opcjonalna).
  teacher_message   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assignments_teacher_status_created_idx
  ON public.assignments (teacher_id, status, created_at DESC);

CREATE INDEX assignments_student_status_created_idx
  ON public.assignments (student_id, status, created_at DESC);

CREATE TABLE public.tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id    uuid NOT NULL REFERENCES public.assignments(id) ON DELETE CASCADE,
  order_index      integer NOT NULL,
  content          text NOT NULL,
  task_type        public.task_type,
  expected_answer  text,
  student_answer   text,
  is_correct       boolean,
  teacher_comment  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_assignment_order_idx
  ON public.tasks (assignment_id, order_index);

-- ============================================================================
-- 3) Walidacja przy INSERT — role + powiązanie
-- ============================================================================

CREATE OR REPLACE FUNCTION public.validate_assignment()
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

CREATE TRIGGER assignments_validate
  BEFORE INSERT ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.validate_assignment();

-- ============================================================================
-- 4) Row Level Security
-- ============================================================================

ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks       ENABLE ROW LEVEL SECURITY;

-- ---- assignments ----

-- Nauczyciel ma pełny CRUD na swoich pracach.
CREATE POLICY "Teachers manage own assignments"
  ON public.assignments FOR ALL
  TO authenticated
  USING      (auth.uid() = teacher_id)
  WITH CHECK (auth.uid() = teacher_id);

-- Uczeń widzi prace, które do niego trafiły, ale tylko po wysyłce.
-- Drafty są niewidoczne dla ucznia, dopóki nauczyciel nie kliknie „Wyślij".
CREATE POLICY "Students read sent assignments"
  ON public.assignments FOR SELECT
  TO authenticated
  USING (
    auth.uid() = student_id
    AND status IN ('sent', 'in_progress', 'submitted', 'graded')
  );

-- Uczeń aktualizuje TYLKO status (z 'sent' lub 'in_progress' na 'submitted'
-- lub 'in_progress'). Trigger niżej pilnuje, żeby nie ruszył pól zarezerwowanych
-- dla nauczyciela (grade, teacher_feedback, due_date itd.).
CREATE POLICY "Students update own assignment status"
  ON public.assignments FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = student_id
    AND status IN ('sent', 'in_progress')
  )
  WITH CHECK (
    auth.uid() = student_id
    AND status IN ('in_progress', 'submitted')
  );

-- ---- tasks ----

-- Nauczyciel: pełny CRUD na zadaniach należących do swoich prac (przez join).
CREATE POLICY "Teachers manage own tasks"
  ON public.tasks FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.id = tasks.assignment_id
        AND a.teacher_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.id = tasks.assignment_id
        AND a.teacher_id = auth.uid()
    )
  );

-- Uczeń: SELECT zadań z prac wysłanych do niego.
CREATE POLICY "Students read tasks of sent assignments"
  ON public.tasks FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.id = tasks.assignment_id
        AND a.student_id = auth.uid()
        AND a.status IN ('sent', 'in_progress', 'submitted', 'graded')
    )
  );

-- Uczeń: UPDATE — tylko własna odpowiedź (student_answer). Ograniczenie
-- "tylko jedno pole" wymusza trigger niżej; tutaj RLS dba o zakres wierszy.
CREATE POLICY "Students update own task answers"
  ON public.tasks FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.id = tasks.assignment_id
        AND a.student_id = auth.uid()
        AND a.status IN ('sent', 'in_progress')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.assignments a
      WHERE a.id = tasks.assignment_id
        AND a.student_id = auth.uid()
    )
  );

-- ============================================================================
-- 5) Triggery wymuszające zakres pól, które każda strona może zmieniać
-- ============================================================================

-- Po stronie ucznia: na assignments dopuszczamy tylko zmianę status (draft
-- pól zarezerwowanych dla nauczyciela). To uzupełnienie polityki UPDATE.
CREATE OR REPLACE FUNCTION public.guard_assignment_student_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Jeśli akcję wykonuje nauczyciel-właściciel, nie blokujemy nic.
  IF auth.uid() = NEW.teacher_id THEN
    RETURN NEW;
  END IF;

  -- Akcja po stronie ucznia: każde pole inne niż status musi pozostać bez zmian.
  IF NEW.teacher_id        IS DISTINCT FROM OLD.teacher_id
  OR NEW.student_id        IS DISTINCT FROM OLD.student_id
  OR NEW.title             IS DISTINCT FROM OLD.title
  OR NEW.subject           IS DISTINCT FROM OLD.subject
  OR NEW.topic             IS DISTINCT FROM OLD.topic
  OR NEW.grade_level       IS DISTINCT FROM OLD.grade_level
  OR NEW.difficulty        IS DISTINCT FROM OLD.difficulty
  OR NEW.custom_prompt     IS DISTINCT FROM OLD.custom_prompt
  OR NEW.due_date          IS DISTINCT FROM OLD.due_date
  OR NEW.sent_at           IS DISTINCT FROM OLD.sent_at
  OR NEW.grade             IS DISTINCT FROM OLD.grade
  OR NEW.teacher_feedback  IS DISTINCT FROM OLD.teacher_feedback
  OR NEW.teacher_message   IS DISTINCT FROM OLD.teacher_message
  THEN
    RAISE EXCEPTION 'Uczeń może zmienić wyłącznie status pracy.';
  END IF;

  -- Auto-stempel oddania.
  IF NEW.status = 'submitted' AND OLD.status <> 'submitted' THEN
    NEW.submitted_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER assignments_guard_student_update
  BEFORE UPDATE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_assignment_student_update();

-- Tasks: po stronie ucznia można zmienić tylko student_answer.
CREATE OR REPLACE FUNCTION public.guard_task_student_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_teacher_id uuid;
BEGIN
  SELECT teacher_id INTO v_teacher_id
    FROM public.assignments WHERE id = NEW.assignment_id;

  IF auth.uid() = v_teacher_id THEN
    RETURN NEW;
  END IF;

  IF NEW.assignment_id   IS DISTINCT FROM OLD.assignment_id
  OR NEW.order_index     IS DISTINCT FROM OLD.order_index
  OR NEW.content         IS DISTINCT FROM OLD.content
  OR NEW.task_type       IS DISTINCT FROM OLD.task_type
  OR NEW.expected_answer IS DISTINCT FROM OLD.expected_answer
  OR NEW.is_correct      IS DISTINCT FROM OLD.is_correct
  OR NEW.teacher_comment IS DISTINCT FROM OLD.teacher_comment
  THEN
    RAISE EXCEPTION 'Uczeń może zmienić wyłącznie pole student_answer.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_guard_student_update
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_student_update();

-- ============================================================================
-- 6) Triggery powiadomień
--
-- create_notification ma sygnaturę z 9 argumentami:
--   (user_id, type, title, body,
--    related_user_id, related_lesson_id, related_proposal_id, related_request_id,
--    link)
-- W przypadku prac domowych nie mamy related_lesson/proposal/request, więc
-- lecimy NULL-ami, a w link wpisujemy /dashboard/assignments/{id}.
-- ============================================================================

-- a) Wysyłka pracy do ucznia: 'draft' → 'sent'
CREATE OR REPLACE FUNCTION public.notify_assignment_received()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'sent' AND OLD.status IS DISTINCT FROM 'sent' THEN
    PERFORM public.create_notification(
      NEW.student_id,
      'assignment_received',
      'Otrzymałeś nową pracę domową',
      public.notif_display_name(NEW.teacher_id) || ' wysłał(a) Ci pracę: '
        || NEW.title || '.',
      NEW.teacher_id,
      NULL, NULL, NULL,
      '/dashboard/assignments/' || NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_assignment_received
  AFTER UPDATE OF status ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.notify_assignment_received();

-- b) Oddanie pracy przez ucznia: 'in_progress' (lub 'sent') → 'submitted'
CREATE OR REPLACE FUNCTION public.notify_assignment_submitted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    PERFORM public.create_notification(
      NEW.teacher_id,
      'assignment_submitted',
      'Uczeń oddał pracę domową',
      public.notif_display_name(NEW.student_id) || ' oddał(a) pracę: '
        || NEW.title || '.',
      NEW.student_id,
      NULL, NULL, NULL,
      '/dashboard/assignments/' || NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_assignment_submitted
  AFTER UPDATE OF status ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.notify_assignment_submitted();

-- c) Ocena pracy przez nauczyciela: '*' → 'graded'
CREATE OR REPLACE FUNCTION public.notify_assignment_graded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'graded' AND OLD.status IS DISTINCT FROM 'graded' THEN
    PERFORM public.create_notification(
      NEW.student_id,
      'assignment_graded',
      'Twoja praca domowa została oceniona',
      public.notif_display_name(NEW.teacher_id) || ' ocenił(a) pracę: '
        || NEW.title
        || COALESCE(' (ocena: ' || NEW.grade || ')', '') || '.',
      NEW.teacher_id,
      NULL, NULL, NULL,
      '/dashboard/assignments/' || NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_assignment_graded
  AFTER UPDATE OF status ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.notify_assignment_graded();

-- ============================================================================
-- 7) Realtime
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
