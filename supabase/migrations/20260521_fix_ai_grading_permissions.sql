-- Moduł 3 — fix: triggery guard_*_student_update blokowały backend AI grading.
--
-- Problem (objawy):
--   • Auto-grading po oddaniu pracy: UI nauczyciela zawieszał się na
--     „AI właśnie ocenia w tle" — kod łapał błąd w console.error w after()
--     i nigdy nie wracał z sugestiami.
--   • Ręczne „Oceń z pomocą AI" rzucało:
--     „Zapis sugestii AI dla zadania nieudany: Uczeń może zmienić wyłącznie
--      pole student_answer."
--
-- Przyczyna:
--   • runAIGradingCore używa admin clienta (lib/supabase/admin.ts) z
--     service-role key. Połączenie nie nosi JWT, więc auth.uid() = NULL.
--   • Triggery guard_*_student_update zaczynały się od:
--       IF auth.uid() = NEW.teacher_id THEN RETURN NEW; END IF;
--     Przy auth.uid()=NULL warunek daje NULL (nie TRUE), więc kod
--     przechodził dalej, do bloku porównującego pola — tam każdy
--     ai_suggested_*  IS DISTINCT FROM OLD.ai_suggested_*  uznawał ruch
--     pola i rzucał wyjątek „tylko student_answer".
--
-- Fix:
--   Dorzucamy NA POCZĄTKU obu funkcji wczesny return przy auth.uid() IS NULL.
--   Identyfikuje to operacje backendu (service-role / brak JWT). Uczeń,
--   nauczyciel i każda inna zalogowana sesja zawsze ma JWT → auth.uid() jest
--   ich UUID-em, więc walidacja działa bez zmian.
--
-- Bezpieczeństwo:
--   • RLS na tabelach tasks/assignments nie zmieniamy — to dalej egzekwuje,
--     że uczeń widzi/aktualizuje tylko swoje wiersze.
--   • Triggery guard_* są tylko ograniczeniem ZAKRESU pól dla ucznia.
--     Backend (service-role) i tak ma pełne uprawnienia z innych powodów
--     (omija RLS), więc dorzucenie wyjątku w triggerze nie poszerza ataku
--     surface.

-- ============================================================================
-- guard_assignment_student_update — zapis ai_suggested_grade /
-- ai_suggested_feedback z backendu (runAIGradingCore → admin client)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_assignment_student_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Backend / service-role: brak JWT → auth.uid() IS NULL. Walidacja zakresu
  -- pól nie dotyczy operacji backendowych (one nigdy nie pochodzą od ucznia).
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

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

-- ============================================================================
-- guard_task_student_update — zapis ai_suggested_correct / ai_suggested_comment
-- / ai_graded_at z backendu (runAIGradingCore → admin client)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_task_student_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_teacher_id uuid;
BEGIN
  -- Backend / service-role: brak JWT → auth.uid() IS NULL.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

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
