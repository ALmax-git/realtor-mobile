import Alpine from "alpinejs";
import "./styles.css";
import {
  login as apiLogin,
  fetchCurrentUser,
  logout as apiLogout,
  ApiError,
  type AuthUser,
} from "./lib/api";
import {
  getStoredToken,
  setStoredToken,
  clearStoredToken,
  getCachedUser,
  setCachedUser,
  clearCachedUser,
} from "./lib/auth-store";
import { clientWorkspace } from "./client-workspace";

// NOTE on offline / poor-network support:
// The login flow itself requires a live connection (there's no local
// credential to check against), so `view: 'loading'` and the login screen
// both assume network access. Everything *after* login — the client
// data-collection wizard, `client-workspace.ts` — is built local-first:
// every save goes straight to SQLite (`lib/clients-repo.ts`) and a
// background sync engine (`lib/sync-engine.ts`) pushes it opportunistically.
// `authApp` only tells that engine *when* to run, via the
// `client-auth-ready` / `client-auth-logout` window events dispatched below
// — it never touches sync/network logic for the data-collection feature
// itself, keeping the two concerns (auth vs. intake data) decoupled.

type View = "loading" | "login" | "app";

interface AuthAppState {
  view: View;
  email: string;
  password: string;
  remember: boolean;
  loading: boolean;
  error: string;
  user: AuthUser | null;
  init(): Promise<void>;
  submitLogin(): Promise<void>;
  logoutAction(): Promise<void>;
}

function authApp(): AuthAppState {
  return {
    view: "loading",
    email: "",
    password: "",
    remember: true,
    loading: false,
    error: "",
    user: null,

    // Alpine automatically calls `init()` when the component is created.
    async init() {
      const token = await getStoredToken();
      if (!token) {
        this.view = "login";
        return;
      }

      try {
        this.user = await fetchCurrentUser(token);
        await setCachedUser(this.user);
        this.view = "app";
        window.dispatchEvent(new CustomEvent("client-auth-ready"));
      } catch (err) {
        // Distinguish *why* the check failed. Only a real rejection of the
        // token itself (401/403) means the token is actually invalid — a
        // network failure (`ApiError` with status 0, thrown by api.ts when
        // `fetch` itself throws), a timeout, or a flaky 5xx tells us nothing
        // about the token. Bouncing an offline field agent to the login
        // screen on every cold start would defeat the entire "everything
        // after login is local-first" design, so in that case we trust the
        // cached token and let them in with whatever user info was cached
        // from the last successful check (or a null placeholder — the
        // header falls back to a generic "Signed in" label).
        const tokenRejected =
          err instanceof ApiError && (err.status === 401 || err.status === 403);

        if (tokenRejected) {
          await clearStoredToken();
          await clearCachedUser();
          this.view = "login";
          return;
        }

        this.user = await getCachedUser<AuthUser>();
        this.view = "app";
        window.dispatchEvent(new CustomEvent("client-auth-ready"));
      }
    },

    async submitLogin() {
      this.error = "";

      if (!this.email || !this.password) {
        this.error = "Please enter your email and password.";
        return;
      }

      this.loading = true;
      try {
        const { token } = await apiLogin(this.email, this.password);
        await setStoredToken(token, this.remember);

        try {
          this.user = await fetchCurrentUser(token);
          await setCachedUser(this.user);
        } catch {
          // Login succeeded but the follow-up profile fetch failed (e.g.
          // flaky connection right after auth) — don't block entry on it.
          this.user = null;
        }

        this.password = "";
        this.view = "app";
        window.dispatchEvent(new CustomEvent("client-auth-ready"));
      } catch (err) {
        this.error =
          err instanceof ApiError
            ? err.message
            : "Something went wrong. Please try again.";
      } finally {
        this.loading = false;
      }
    },

    async logoutAction() {
      this.loading = true;
      try {
        const token = await getStoredToken();
        if (token) {
          await apiLogout(token);
        }
      } finally {
        await clearStoredToken();
        await clearCachedUser();
        this.user = null;
        this.email = "";
        this.password = "";
        this.loading = false;
        this.view = "login";
        window.dispatchEvent(new CustomEvent("client-auth-logout"));
      }
    },
  };
}

Alpine.data("authApp", authApp);
Alpine.data("clientWorkspace", clientWorkspace);

declare global {
  interface Window {
    Alpine: typeof Alpine;
  }
}
window.Alpine = Alpine;

Alpine.start();
