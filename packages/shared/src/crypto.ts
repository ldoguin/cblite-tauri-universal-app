// ── WebCrypto AES-GCM helpers ─────────────────────────────────────────────────
// Used only when encryption_mode === "app-level".
// Key derivation: PBKDF2 (SHA-256, 200 000 iterations) → AES-GCM 256-bit key.
// Salt: 32 random bytes, stored as base64 in the user_profile doc (not secret).

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt a plaintext string. Returns "ivB64:ciphertextB64". */
export async function encryptField(
  plaintext: string,
  password: string,
  saltB64: string
): Promise<string> {
  const salt = base64ToBytes(saltB64);
  const key = await deriveKey(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );
  return `${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/** Decrypt a value produced by encryptField. Returns the original plaintext. */
export async function decryptField(
  encoded: string,
  password: string,
  saltB64: string
): Promise<string> {
  const colonIdx = encoded.indexOf(":");
  if (colonIdx === -1) return encoded; // not encrypted, return as-is
  const ivB64 = encoded.slice(0, colonIdx);
  const ciphertextB64 = encoded.slice(colonIdx + 1);
  const salt = base64ToBytes(saltB64);
  const key = await deriveKey(password, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ciphertextB64)
  );
  return new TextDecoder().decode(plaintext);
}

/** Generate a fresh 32-byte random salt. Returns base64. */
export function generateSalt(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}
