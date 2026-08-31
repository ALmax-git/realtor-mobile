/**
 * Thin client for the Realtor backend auth API (Laravel + Sanctum, built in
 * the sibling `realtor-web` project). Only the auth endpoints needed for the
 * login flow live here; the data-collection API surface is a later phase.
 */
import { getApiBase, DEVICE_NAME } from "./config";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface LoginResponse {
  token: string;
}

export interface AuthUser {
  id: number | string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

/**
 * Pull a human-readable message out of Laravel's standard error shapes.
 * Exported so other API modules (e.g. `clients-api.ts`) reuse the same
 * 401/422/generic-HTTP-status messaging instead of re-implementing it.
 */
export async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.message === "string" && body.message.length > 0) {
      return body.message;
    }
    if (body?.errors && typeof body.errors === "object") {
      const firstField = Object.values(body.errors)[0];
      if (Array.isArray(firstField) && typeof firstField[0] === "string") {
        return firstField[0];
      }
    }
  } catch {
    // Response wasn't JSON (or was empty) — fall through to a generic message.
  }

  if (response.status === 401) {
    return "Invalid email or password.";
  }
  if (response.status === 422) {
    return "Please check your details and try again.";
  }
  return `Something went wrong (HTTP ${response.status}). Please try again.`;
}

/**
 * POST /api/login
 * Body: { email, password, device_name } -> { token } on success.
 * Throws ApiError with an inline-displayable message on 401/422/etc.
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  const apiBase = await getApiBase();

  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        device_name: DEVICE_NAME,
      }),
    });
  } catch {
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again.",
      0,
    );
  }

  if (!response.ok) {
    throw new ApiError(await extractErrorMessage(response), response.status);
  }

  const data = await response.json();
  if (typeof data?.token !== "string") {
    throw new ApiError("Unexpected response from server.", response.status);
  }

  return { token: data.token };
}

/**
 * GET /api/user with Authorization: Bearer <token>
 * Used on app start to validate a stored token before skipping past login.
 */
export async function fetchCurrentUser(token: string): Promise<AuthUser> {
  const apiBase = await getApiBase();

  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/user`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again.",
      0,
    );
  }

  if (!response.ok) {
    throw new ApiError(await extractErrorMessage(response), response.status);
  }

  return response.json();
}

/**
 * POST /api/logout with Authorization: Bearer <token>
 * Best-effort: the token is cleared locally regardless of whether this call
 * succeeds (e.g. the device is offline when the agent logs out).
 */
export async function logout(token: string): Promise<void> {
  const apiBase = await getApiBase();

  try {
    await fetch(`${apiBase}/api/logout`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    // Ignore network errors on logout — local token clearing still proceeds.
  }
}
