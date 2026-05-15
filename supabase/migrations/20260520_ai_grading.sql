-- Moduł 3 — rozszerzenie: AI ocenia odpowiedzi ucznia + wskazówki w zadaniach.
--
-- Funkcjonalność 1 — auto-grading przez Claude API:
--   • assignments.auto_grade_enabled — czy AI ma ocenić pracę po oddaniu
--   • assignments.ai_suggested_grade / ai_suggested_feedback — sugestia AI
--     (pre-fill formularza nauczyciela, nigdy nie nadpisuje grade/feedback
--     bez ręcznej akceptacji)
--   • tasks.ai_suggested_correct / ai_suggested_comment / ai_graded_at
--   • Nowy typ powiadomienia 'assignment_ai_graded'
--   • notify_assignment_ai_graded — fires when ai_suggested_grade goes NULL→nie
--   • notify_assignment_submitted — pomija powiadomienie "oddał" gdy
--     auto_grade_enabled, żeby nauczyciel dostał JEDNO powiadomienie po
--     zakończeniu pracy AI ("AI już oceniło, sprawdź sugestie").
--
-- Funkcjonalność 2 — wskazówki dla ucznia:
--   • tasks.hint — krótka podpowiedź (1-2 zdania, opcjonalnie LaTeX inline)
--   • Pole opcjonalne; istniejące zadania zostają z hint=NULL.
--
-- Aktualizacje guard_*_student_update — uczeń nie może modyfikować nowych pól.

-- ============================================================================
-- 1) Nowe kolumny
-- ============================================================================

ALTER TABLE public.assignments
  ADD COLUMN auto_grade_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_suggested_grade    text,
  ADD COLUMN ai_suggested_feedback text;

ALTER TABLE public.tasks
  ADD COLUMN ai_suggested_correct boolean,
  ADD COLUMN ai_suggested_comment text,
  ADD COLUMN ai_graded_at         timestamptz,
  ADD COLUMN hint                 text;

-- ============================================================================
-- 2) Nowy typ powiadomienia
--
-- ALTER TYPE ... ADD VALUE działa od PG 12 wewnątrz transakcji, ale wartości
-- nie można jeszcze użyć w tej samej transakcji. Funkcje plpgsql odwołują się
-- do enum-ów leniwie (przy CALL-u, nie przy CREATE), więc redefinicja
-- notify_assignment_ai_graded() poniżej jest bezpieczna — funkcja zostanie
-- pierwszy raz wywołana już po commit-cie tej migracji.
-- ============================================================================

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'assignment_ai_graded';

-- ============================================================================
-- 3) Aktualizacja guard triggers
-- ============================================================================

-- guard_assignment_student_update — dorzucamy nowe pola assignments do listy,
-- której uczeń nie może ruszyć (auto_grade_enabled, ai_suggested_*).
CREATE OR REPLACE FUNCTION public.guard_assignment_student_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() = NEW.teacher_id THEN
    RETURN NEW;
  END IF;

  IF NEW.teacher_id            IS DISTINCT FROM OLD.teacher_id
  OR NEW.student_id            IS DISTINCT FROM OLD.student_id
  OR NEW.title                 IS DISTINCT FROM OLD.title
  OR NEW.subject               IS DISTINCT FROM OLD.subject
  OR NEW.topic                 IS DISTINCT FROM OLD.topic
  OR NEW.grade_level           IS DISTINCT FROM OLD.grade_level
  OR NEW.difficulty            IS DISTINCT FROM OLD.difficulty
  OR NEW.custom_prompt         IS DISTINCT FROM OLD.custom_prompt
  OR NEW.due_date              IS DISTINCT FROM OLD.due_date
  OR NEW.sent_at               IS DISTINCT FROM OLD.sent_at
  OR NEW.grade                 IS DISTINCT FROM OLD.grade
  OR NEW.teacher_feedback      IS DISTINCT FROM OLD.teacher_feedback
  OR NEW.teacher_message       IS DISTINCT FROM OLD.teacher_message
  OR NEW.auto_grade_enabled    IS DISTINCT FROM OLD.auto_grade_enabled
  OR NEW.ai_suggested_grade    IS DISTINCT FROM OLD.ai_suggested_grade
  OR NEW.ai_suggested_feedback IS DISTINCT FROM OLD.ai_suggested_feedback
  THEN
    RAISE EXCEPTION 'Uczeń może zmienić wyłącznie status pracy.';
  END IF;

  IF NEW.status = 'submitted' AND OLD.status <> 'submitted' THEN
    NEW.submitted_at := now();
  END IF;

  RETURN NEW;
END;
$$;

-- guard_task_student_update — dorzucamy nowe pola tasks (ai_*, hint) do listy
-- niedostępnej dla ucznia.
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

  IF NEW.assignment_id        IS DISTINCT FROM OLD.assignment_id
  OR NEW.order_index          IS DISTINCT FROM OLD.order_index
  OR NEW.content              IS DISTINCT FROM OLD.content
  OR NEW.task_type            IS DISTINCT FROM OLD.task_type
  OR NEW.expected_answer      IS DISTINCT FROM OLD.expected_answer
  OR NEW.is_correct           IS DISTINCT FROM OLD.is_correct
  OR NEW.teacher_comment      IS DISTINCT FROM OLD.teacher_comment
  OR NEW.ai_suggested_correct IS DISTINCT FROM OLD.ai_suggested_correct
  OR NEW.ai_suggested_comment IS DISTINCT FROM OLD.ai_suggested_comment
  OR NEW.ai_graded_at         IS DISTINCT FROM OLD.ai_graded_at
  OR NEW.hint                 IS DISTINCT FROM OLD.hint
  THEN
    RAISE EXCEPTION 'Uczeń może zmienić wyłącznie pole student_answer.';
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 4) Aktualizacja notify_assignment_submitted
--
-- Gdy auto_grade_enabled=true, pomijamy powiadomienie „oddał". Nauczyciel
-- dostanie jedno powiadomienie 'assignment_ai_graded' po zakończeniu AI.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_assignment_submitted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'submitted' AND OLD.status IS DISTINCT FROM 'submitted' THEN
    IF NEW.auto_grade_enabled THEN
      -- Powiadomienie zostanie wysłane przez notify_assignment_ai_graded
      -- po wypełnieniu ai_suggested_grade przez backend.
      RETURN NEW;
    END IF;
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

-- ============================================================================
-- 5) Nowy trigger: notify_assignment_ai_graded
--
-- Fires when ai_suggested_grade transitions from NULL to non-NULL — czyli
-- po zakończeniu pełnego procesu AI grading (per-task + ogólna ocena).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_assignment_ai_graded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.ai_suggested_grade IS NOT NULL
     AND OLD.ai_suggested_grade IS NULL THEN
    PERFORM public.create_notification(
      NEW.teacher_id,
      'assignment_ai_graded',
      'Uczeń oddał pracę — AI już ją oceniło',
      public.notif_display_name(NEW.student_id) || ' oddał(a) pracę: '
        || NEW.title || '. Sprawdź sugestie AI.',
      NEW.student_id,
      NULL, NULL, NULL,
      '/dashboard/assignments/' || NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_assignment_ai_graded
  AFTER UPDATE OF ai_suggested_grade ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.notify_assignment_ai_graded();
