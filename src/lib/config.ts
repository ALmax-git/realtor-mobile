/**
 * Runtime configuration for the Realtor mobile app.
 *
 * Field agents run this app against a real, remotely-deployed backend, so the
 * API base URL must never be hardcoded to localhost. For now it is provided
 * at build time via the `VITE_API_BASE` environment variable (see `.env` /
 * `.env.example`), defaulting to the local `realtor-web` dev server.
 *
 * TODO(settings-screen, later phase): a settings screen should let an agent
 * override the API base at *runtime* (e.g. pointing a device at a staging
 * vs. production backend without a rebuild). When that screen exists, read
 * an override value from the same secure `@tauri-apps/plugin-store` used for
 * the auth token (e.g. key "settings.apiBase") here, falling back to
 * VITE_API_BASE when no override has been saved. `getApiBase()` is the single
 * choke point to change, and it's async precisely so it can await a store
 * read.
 */

const DEFAULT_API_BASE = "http://localhost:8000";

const BUILD_TIME_API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, "") ||
  DEFAULT_API_BASE;

/**
 * Resolve the API base URL to use for backend requests.
 *
 * This is async on purpose (see TODO above) so callers are already set up to
 * `await` a future runtime override without needing to change call sites.
 */
export async function getApiBase(): Promise<string> {
  // Later: check the settings store for a runtime override before falling
  // back to the build-time default.
  return BUILD_TIME_API_BASE;
}

/** Fixed device name sent to Sanctum's personal access token creation. */
export const DEVICE_NAME = "realtor-mobile";
