-- Initial schema for tutor app
-- Tworzy enum ról, tabelę profiles, tabelę łączącą teacher_students,
-- triggery (auto-utworzenie profilu po rejestracji, auto-updated_at)
-- oraz polityki RLS.

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE public.user_role AS ENUM ('teacher', 'student');

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE public.profiles (
  id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name text NOT NULL,
  last_name  text NOT NULL,
  phone      text,
  role       public.user_role NOT NULL DEFAULT 'student',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Relacja many-to-many: jeden uczeń może mieć wielu nauczycieli i odwrotnie.
CREATE TABLE public.teacher_students (
  teacher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (teacher_id, student_id)
);

-- Wyszukiwanie nauczycieli dla danego ucznia (PK pokrywa kierunek teacher→student).
CREATE INDEX teacher_students_student_id_idx
  ON public.teacher_students (student_id);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Po rejestracji w auth.users automatycznie tworzymy wpis w profiles.
-- first_name/last_name są NOT NULL — pobieramy je z raw_user_meta_data,
-- a w razie braku wstawiamy pusty string (aplikacja powinna wymusić
-- uzupełnienie danych przy pierwszym logowaniu).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, first_name, last_name, phone, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'first_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'last_name',  ''),
    NEW.raw_user_meta_data ->> 'phone',
    COALESCE((NEW.raw_user_meta_data ->> 'role')::public.user_role, 'student')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teacher_students ENABLE ROW LEVEL SECURITY;

-- ---- profiles ----

CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING      (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Polityki SELECT są permissive i łączone OR — ta polityka rozszerza
-- widoczność: nauczyciel widzi profile uczniów, z którymi ma powiązanie
-- w teacher_students.
CREATE POLICY "Teachers can read their students profiles"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.teacher_students ts
      WHERE ts.teacher_id = auth.uid()
        AND ts.student_id = profiles.id
    )
  );

-- ---- teacher_students ----
-- Obie strony mogą czytać swoje powiązania. Insert/delete celowo bez polityk —
-- powiązania tworzy backend service_role (bypassuje RLS); dodanie polityk
-- zapisu odłożone do migracji, w której wejdzie flow zapraszania.

CREATE POLICY "Teachers can read own links"
  ON public.teacher_students FOR SELECT
  TO authenticated
  USING (auth.uid() = teacher_id);

CREATE POLICY "Students can read own links"
  ON public.teacher_students FOR SELECT
  TO authenticated
  USING (auth.uid() = student_id);
