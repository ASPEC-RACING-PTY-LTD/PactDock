// GitHub webhook receiver. Deliveries are authenticated with the App's webhook
// secret (HMAC-SHA256), de-duplicated by delivery ID, acknowledged at once and
// processed in the background queue.

import { createHmac } from "node:crypto";
import type { App } from "./app.ts";
import { safeEqual } from "./crypto.ts";
import { syncInstallations, upsertRepo } from "./setup.ts";
import { verifyPullRequest } from "./verify.ts";
import { HttpError, json } from "./web.ts";

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "edited"]);

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return safeEqual(expected, header);
}

export function registerWebhookRoutes(app: App): void {
  app.router.on("POST", "/webhook", async (req) => {
    const stored = app.db.setting("webhook_secret");
    if (!stored) throw new HttpError(503, "Not configured.");
    const body = await req.rawBody(10 * 1024 * 1024);
    if (!verifySignature(app.vault.decrypt(stored), body, req.headers["x-hub-signature-256"] as string | undefined)) {
      throw new HttpError(401, "Invalid webhook signature.");
    }
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    const event = String(req.headers["x-github-event"] ?? "");
    if (delivery) {
      const fresh = app.db.run("INSERT OR IGNORE INTO deliveries (id, received_at) VALUES (?, ?)", delivery, new Date().toISOString()).changes;
      if (!fresh) return json({ ok: true, duplicate: true }, 202);
    }
    const payload = JSON.parse(body.toString("utf8")) as Record<string, any>;
    handleEvent(app, event, payload);
    return json({ ok: true }, 202);
  });
}

export function handleEvent(app: App, event: string, payload: Record<string, any>): void {
  const installationId: number | undefined = payload["installation"]?.id;
  switch (event) {
    case "ping":
      return;
    case "installation": {
      const action = payload["action"];
      if (action === "deleted") {
        app.db.run("UPDATE repositories SET removed = 1, updated_at = ? WHERE installation_id = ?", new Date().toISOString(), installationId ?? 0);
        app.db.audit("github", "installation.deleted", `Installation ${installationId}`);
        return;
      }
      app.enqueue(`installation.${action}`, () => syncInstallations(app));
      app.db.audit("github", `installation.${action}`, `${payload["installation"]?.account?.login ?? ""} (${installationId})`);
      return;
    }
    case "installation_repositories": {
      for (const r of (payload["repositories_added"] ?? []) as { id: number; full_name: string }[]) upsertRepo(app, installationId ?? 0, r.id, r.full_name);
      for (const r of (payload["repositories_removed"] ?? []) as { id: number }[]) {
        app.db.run("UPDATE repositories SET removed = 1, updated_at = ? WHERE id = ?", new Date().toISOString(), r.id);
      }
      return;
    }
    case "pull_request": {
      if (!PR_ACTIONS.has(payload["action"])) return;
      // Only an edit of the base branch can change the result.
      if (payload["action"] === "edited" && !payload["changes"]?.base) return;
      const repoId: number = payload["repository"]?.id;
      const number: number = payload["pull_request"]?.number;
      app.enqueue(`pr ${repoId}#${number}`, async () => {
        const repo = app.db.repo(repoId);
        if (repo) await verifyPullRequest(app.verifyContext(), repo, number);
      });
      return;
    }
    case "check_run": {
      // "Re-run" in the GitHub UI.
      if (payload["action"] !== "rerequested" || payload["check_run"]?.app?.id !== Number(app.db.setting("app_id"))) return;
      const repoId: number = payload["repository"]?.id;
      for (const pr of (payload["check_run"]?.pull_requests ?? []) as { number: number }[]) {
        app.enqueue(`rerun ${repoId}#${pr.number}`, async () => {
          const repo = app.db.repo(repoId);
          if (repo) await verifyPullRequest(app.verifyContext(), repo, pr.number);
        });
      }
      return;
    }
    default:
      return;
  }
}
