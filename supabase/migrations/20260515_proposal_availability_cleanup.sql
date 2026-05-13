-- Cleanup availability slotów po utworzeniu/zaktualizowaniu lekcji.
--
-- Kontekst (BŁĄD 2):
-- Trigger `handle_proposal_response` przy akceptacji propozycji tworzy/aktualizuje
-- wiersz w `lessons`, ale nie usuwał kolidującego wiersza z `availability`.
-- W efekcie po akceptacji uczeń/nauczyciel widzieli jednocześnie lekcję i wolny
-- slot na tej samej godzinie.
--
-- Rozwiązanie: trigger AFTER INSERT OR UPDATE OF start_at, teacher_id na
-- `lessons`, który zawsze sprząta wolny termin tego samego nauczyciela na tę
-- samą godzinę. Dzięki temu ścieżka działa niezależnie od źródła zmiany:
--   • propozycje akceptowane przez `handle_proposal_response`,
--   • bezpośrednie tworzenie lekcji przez nauczyciela (scheduleLessonDirectly),
--   • bezpośrednie przenoszenie lekcji przez nauczyciela (rescheduleLessonDirectly).
--
-- UWAGA: dla reschedule celowo NIE przywracamy starego slotu. Stary termin
-- został opuszczony i to nauczyciel decyduje, czy chce go ponownie udostępnić.

CREATE OR REPLACE FUNCTION public.cleanup_availability_on_lesson()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.availability
   WHERE teacher_id = NEW.teacher_id
     AND start_at  = NEW.start_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cleanup_availability_on_lesson ON public.lessons;

CREATE TRIGGER cleanup_availability_on_lesson
AFTER INSERT OR UPDATE OF start_at, teacher_id ON public.lessons
FOR EACH ROW
EXECUTE FUNCTION public.cleanup_availability_on_lesson();
