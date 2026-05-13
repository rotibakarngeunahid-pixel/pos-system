-- 006_create_storage_buckets_deposit_proofs_and_qris.sql
-- Create two storage buckets (deposit-proofs private, deposit-qris public) if not exist

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'deposit-proofs') THEN
    INSERT INTO storage.buckets (id, name, "public", file_size_limit, allowed_mime_types)
    VALUES ('deposit-proofs', 'deposit-proofs', false, 5242880,
            ARRAY['image/jpeg','image/png','image/webp','application/pdf']);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'deposit-qris') THEN
    INSERT INTO storage.buckets (id, name, "public", file_size_limit, allowed_mime_types)
    VALUES ('deposit-qris', 'deposit-qris', true, 5242880,
            ARRAY['image/png','image/jpeg','image/webp']);
  END IF;
END$$;

COMMIT;
