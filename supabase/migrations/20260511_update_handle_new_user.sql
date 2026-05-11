-- Aktualizacja triggera handle_new_user: obsługa metadanych z OAuth (Google).
-- Google zwraca imię/nazwisko w polach given_name, family_name oraz full_name/name.
-- Funkcja sprawdza pola po kolei i wpada na pusty string dopiero w ostateczności,
-- aby trigger nigdy nie zawiódł (first_name/last_name są NOT NULL w profiles).

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  meta       jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  full_name  text  := COALESCE(
    NULLIF(meta ->> 'full_name', ''),
    NULLIF(meta ->> 'name', '')
  );
  first_name text;
  last_name  text;
BEGIN
  first_name := COALESCE(
    NULLIF(meta ->> 'first_name', ''),
    NULLIF(meta ->> 'given_name', ''),
    NULLIF(split_part(full_name, ' ', 1), ''),
    ''
  );

  last_name := COALESCE(
    NULLIF(meta ->> 'last_name', ''),
    NULLIF(meta ->> 'family_name', ''),
    -- wszystko po pierwszej spacji z full_name; gdy brak spacji regex zwróci NULL
    NULLIF(substring(full_name FROM '^\S+\s+(.+)$'), ''),
    ''
  );

  INSERT INTO public.profiles (id, first_name, last_name, phone, role)
  VALUES (
    NEW.id,
    first_name,
    last_name,
    meta ->> 'phone',
    COALESCE((meta ->> 'role')::public.user_role, 'student')
  );
  RETURN NEW;
END;
$$;
