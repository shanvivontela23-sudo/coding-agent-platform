import { EventEmitter } from "node:events";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { handlePoolErrors } from "../src/postgres-pool.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;

describe("postgres pool error handling", () => {
  it("logs pool errors instead of letting them crash the process", () => {
    const pool = new EventEmitter();
    const logs: string[] = [];
    handlePoolErrors(pool as never, (entry) => logs.push(entry));
    expect(() => pool.emit("error", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }))).not.toThrow();
    expect(JSON.parse(logs[0]!)).toEqual({ event: "postgres_pool_error", code: "57P01", message: "terminating connection due to administrator command" });
  });

  // CI flake 2026-10-13: an idle connection killed by DROP DATABASE ... WITH
  // (FORCE) raised 57P01 with no listener. Reproduce with pg_terminate_backend.
  it.skipIf(!baseDatabaseUrl)("survives an idle connection being terminated by the server and reconnects", async () => {
    const logs: string[] = [];
    const pool = handlePoolErrors(new Pool({ connectionString: baseDatabaseUrl, max: 1 }), (entry) => logs.push(entry));
    const admin = new Pool({ connectionString: baseDatabaseUrl, max: 1 });
    try {
      const pid = (await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      for (let i = 0; i < 50 && logs.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(logs.some((entry) => JSON.parse(entry).code === "57P01")).toBe(true);
      const again = await pool.query<{ ok: number }>("SELECT 1 AS ok");
      expect(again.rows[0]!.ok).toBe(1);
    } finally {
      await pool.end();
      await admin.end();
    }
  });
});
