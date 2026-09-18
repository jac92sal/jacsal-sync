-- Runtime-created settings and sealed secrets (see shared/secretbox.ts).
-- Secret values are AES-GCM ciphertext under the app master key; never plaintext.
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  sealed      INTEGER NOT NULL DEFAULT 0,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
