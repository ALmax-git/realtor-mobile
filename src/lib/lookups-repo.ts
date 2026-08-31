/**
 * Local cache for rarely-changing reference data (states, cities, pension
 * fund administrators) used to populate wizard dropdowns.
 *
 * States and PFAs are small, flat lists refreshed in one shot whenever the
 * sync engine is online. Cities are refreshed per-state and on demand (the
 * wizard only ever needs cities for the one state the agent picked), rather
 * than eagerly pulling every city for every state up front, since the
 * `/api/v1/cities` endpoint requires a `state_id` and the full set could be
 * large — see `refreshCitiesForState`.
 */
import { getDb } from "./db";
import {
  fetchCities,
  fetchPensionFundAdministrators,
  fetchStates,
} from "./clients-api";
import type { LookupCity, LookupPfa, LookupState } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

export async function getCachedStates(): Promise<LookupState[]> {
  const db = await getDb();
  return db.select<LookupState[]>(`SELECT id, name FROM lookup_states ORDER BY name`);
}

export async function getCachedCitiesForState(
  stateId: number,
): Promise<LookupCity[]> {
  const db = await getDb();
  return db.select<LookupCity[]>(
    `SELECT id, state_id, name FROM lookup_cities WHERE state_id = ? ORDER BY name`,
    [stateId],
  );
}

export async function getCachedPfas(): Promise<LookupPfa[]> {
  const db = await getDb();
  return db.select<LookupPfa[]>(`SELECT id, name, code FROM lookup_pfas ORDER BY name`);
}

/** Pull fresh states + PFAs from the server and replace the local cache. */
export async function refreshStatesAndPfas(token: string): Promise<void> {
  const [states, pfas] = await Promise.all([
    fetchStates(token),
    fetchPensionFundAdministrators(token),
  ]);
  const db = await getDb();

  await db.execute(`DELETE FROM lookup_states`);
  for (const s of states) {
    await db.execute(`INSERT INTO lookup_states (id, name) VALUES (?, ?)`, [
      s.id,
      s.name,
    ]);
  }

  await db.execute(`DELETE FROM lookup_pfas`);
  for (const p of pfas) {
    await db.execute(`INSERT INTO lookup_pfas (id, name, code) VALUES (?, ?, ?)`, [
      p.id,
      p.name,
      p.code ?? null,
    ]);
  }

  await db.execute(
    `INSERT INTO sync_meta (key, value) VALUES ('lookups_refreshed_at', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [nowIso()],
  );
}

/** Pull fresh cities for one state and replace that state's slice of the cache. */
export async function refreshCitiesForState(
  token: string,
  stateId: number,
): Promise<void> {
  const cities = await fetchCities(token, stateId);
  const db = await getDb();

  await db.execute(`DELETE FROM lookup_cities WHERE state_id = ?`, [stateId]);
  for (const c of cities) {
    await db.execute(
      `INSERT INTO lookup_cities (id, state_id, name) VALUES (?, ?, ?)`,
      [c.id, stateId, c.name],
    );
  }
}

export async function getLookupsRefreshedAt(): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<any[]>(
    `SELECT value FROM sync_meta WHERE key = 'lookups_refreshed_at'`,
  );
  return rows.length > 0 ? rows[0].value : null;
}
