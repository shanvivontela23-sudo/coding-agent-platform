import { Pool } from "pg";
import type { TenantPool } from "./database.js";

export type RuntimePostgresPool = TenantPool & { end(): Promise<void> };

export function createRuntimePostgresPool(connectionString: string, max = 2): RuntimePostgresPool {
  return new Pool({ connectionString, max }) as unknown as RuntimePostgresPool;
}
