-- Migration 058: Branch Ingredient Mapping (MySQL / cPanel)
-- Memungkinkan admin men-assign bahan baku ke cabang tertentu.
-- Aturan: jika bahan tidak memiliki assignment → tersedia di semua cabang (backwards compatible).
--         jika bahan memiliki 1+ assignment → hanya tersedia di cabang yang di-assign.

CREATE TABLE IF NOT EXISTS branch_ingredient_assignments (
  branch_id     INT NOT NULL,
  ingredient_id INT NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT NOW(),
  PRIMARY KEY (branch_id, ingredient_id),
  INDEX idx_bia_ingredient (ingredient_id),
  INDEX idx_bia_branch (branch_id)
);
