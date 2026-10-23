import { sql } from "drizzle-orm";
import { env } from "../env";
import { createDb } from "./client";

// Wipes a throwaway database so a test run starts clean. Refuses anything
// not named *_test or *_e2e, so it can never touch a database people use.

const name = new URL(env.databaseUrl).pathname.slice(1);
if (!/_(test|e2e)$/.test(name)) {
  console.error(`refusing to reset "${name}": only *_test or *_e2e databases`);
  process.exit(1);
}
const { db, pool } = createDb(env.databaseUrl);
await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
await pool.end();
console.log(`reset ${name}`);
