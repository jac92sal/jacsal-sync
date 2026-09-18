import { open, seal } from '../../shared/secretbox'
import { one, run } from './db'

/** Sealed app settings (AES-GCM under APP_KEK in the Secrets Store), stored in app_settings. */
export async function getSealed(env: Env, key: string): Promise<string | null> {
  const row = await one<{ value: string }>(env.DB, 'SELECT value FROM app_settings WHERE key = ? AND sealed = 1', key)
  if (!row?.value) return null
  return open(await env.APP_KEK.get(), row.value)
}

export async function setSealed(env: Env, key: string, value: string, actor: string): Promise<void> {
  const sealed = await seal(await env.APP_KEK.get(), value)
  await run(env.DB, `INSERT INTO app_settings (key, value, sealed, updated_by, updated_at) VALUES (?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, sealed = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, key, sealed, actor)
}

export async function clearSealed(env: Env, key: string): Promise<void> {
  await run(env.DB, 'DELETE FROM app_settings WHERE key = ?', key)
}

export async function hasSealed(env: Env, key: string): Promise<boolean> {
  return !!(await one<{ key: string }>(env.DB, 'SELECT key FROM app_settings WHERE key = ? AND sealed = 1', key))
}
