/**
 * Thin client for the `realtor-web` client-intake API surface
 * (`/api/v1/client*`, `/api/v1/states`, `/api/v1/cities`,
 * `/api/v1/pension-fund-administrators`).
 *
 * Mirrors the conventions in `api.ts` (same `ApiError`, same Laravel error
 * message extraction) deliberately rather than duplicating them, so the two
 * modules behave identically for the UI. Every function here assumes it may
 * be called with no network and should let the caller (the sync engine)
 * decide what "offline" means for that call — it never swallows errors.
 */
import { getApiBase } from "./config";
import { ApiError, extractErrorMessage } from "./api";
import type {
  ClientFields,
  EquityApplicationFields,
  LookupCity,
  LookupPfa,
  LookupState,
  NextOfKinFields,
  RefereeFields,
  SpouseFields,
} from "./types";

export interface ClientPayload extends ClientFields {
  next_of_kin?: NextOfKinFields | null;
  spouses?: SpouseFields[];
  referees?: RefereeFields[];
}

export interface ClientApiRecord extends ClientFields {
  id: number;
  status?: string;
  full_name?: string;
  created_at?: string;
  updated_at?: string;
  next_of_kin?: (NextOfKinFields & { id: number }) | null;
  spouses?: (SpouseFields & { id: number })[];
  referees?: (RefereeFields & { id: number })[];
}

export interface PaginatedResponse<T> {
  data: T[];
  meta?: { current_page: number; last_page: number; total: number };
}

async function authedFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const apiBase = await getApiBase();

  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
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

  return response;
}

/**
 * Lightweight reachability check used by the sync engine before attempting a
 * drain pass. `navigator.onLine` only tells us the device thinks it has a
 * network interface up, not that the API is actually reachable, so this
 * makes a real (cheap, already-authenticated) request and treats any HTTP
 * response — even a 401 — as "the server is reachable"; only a thrown
 * network error/timeout means offline.
 */
export async function pingServer(token: string): Promise<boolean> {
  const apiBase = await getApiBase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    await fetch(`${apiBase}/api/user`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchClients(
  token: string,
): Promise<PaginatedResponse<ClientApiRecord>> {
  const response = await authedFetch(`/api/v1/client?per_page=100`, token, {
    method: "GET",
  });
  return response.json();
}

export async function createClient(
  token: string,
  payload: ClientPayload,
): Promise<ClientApiRecord> {
  const response = await authedFetch(`/api/v1/client`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return body.data ?? body;
}

export async function updateClient(
  token: string,
  serverId: number,
  payload: ClientPayload,
): Promise<ClientApiRecord> {
  const response = await authedFetch(`/api/v1/client/${serverId}`, token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return body.data ?? body;
}

export async function deleteClientRemote(
  token: string,
  serverId: number,
): Promise<void> {
  await authedFetch(`/api/v1/client/${serverId}`, token, { method: "DELETE" });
}

export async function updateEquityApplication(
  token: string,
  clientServerId: number,
  payload: Partial<EquityApplicationFields>,
): Promise<void> {
  await authedFetch(`/api/v1/client/${clientServerId}/equity-application`, token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function fetchStates(token: string): Promise<LookupState[]> {
  const response = await authedFetch(`/api/v1/states`, token, { method: "GET" });
  return response.json();
}

export async function fetchCities(
  token: string,
  stateId: number,
): Promise<LookupCity[]> {
  const response = await authedFetch(`/api/v1/cities?state_id=${stateId}`, token, {
    method: "GET",
  });
  return response.json();
}

export async function fetchPensionFundAdministrators(
  token: string,
): Promise<LookupPfa[]> {
  const response = await authedFetch(`/api/v1/pension-fund-administrators`, token, {
    method: "GET",
  });
  return response.json();
}
