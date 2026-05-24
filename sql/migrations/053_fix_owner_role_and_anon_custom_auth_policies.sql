-- Fix app-level custom auth compatibility.
--
-- This project stores its own session in localStorage and talks to Supabase
-- with the anon key. The frontend and several RPCs support role='owner', so
-- the users role constraint must allow it. Toppings and API key management are
-- also driven by the admin UI over the anon client; RLS policies must match
-- that app-layer auth model.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'owner', 'staff', 'investor'));

DO $$
BEGIN
  IF to_regclass('public.toppings') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.toppings TO anon, authenticated';
    EXECUTE 'DROP POLICY IF EXISTS "toppings_select" ON public.toppings';
    EXECUTE 'DROP POLICY IF EXISTS "toppings_insert" ON public.toppings';
    EXECUTE 'DROP POLICY IF EXISTS "toppings_update" ON public.toppings';
    EXECUTE 'DROP POLICY IF EXISTS "toppings_delete" ON public.toppings';
    EXECUTE 'CREATE POLICY "toppings_select" ON public.toppings FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "toppings_insert" ON public.toppings FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "toppings_update" ON public.toppings FOR UPDATE USING (true) WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "toppings_delete" ON public.toppings FOR DELETE USING (true)';
  END IF;

  IF to_regclass('public.product_toppings') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.product_toppings TO anon, authenticated';
    EXECUTE 'DROP POLICY IF EXISTS "pt_select" ON public.product_toppings';
    EXECUTE 'DROP POLICY IF EXISTS "pt_insert" ON public.product_toppings';
    EXECUTE 'DROP POLICY IF EXISTS "pt_update" ON public.product_toppings';
    EXECUTE 'DROP POLICY IF EXISTS "pt_delete" ON public.product_toppings';
    EXECUTE 'CREATE POLICY "pt_select" ON public.product_toppings FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "pt_insert" ON public.product_toppings FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "pt_update" ON public.product_toppings FOR UPDATE USING (true) WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "pt_delete" ON public.product_toppings FOR DELETE USING (true)';
  END IF;

  IF to_regclass('public.api_keys') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_keys TO anon, authenticated';
    EXECUTE 'DROP POLICY IF EXISTS "apikeys_select" ON public.api_keys';
    EXECUTE 'DROP POLICY IF EXISTS "apikeys_insert" ON public.api_keys';
    EXECUTE 'DROP POLICY IF EXISTS "apikeys_update" ON public.api_keys';
    EXECUTE 'DROP POLICY IF EXISTS "apikeys_delete" ON public.api_keys';
    EXECUTE 'CREATE POLICY "apikeys_select" ON public.api_keys FOR SELECT USING (true)';
    EXECUTE 'CREATE POLICY "apikeys_insert" ON public.api_keys FOR INSERT WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "apikeys_update" ON public.api_keys FOR UPDATE USING (true) WITH CHECK (true)';
    EXECUTE 'CREATE POLICY "apikeys_delete" ON public.api_keys FOR DELETE USING (true)';
  END IF;

  IF to_regclass('public.toppings_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.toppings_id_seq TO anon, authenticated';
  END IF;

  IF to_regclass('public.product_toppings_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.product_toppings_id_seq TO anon, authenticated';
  END IF;

  IF to_regclass('public.api_keys_id_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.api_keys_id_seq TO anon, authenticated';
  END IF;
END $$;
