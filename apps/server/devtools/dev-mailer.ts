import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Mailer } from "../src/mail";

/**
 * A stand-in for SMTP in local development and E2E: each message becomes a
 * JSON file in `dir` (newest sorts last) instead of leaving the machine.
 * It runs only alongside the fake sign-in provider. Never use it in production.
 */
export function devMailer(dir: string): Mailer {
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  return async (message) => {
    const name = `${Date.now().toString().padStart(15, "0")}-${String(seq++).padStart(4, "0")}.json`;
    writeFileSync(join(dir, name), JSON.stringify(message, null, 2));
  };
}
