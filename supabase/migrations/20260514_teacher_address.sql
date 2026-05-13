-- Moduł 2.A — uzupełnienie: adres stacjonarny w profilu nauczyciela.
-- Pole jest opcjonalne (NULL = nauczyciel prowadzi tylko online). Walidację
-- długości robimy aplikacyjnie po stronie formularza; w bazie zostawiamy
-- bez ograniczeń, żeby było elastycznie.

ALTER TABLE public.profiles
  ADD COLUMN address text;
