import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Vite middleware: serves `/regen-stac` and, if `src/minimal_stac.json`
 * is older than a threshold, regenerates it by running `uv run
 * scripts/gen_stac.py`. Vite's own file watcher then HMRs the updated
 * JSON into the app.
 *
 * The point: SAS tokens in the pre-baked JSON expire ~1hr. We don't
 * want a cron running every hour while nobody's using the app, but we
 * also don't want users to hit 403s. So: the BROWSER fires this on
 * mount (and on a tile-auth-failure if we wire that up later) — the
 * regen only happens when there's actually a user.
 *
 * Only active in dev (vite dev server middleware). Prod builds get
 * whatever JSON was last generated.
 */

const JSON_PATH = "src/minimal_stac.json";
const SCRIPT_PATH = "scripts/gen_stac.py";
const STALE_MS = 50 * 60 * 1000; // re-gen if older than 50 minutes
const REGEN_TIMEOUT_MS = 60_000;

let inFlight: Promise<RegenResult> | null = null;

type RegenResult =
  | { status: "fresh"; ageSeconds: number }
  | { status: "regenerated"; took: number; bytes?: number }
  | { status: "error"; message: string };

async function fileAgeMs(absPath: string): Promise<number | null> {
  try {
    const s = await stat(absPath);
    return Date.now() - s.mtimeMs;
  } catch {
    return null;
  }
}

function runRegen(cwd: string): Promise<RegenResult> {
  return new Promise((resolveResult) => {
    const start = Date.now();
    const proc = spawn("uv", ["run", SCRIPT_PATH], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    const killer = setTimeout(() => proc.kill("SIGTERM"), REGEN_TIMEOUT_MS);
    proc.on("close", async (code) => {
      clearTimeout(killer);
      if (code !== 0) {
        resolveResult({
          status: "error",
          message: `gen_stac.py exited ${code}: ${stderr.slice(0, 300)}`,
        });
        return;
      }
      const stats = await stat(resolve(cwd, JSON_PATH)).catch(() => null);
      resolveResult({
        status: "regenerated",
        took: Date.now() - start,
        bytes: stats?.size,
      });
    });
    proc.on("error", (err) => {
      clearTimeout(killer);
      resolveResult({ status: "error", message: String(err) });
    });
  });
}

export function regenStacPlugin(): Plugin {
  return {
    name: "regen-stac",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use("/regen-stac", async (_req, res) => {
        const ageMs = await fileAgeMs(resolve(root, JSON_PATH));
        if (ageMs == null) {
          // No JSON at all — must regen.
        } else if (ageMs < STALE_MS) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              status: "fresh",
              ageSeconds: Math.round(ageMs / 1000),
            } satisfies RegenResult),
          );
          return;
        }

        // Coalesce concurrent triggers from multiple tabs.
        if (!inFlight) inFlight = runRegen(root).finally(() => (inFlight = null));
        const result = await inFlight;
        res.setHeader("content-type", "application/json");
        res.statusCode = result.status === "error" ? 500 : 200;
        res.end(JSON.stringify(result));
      });
    },
  };
}
