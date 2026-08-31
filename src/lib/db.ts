/**
 * Local SQLite handle, backed by `tauri-plugin-sql`.
 *
 * The schema itself lives in Rust (`src-tauri/src/lib.rs`, as versioned
 * `tauri-plugin-sql` migrations) rather than being created ad hoc from JS,
 * so it runs once, in order, before any webview code touches the database —
 * important because migrations can be added over time as the app evolves
 * without agents losing their local drafts.
 */
import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:realtor.db";

let dbPromise: Promise<Database> | null = null;

/** Lazily open (and cache) the single SQLite connection used app-wide. */
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
  }
  return dbPromise;
}
