-- Migration 056: Tambah INDEX expires_at di app_sessions
-- Mempercepat query cleanup session expired dan validasi token.

CREATE INDEX IF NOT EXISTS idx_app_sessions_expires_at
    ON app_sessions (expires_at);

-- Cleanup manual session expired (jalankan sekali saat migrasi):
DELETE FROM app_sessions WHERE expires_at <= NOW();
