// ── Auth / URL helpers ────────────────────────────────────────────────────────

/**
 * If the server returns a sync_url with localhost/127.0.0.1, replace the host
 * with the hostname the client actually used to reach the server.
 * Needed on Android where localhost refers to the device, not the host machine.
 */
export function resolveSyncUrl(syncUrl: string, serverUrl: string): string {
  try {
    const sync = new URL(syncUrl);
    // Always replace hostname with the one used to reach the auth server.
    // Critical for Android/iOS where localhost points to the device itself.
    sync.hostname = new URL(serverUrl).hostname;
    return sync.toString();
  } catch { /* leave as-is if parsing fails */ }
  return syncUrl;
}

/** Per-user database name, safe for use as a filename. */
export function userDbName(username: string): string {
  return "notes-" + username.replace(/[^a-zA-Z0-9_-]/g, "_");
}
