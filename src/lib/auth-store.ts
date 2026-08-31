/**
 * Secure local persistence for the auth token, backed by
 * `@tauri-apps/plugin-store` (a file in the app's data dir, managed by the
 * Rust side of Tauri) rather than `localStorage` / `sessionStorage`, which
 * are not appropriate for anything sensitive in a WebView context.
 */
import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "auth.json";
const TOKEN_KEY = "token";
const USER_KEY = "cachedUser";

let storePromise: Promise<Store> | null = null;

// In-memory fallback for a session where the agent did *not* check
// "remember me": the token is usable for the rest of this run but is never
// written to disk, so the next app launch won't find it and will show login.
let sessionToken: string | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(STORE_FILE, { autoSave: true });
  }
  return storePromise;
}

/** Read the current auth token: in-memory session token first, then disk. */
export async function getStoredToken(): Promise<string | null> {
  if (sessionToken) {
    return sessionToken;
  }
  const store = await getStore();
  const token = await store.get<string>(TOKEN_KEY);
  return token ?? null;
}

/**
 * Store the auth token after a successful login.
 * When `remember` is true it's persisted to disk (survives app restarts);
 * otherwise it's kept only in memory for the current run.
 */
export async function setStoredToken(
  token: string,
  remember: boolean,
): Promise<void> {
  sessionToken = token;
  if (remember) {
    const store = await getStore();
    await store.set(TOKEN_KEY, token);
    await store.save();
  }
}

/** Remove any persisted/in-memory auth token (logout, or invalid/expired). */
export async function clearStoredToken(): Promise<void> {
  sessionToken = null;
  const store = await getStore();
  await store.delete(TOKEN_KEY);
  await store.save();
}

/**
 * Best-effort cache of the last-known `/api/user` response, so a cold start
 * with no connectivity (see `main.ts`'s `init()`) can still show a name
 * instead of a bare "Signed in" placeholder while trusting the cached token.
 * Not sensitive like the token itself, so it's fine to persist unconditionally
 * regardless of "remember me" — worst case it just sits unused until the next
 * successful login overwrites or clears it.
 */
export async function getCachedUser<T = unknown>(): Promise<T | null> {
  const store = await getStore();
  const user = await store.get<T>(USER_KEY);
  return user ?? null;
}

export async function setCachedUser(user: unknown): Promise<void> {
  const store = await getStore();
  await store.set(USER_KEY, user);
  await store.save();
}

export async function clearCachedUser(): Promise<void> {
  const store = await getStore();
  await store.delete(USER_KEY);
  await store.save();
}
