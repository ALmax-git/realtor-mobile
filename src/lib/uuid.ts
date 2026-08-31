/**
 * Local id generator for records created offline.
 *
 * Prefers the platform `crypto.randomUUID()` (available in the Tauri
 * webview) but falls back to a manual RFC4122-ish v4 implementation so id
 * generation never becomes the reason a draft can't be saved offline.
 */
export function generateLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
