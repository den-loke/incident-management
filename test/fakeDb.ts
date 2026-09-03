import type { Db } from "../src/status/sink";

/**
 * Tiny in-memory Db fake for unit tests. It does NOT parse arbitrary SQL — it
 * recognizes the specific statements InternalStatusSink issues (matched by a
 * stable substring) and mutates plain Maps. This keeps tests dependency-free
 * while still exercising the sink's real logic and parameter wiring.
 */
export class FakeDb implements Db {
  incidents = new Map<string, Record<string, unknown>>();
  updates: Record<string, unknown>[] = [];
  components = new Map<string, Record<string, unknown>>();

  async run(sql: string, params: unknown[] = []): Promise<void> {
    if (sql.startsWith("INSERT INTO incidents")) {
      const [id, name, status, severity, created_at, resolved_at] = params;
      this.incidents.set(id as string, {
        id,
        name,
        status,
        severity,
        created_at,
        resolved_at,
      });
      return;
    }
    if (sql.startsWith("INSERT INTO incident_updates")) {
      const [id, incident_id, body, status, created_at] = params;
      this.updates.push({ id, incident_id, body, status, created_at });
      return;
    }
    if (sql.startsWith("UPDATE incidents SET status")) {
      const [status, resolved_at, id] = params;
      const row = this.incidents.get(id as string);
      if (row) {
        row.status = status;
        row.resolved_at = resolved_at;
      }
      return;
    }
    if (sql.startsWith("UPDATE components SET status")) {
      const [status, updated_at, id] = params;
      const row = this.components.get(id as string);
      if (row) {
        row.status = status;
        row.updated_at = updated_at;
      }
      return;
    }
    throw new Error(`FakeDb.run: unrecognized SQL: ${sql}`);
  }

  async all<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    if (sql.startsWith("SELECT * FROM components")) {
      return [...this.components.values()].sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      ) as T[];
    }
    throw new Error(`FakeDb.all: unrecognized SQL: ${sql}`);
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    if (sql.startsWith("SELECT * FROM incidents WHERE id")) {
      return (this.incidents.get(params[0] as string) as T) ?? null;
    }
    throw new Error(`FakeDb.get: unrecognized SQL: ${sql}`);
  }

  // Test helper: seed a component.
  seedComponent(id: string, name: string): void {
    this.components.set(id, {
      id,
      name,
      status: "operational",
      updated_at: "seed",
    });
  }
}
