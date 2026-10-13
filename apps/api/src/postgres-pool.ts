import { Pool } from "pg";
import type { TenantPool } from "./database.js";

export type RuntimePostgresPool = TenantPool & { end(): Promise<void> };

type ErrorEmitter = { on(event: "error", listener: (error: Error & { code?: string }) => void): unknown };

// pg emits "error" on the pool when an idle client's connection dies (Postgres
// restart, failover, or "57P01 terminating connection due to administrator
// command"). With no listener Node treats it as an uncaught exception and the
// API/worker process exits. Log it and let the pool reconnect on next use.
export function handlePoolErrors<T extends ErrorEmitter>(pool: T, log: (entry: string) => void = (entry) => console.error(entry)): T {
  pool.on("error", (error) => {
    log(JSON.stringify({ event: "postgres_pool_error", code: error.code ?? null, message: error.message }));
  });
  return pool;
}

export function createRuntimePostgresPool(connectionString: string, max = 2): RuntimePostgresPool {
  return handlePoolErrors(new Pool({ connectionString, max })) as unknown as RuntimePostgresPool;
}
