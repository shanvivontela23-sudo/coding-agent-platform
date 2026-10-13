import { Pool, type PoolConfig } from "pg";
import { handlePoolErrors } from "../../src/postgres-pool.js";

// Integration tests drop their databases with DROP DATABASE ... WITH (FORCE),
// which terminates any still-open session (57P01). A test pool with no error
// listener turns that into an unhandled error that fails an otherwise green
// run (CI 2026-10-13). Log it like production pools do.
export function testPool(config: PoolConfig): Pool {
  return handlePoolErrors(new Pool(config));
}
