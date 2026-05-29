-- Migration 055: Tabel login_attempts untuk rate limiting login
-- Mencatat setiap percobaan login (berhasil dan gagal) per username + IP
-- Backend membaca tabel ini untuk blokir setelah 5 gagal dalam 5 menit.

CREATE TABLE IF NOT EXISTS login_attempts (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username     VARCHAR(100)    NOT NULL,
    ip_address   VARCHAR(45)     NOT NULL DEFAULT 'unknown',
    success      TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1=berhasil, 0=gagal',
    attempted_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Index untuk query rate-limit (per username, per IP, dalam window waktu)
CREATE INDEX IF NOT EXISTS idx_login_attempts_username_time
    ON login_attempts (username, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time
    ON login_attempts (ip_address, attempted_at DESC);

-- Index untuk cleanup otomatis data lama
CREATE INDEX IF NOT EXISTS idx_login_attempts_time
    ON login_attempts (attempted_at);

-- Opsional: cleanup data lebih dari 24 jam
-- Jalankan manual atau lewat cron MySQL/cPanel jika diperlukan:
-- DELETE FROM login_attempts WHERE attempted_at < DATE_SUB(NOW(), INTERVAL 24 HOUR);
