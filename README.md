# Realtor Mobile

Field-agent Tauri app for pension-equity mortgage client intake. Vanilla
HTML/TypeScript + [Alpine.js](https://alpinejs.dev/) for interactivity +
[Tailwind CSS](https://tailwindcss.com/) for styling — deliberately no
React/Vue/Svelte, to keep this small and fast on field devices.

This is a from-scratch rewrite; the backend lives in the sibling
`realtor-web` Laravel + Sanctum project. `realtor_v1.0.0.old` is historical
reference only — not a starting point for this app.

## Status

Only the auth/login flow is implemented so far (this phase). The real
data-collection wizard/dashboard is a later phase — right now, a successful
login lands on a placeholder "signed in" screen.

## Setup

```sh
npm install
cp .env.example .env   # then edit VITE_API_BASE if not using local realtor-web
npm run dev             # or: npm run tauri dev
```

`VITE_API_BASE` (see `.env.example`) points at the Laravel + Sanctum backend
and must not be hardcoded to localhost for field use — see the TODO in
`src/lib/config.ts` for where a later settings screen should add a runtime
override on top of this build-time default.

## Auth flow

- `src/lib/api.ts` — API client for `POST /api/login`, `GET /api/user`,
  `POST /api/logout`.
- `src/lib/auth-store.ts` — token persistence via `@tauri-apps/plugin-store`
  (not `localStorage`), with an in-memory-only fallback when "remember me"
  is off.
- `src/lib/config.ts` — resolves `API_BASE` (env var today, runtime-override
  TODO for later).
- `src/main.ts` / `index.html` — the Alpine component (`authApp`) driving the
  loading / login / placeholder-app views.

## Offline / poor-network note

Field agents work in places with weak or no connectivity. Logging in
necessarily requires a live request, but everything *built after this
phase* (the data-collection wizard) should be **local-first**: write to
local storage immediately and treat syncing to the backend as a background
concern, not a blocking one. The API calls here are already isolated in
`src/lib/*` modules specifically so a future sync/queue layer can wrap them
without the UI needing to know whether the device is online. No offline
sync is implemented yet — this is just a placement note for that work.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
# realtor-mobile
