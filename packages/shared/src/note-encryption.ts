// ── Note field encryption wrappers ───────────────────────────────────────────

import { encryptField, decryptField } from "./crypto.js";
import type { UserProfile } from "./types.js";

/** Unwrap a CBL Encryptable value: {"@type":"encryptable","value":"..."} → "..." */
export function unwrapEncryptable(val: unknown): string {
  if (val && typeof val === "object" && (val as Record<string, unknown>)["@type"] === "encryptable") {
    return String((val as Record<string, unknown>).value ?? "");
  }
  return String(val ?? "");
}

export async function encryptNoteFields(
  title: string,
  content: string,
  user: UserProfile | null,
  password: string | null
): Promise<{ title: string; content: string }> {
  if (!user || user.encryption_mode !== "app-level" || !password || !user.crypto_salt) {
    return { title, content };
  }
  return {
    title: await encryptField(title, password, user.crypto_salt),
    content: await encryptField(content, password, user.crypto_salt),
  };
}

export async function decryptNoteFields(
  title: string,
  content: string,
  user: UserProfile | null,
  password: string | null
): Promise<{ title: string; content: string }> {
  if (!user || user.encryption_mode !== "app-level" || !password || !user.crypto_salt) {
    return { title, content };
  }
  try {
    return {
      title: await decryptField(title, password, user.crypto_salt),
      content: await decryptField(content, password, user.crypto_salt),
    };
  } catch {
    return { title, content };
  }
}
