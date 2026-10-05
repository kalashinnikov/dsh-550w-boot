/**
 * dsh-550w-boot — host half.
 *
 * The boot screen itself ships from the browser half (exports["./client"]).
 * This half exists so the plugin row appears in the profile composition, and
 * so the browser half has somewhere to report what happened while it booted:
 * the desktop shell keeps no renderer log, so a one-line POST that lands in
 * ~/.dsh/dsh-550w-boot.log is the only way to see the app from the outside.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const REPORT_PATH = join(homedir(), ".dsh", "dsh-550w-boot.log");
const REPORT_ROUTE = "/api/dsh-550w-boot/report";

function record(line) {
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    appendFileSync(REPORT_PATH, new Date().toISOString() + " " + line + "\n", "utf8");
  } catch {
    /* a missing report must never disturb the host */
  }
}

function apply(ctx) {
  // Proof of life for the host half: if the plugin is in the profile's
  // composition at all, this line lands on every start.
  record("host-half: apply() entered");
  ctx.inject(["webServer"], (sctx) => {
    record("host-half: webServer injected");
    sctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: "exact",
        path: REPORT_ROUTE,
        handler: async (req, res) => {
          if (String(req.method || "").toUpperCase() !== "POST") {
            res.statusCode = 405;
            res.end("{}");
            return;
          }
          let body = "";
          try {
            for await (const chunk of req) body += chunk;
          } catch {
            /* fall through: an unreadable body still gets an answer */
          }
          record(String(body).slice(0, 4000));
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end('{"ok":true}');
        },
      });
      record("host-half: report route registered");
      return () => {
        if (typeof dispose === "function") dispose();
      };
    }, "dsh-550w-boot: report route");
  });
}

export { apply };
