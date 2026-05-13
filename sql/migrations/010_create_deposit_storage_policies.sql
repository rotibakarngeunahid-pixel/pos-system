-- 010_create_deposit_storage_policies.sql
-- Allow app uploads/reads for deposit proof and QRIS storage buckets.

BEGIN;

DROP POLICY IF EXISTS deposit_proofs_insert ON storage.objects;
DROP POLICY IF EXISTS deposit_proofs_select ON storage.objects;
DROP POLICY IF EXISTS deposit_qris_insert ON storage.objects;
DROP POLICY IF EXISTS deposit_qris_update ON storage.objects;
DROP POLICY IF EXISTS deposit_qris_select ON storage.objects;

CREATE POLICY deposit_proofs_insert
  ON storage.objects
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'deposit-proofs');

CREATE POLICY deposit_proofs_select
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'deposit-proofs');

CREATE POLICY deposit_qris_insert
  ON storage.objects
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'deposit-qris');

CREATE POLICY deposit_qris_update
  ON storage.objects
  FOR UPDATE
  TO anon, authenticated
  USING (bucket_id = 'deposit-qris')
  WITH CHECK (bucket_id = 'deposit-qris');

CREATE POLICY deposit_qris_select
  ON storage.objects
  FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'deposit-qris');

COMMIT;
