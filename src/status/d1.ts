/// <reference types="@cloudflare/workers-types" />
import type { Db } from "./sink";

/**
 * Thin D1 adapter satisfying the Db port (see sink.ts). Keeps the sinks
 * unit-testable against an in-memory fake while this maps the same three
 * operations onto a real D1Database in the Worker/DO.
 */
export class D1Db implements Db {
  constructor(private readonly db: D1Database) {}

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.db
      .prepare(sql)
      .bind(...params)
      .run();
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all<T>();
    return results ?? [];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const row = await this.db
      .prepare(sql)
      .bind(...params)
      .first<T>();
    return row ?? null;
  }
}
