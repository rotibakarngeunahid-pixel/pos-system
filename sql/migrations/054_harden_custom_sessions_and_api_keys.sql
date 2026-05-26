-- Migration 054: Harden custom sessions, API keys, and topping mutations.
--
-- Fatal issue fixed:
--   Previous migrations granted direct SELECT/INSERT/UPDATE/DELETE on api_keys
--   to the public anon role. Anyone with the public Supabase anon key could
--   read integration API keys and export sales/cash data. Topping writes were
--   also public. This migration moves those mutations behind admin RPCs and
--   gives app sessions a server-validated bearer token.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Server-side app sessions for the existing custom auth flow.
CREATE TABLE IF NOT EXISTS public.app_sessions (
  token_hash   text PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_sessions_user_expires
  ON public.app_sessions(user_id, expires_at);

ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_sessions FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.toppings (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  price      numeric(12,2) NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_toppings (
  id         serial PRIMARY KEY,
  product_id integer NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  topping_id integer NOT NULL REFERENCES public.toppings(id) ON DELETE CASCADE,
  UNIQUE(product_id, topping_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_toppings_unique_pair
  ON public.product_toppings(product_id, topping_id);

CREATE TABLE IF NOT EXISTS public.api_keys (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  key_value  text NOT NULL UNIQUE,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Replace login so new browser sessions receive a server-verifiable token.
DROP FUNCTION IF EXISTS public.pos_login(text, text);

CREATE FUNCTION public.pos_login(p_name text, p_password text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_user       record;
  v_token      text;
  v_token_hash text;
  v_expires_at timestamptz := now() + interval '8 hours';
BEGIN
  SELECT u.id, u.name, u.role, u.branch_id, COALESCE(u.is_active, true) AS is_active
  INTO v_user
  FROM public.users u
  WHERE lower(trim(u.name)) = lower(trim(p_name))
    AND COALESCE(u.is_active, true) = true
    AND CASE
      WHEN u.password = p_password THEN true
      WHEN u.password LIKE '$1$%' OR u.password LIKE '$2%' OR u.password LIKE '$5$%' OR u.password LIKE '$6$%'
        THEN u.password = crypt(p_password, u.password)
      ELSE false
    END
  ORDER BY u.id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  DELETE FROM public.app_sessions
  WHERE user_id = v_user.id
    AND expires_at <= now();

  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');

  INSERT INTO public.app_sessions(token_hash, user_id, expires_at)
  VALUES (v_token_hash, v_user.id, v_expires_at);

  RETURN jsonb_build_object(
    'id',            v_user.id,
    'name',          v_user.name,
    'role',          v_user.role,
    'branch_id',     v_user.branch_id,
    'is_active',     v_user.is_active,
    'session_token', v_token,
    'expires_at',    v_expires_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_login(text, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.rbn_validate_session(p_session_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_hash text;
  v_user record;
BEGIN
  IF NULLIF(trim(COALESCE(p_session_token, '')), '') IS NULL THEN
    RETURN NULL;
  END IF;

  v_hash := encode(digest(p_session_token, 'sha256'), 'hex');

  SELECT u.id, u.name, u.role, u.branch_id, COALESCE(u.is_active, true) AS is_active, s.expires_at
  INTO v_user
  FROM public.app_sessions s
  JOIN public.users u ON u.id = s.user_id
  WHERE s.token_hash = v_hash
    AND s.expires_at > now()
    AND COALESCE(u.is_active, true) = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.app_sessions
  SET last_seen_at = now()
  WHERE token_hash = v_hash;

  RETURN jsonb_build_object(
    'id',            v_user.id,
    'name',          v_user.name,
    'role',          v_user.role,
    'branch_id',     v_user.branch_id,
    'is_active',     v_user.is_active,
    'session_token', p_session_token,
    'expires_at',    v_user.expires_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rbn_validate_session(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.rbn_require_admin_session(p_session_token text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_hash text;
  v_user record;
BEGIN
  IF NULLIF(trim(COALESCE(p_session_token, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Sesi admin tidak ditemukan. Silakan login ulang.'
      USING ERRCODE = '28000';
  END IF;

  v_hash := encode(digest(p_session_token, 'sha256'), 'hex');

  SELECT u.id, u.role
  INTO v_user
  FROM public.app_sessions s
  JOIN public.users u ON u.id = s.user_id
  WHERE s.token_hash = v_hash
    AND s.expires_at > now()
    AND COALESCE(u.is_active, true) = true
  LIMIT 1;

  IF NOT FOUND OR v_user.role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Sesi admin tidak valid atau sudah kedaluwarsa.'
      USING ERRCODE = '28000';
  END IF;

  UPDATE public.app_sessions
  SET last_seen_at = now()
  WHERE token_hash = v_hash;

  RETURN v_user.id;
END;
$$;

REVOKE ALL ON FUNCTION public.rbn_require_admin_session(text)
  FROM PUBLIC, anon, authenticated;

-- API key management is now RPC-only.
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "apikeys_select" ON public.api_keys;
DROP POLICY IF EXISTS "apikeys_insert" ON public.api_keys;
DROP POLICY IF EXISTS "apikeys_update" ON public.api_keys;
DROP POLICY IF EXISTS "apikeys_delete" ON public.api_keys;
REVOKE ALL ON TABLE public.api_keys FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.api_keys_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rbn_admin_list_api_keys(p_session_token text)
RETURNS TABLE (
  id integer,
  name text,
  key_value text,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.rbn_require_admin_session(p_session_token);

  RETURN QUERY
  SELECT ak.id, ak.name, ak.key_value, ak.is_active, ak.created_at
  FROM public.api_keys ak
  ORDER BY ak.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.rbn_admin_create_api_key(
  p_session_token text,
  p_name text
)
RETURNS TABLE (
  id integer,
  name text,
  key_value text,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_name text := NULLIF(trim(COALESCE(p_name, '')), '');
  v_key  text;
BEGIN
  PERFORM public.rbn_require_admin_session(p_session_token);

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Nama API key wajib diisi.' USING ERRCODE = '22023';
  END IF;

  v_key := 'rbn_' || encode(gen_random_bytes(32), 'hex');

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.api_keys AS ak(name, key_value, is_active)
    VALUES (v_name, v_key, true)
    RETURNING ak.id, ak.name, ak.key_value, ak.is_active, ak.created_at
  )
  SELECT i.id, i.name, i.key_value, i.is_active, i.created_at
  FROM inserted i;
END;
$$;

CREATE OR REPLACE FUNCTION public.rbn_admin_set_api_key_active(
  p_session_token text,
  p_id integer,
  p_is_active boolean
)
RETURNS TABLE (
  id integer,
  name text,
  key_value text,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.rbn_require_admin_session(p_session_token);

  RETURN QUERY
  WITH updated AS (
    UPDATE public.api_keys ak
    SET is_active = COALESCE(p_is_active, false)
    WHERE ak.id = p_id
    RETURNING ak.id, ak.name, ak.key_value, ak.is_active, ak.created_at
  )
  SELECT u.id, u.name, u.key_value, u.is_active, u.created_at
  FROM updated u;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'API key tidak ditemukan.' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rbn_admin_delete_api_key(
  p_session_token text,
  p_id integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_deleted boolean := false;
BEGIN
  PERFORM public.rbn_require_admin_session(p_session_token);

  DELETE FROM public.api_keys ak
  WHERE ak.id = p_id
  RETURNING true INTO v_deleted;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'API key tidak ditemukan.' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rbn_admin_list_api_keys(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rbn_admin_create_api_key(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rbn_admin_set_api_key_active(text, integer, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rbn_admin_delete_api_key(text, integer) TO anon, authenticated;

-- Toppings remain publicly readable for POS, but writes are admin RPC-only.
ALTER TABLE public.toppings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_toppings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "toppings_select" ON public.toppings;
DROP POLICY IF EXISTS "toppings_insert" ON public.toppings;
DROP POLICY IF EXISTS "toppings_update" ON public.toppings;
DROP POLICY IF EXISTS "toppings_delete" ON public.toppings;
DROP POLICY IF EXISTS "pt_select" ON public.product_toppings;
DROP POLICY IF EXISTS "pt_insert" ON public.product_toppings;
DROP POLICY IF EXISTS "pt_update" ON public.product_toppings;
DROP POLICY IF EXISTS "pt_delete" ON public.product_toppings;

CREATE POLICY "toppings_select" ON public.toppings FOR SELECT USING (true);
CREATE POLICY "pt_select" ON public.product_toppings FOR SELECT USING (true);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.toppings FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.product_toppings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.toppings TO anon, authenticated;
GRANT SELECT ON TABLE public.product_toppings TO anon, authenticated;
REVOKE ALL ON SEQUENCE public.toppings_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.product_toppings_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rbn_admin_save_topping(
  p_session_token text,
  p_id integer,
  p_name text,
  p_price numeric,
  p_is_active boolean
)
RETURNS TABLE (
  id integer,
  name text,
  price numeric,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_name text := NULLIF(trim(COALESCE(p_name, '')), '');
  v_price numeric := COALESCE(p_price, 0);
BEGIN
  PERFORM public.rbn_require_admin_session(p_session_token);

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Nama topping wajib diisi.' USING ERRCODE = '22023';
  END IF;
  IF v_price < 0 THEN
    RAISE EXCEPTION 'Harga topping tidak boleh negatif.' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NULL THEN
    RETURN QUERY
    WITH inserted AS (
      INSERT INTO public.toppings AS t(name, price, is_active)
      VALUES (v_name, v_price, COALESCE(p_is_active, true))
      RETURNING t.id, t.name, t.price, t.is_active, t.created_at
    )
    SELECT i.id, i.name, i.price, i.is_active, i.created_at
    FROM inserted i;
  ELSE
    RETURN QUERY
    WITH updated AS (
      UPDATE public.toppings t
      SET name = v_name,
          price = v_price,
          is_active = COALESCE(p_is_active, true)
      WHERE t.id = p_id
      RETURNING t.id, t.name, t.price, t.is_active, t.created_at
    )
    SELECT u.id, u.name, u.price, u.is_active, u.created_at
    FROM updated u;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Topping tidak ditemukan.' USING ERRCODE = 'P0002';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rbn_admin_set_topping_active(
  p_session_token text,
  p_id integer,
  p_is_active boolean
)
RETURNS TABLE (
  id integer,
  name text,
  price numeric,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.rbn_require_admin_session(p_session_token);

  RETURN QUERY
  WITH updated AS (
    UPDATE public.toppings t
    SET is_active = COALESCE(p_is_active, false)
    WHERE t.id = p_id
    RETURNING t.id, t.name, t.price, t.is_active, t.created_at
  )
  SELECT u.id, u.name, u.price, u.is_active, u.created_at
  FROM updated u;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Topping tidak ditemukan.' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rbn_admin_delete_topping(
  p_session_token text,
  p_id integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_deleted boolean := false;
BEGIN
  PERFORM public.rbn_require_admin_session(p_session_token);

  DELETE FROM public.toppings t
  WHERE t.id = p_id
  RETURNING true INTO v_deleted;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Topping tidak ditemukan.' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.rbn_admin_set_product_topping(
  p_session_token text,
  p_product_id integer,
  p_topping_id integer,
  p_enabled boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.rbn_require_admin_session(p_session_token);

  IF COALESCE(p_enabled, false) THEN
    INSERT INTO public.product_toppings(product_id, topping_id)
    VALUES (p_product_id, p_topping_id)
    ON CONFLICT (product_id, topping_id) DO NOTHING;
  ELSE
    DELETE FROM public.product_toppings pt
    WHERE pt.product_id = p_product_id
      AND pt.topping_id = p_topping_id;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rbn_admin_save_topping(text, integer, text, numeric, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rbn_admin_set_topping_active(text, integer, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rbn_admin_delete_topping(text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rbn_admin_set_product_topping(text, integer, integer, boolean) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
