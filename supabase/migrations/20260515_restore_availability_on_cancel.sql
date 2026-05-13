-- Przywrócenie wolnego terminu po odwołaniu lekcji.
--
-- Kontekst:
-- Lekcja może być odwołana przez ucznia (>24h przed) lub przez nauczyciela
-- (bez ograniczeń) — server-action `cancelLesson` ustawia status='cancelled',
-- cancelled_by, cancelled_at. Po stronie kalendarza chcemy, żeby uwolniony
-- termin automatycznie wrócił do tabeli `availability` jako wolny slot
-- nauczyciela.
--
-- Współistnienie z istniejącym triggerem `cleanup_availability_on_lesson`:
--   • cleanup_availability_on_lesson: AFTER INSERT OR UPDATE OF start_at, teacher_id
--     → DELETE z availability matching (teacher_id, start_at) nowej lekcji
--   • restore_availability_on_lesson_cancel: AFTER UPDATE OF status
--     → INSERT do availability, gdy status zmienia się na 'cancelled'
-- Triggery operują na rozłącznych kolumnach (status vs. start_at/teacher_id),
-- więc UPDATE samego statusu uruchamia tylko restore, a INSERT lub przeniesienie
-- terminu uruchamia tylko cleanup — nie ma rekurencji ani wzajemnego znoszenia.
--
-- Tabela `availability` nie ma UNIQUE na (teacher_id, start_at), więc zamiast
-- ON CONFLICT DO NOTHING używamy idempotentnego INSERT ... WHERE NOT EXISTS.

CREATE OR REPLACE FUNCTION public.restore_availability_on_lesson_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    INSERT INTO public.availability (teacher_id, start_at, duration_minutes)
    SELECT NEW.teacher_id, NEW.start_at, NEW.duration_minutes
    WHERE NOT EXISTS (
      SELECT 1 FROM public.availability
      WHERE teacher_id = NEW.teacher_id
        AND start_at  = NEW.start_at
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS restore_availability_on_lesson_cancel ON public.lessons;

CREATE TRIGGER restore_availability_on_lesson_cancel
AFTER UPDATE OF status ON public.lessons
FOR EACH ROW
EXECUTE FUNCTION public.restore_availability_on_lesson_cancel();
