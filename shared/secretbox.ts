/**
 * AES-256-GCM envelope for small secrets that must live in D1 (values the app
 * creates at runtime, which the Secrets Store cannot receive from a Worker).
 * The key-encrypting key (KEK) itself stays in the Secrets Store.
 *
 * Sealed format: base64( 12-byte IV || ciphertext+tag ).
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

async function importKek(kekMaterial: string): Promise<CryptoKey> {
  // Any Secrets Store string works as material: it is stretched with HKDF to a 256-bit AES key,
  // so the KEK can be a base64 random value or any sufficiently long random secret.
  const ikm = await crypto.subtle.importKey('raw', enc.encode(kekMaterial.trim()), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('jacsal-sync/app_settings'), info: enc.encode('secretbox-v1') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function seal(kekMaterial: string, plaintext: string): Promise<string> {
  const key = await importKek(kekMaterial)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)))
  const out = new Uint8Array(iv.byteLength + ct.byteLength)
  out.set(iv, 0); out.set(ct, iv.byteLength)
  return btoa(String.fromCharCode(...out))
}

export async function open(kekMaterial: string, sealed: string): Promise<string> {
  const key = await importKek(kekMaterial)
  const buf = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0))
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12))
  return dec.decode(pt)
}
