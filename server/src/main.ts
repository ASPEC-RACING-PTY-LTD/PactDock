// PactDock Server entry point.
//   node main.js            start the server
//   node main.js backup     write an encrypted backup now
//   node main.js restore <file>   restore a backup into an empty data directory

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { App, errorPage, LoginRequired, registerCoreRoutes } from "./app.ts";
import { registerAdminRoutes } from "./admin.ts";
import { createBackup, restoreBackup } from "./backup.ts";
import { Vault } from "./crypto.ts";
import { Db } from "./db.ts";
import { LocalDocumentStore, S3DocumentStore, type DocumentStore } from "./documents.ts";
import { loadSettings, type Settings } from "./env.ts";
import { SmtpMailer } from "./mailer.ts";
import { registerSetupRoutes } from "./setup.ts";
import { registerSignRoutes } from "./sign.ts";
import { verifyPullRequest } from "./verify.ts";
import { createHandler, redirect } from "./web.ts";
import { registerWebhookRoutes } from "./webhooks.ts";

const log = {
  info: (m: string) => console.log(`${new Date().toISOString()} ${m}`),
  error: (m: string) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

export function buildApp(settings: Settings, opts: { db?: Db; documents?: DocumentStore; fetchImpl?: typeof fetch; logger?: typeof log } = {}): App {
  const logger = opts.logger ?? log;
  const db = opts.db ?? new Db(join(settings.dataDir, "pactdock.db"));
  const vault = Vault.load(settings.masterKey, settings.dataDir, logger.info);
  const documents = opts.documents ?? (settings.s3 ? new S3DocumentStore(settings.s3, opts.fetchImpl) : new LocalDocumentStore(join(settings.dataDir, "documents")));
  const mailer = settings.smtp ? new SmtpMailer(settings.smtp) : null;
  const app = new App(settings, db, vault, documents, mailer, logger, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
  registerCoreRoutes(app, staticDirectory());
  registerSetupRoutes(app);
  registerWebhookRoutes(app);
  registerSignRoutes(app);
  registerAdminRoutes(app);
  return app;
}

export function httpHandler(app: App) {
  return createHandler(app.router, {
    trustProxy: app.settings.trustProxy,
    publicUrl: app.settings.publicUrl,
    onError: (err) => app.log.error((err as Error).stack ?? String(err)),
    errorPage,
    mapError: (err) => (err instanceof LoginRequired ? redirect(`/auth/login?next=${encodeURIComponent(err.next)}`) : undefined),
  });
}

/** server/static, whether running from source (server/src) or the build (server/dist/server/src). */
function staticDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromSource = resolve(here, "..", "static");
  return existsSync(fromSource) ? fromSource : resolve(here, "..", "..", "..", "static");
}

/** Periodic safety net: re-verifies stale non-passing PRs, purges expired data, runs backups. */
function startTimers(app: App): void {
  const sweep = () => {
    app.db.cleanup();
    if (!app.configured) return;
    const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    const rows = app.db.all<{ repository_id: number; number: number }>(
      "SELECT repository_id, number FROM pull_requests WHERE state = 'open' AND conclusion != 'success' AND updated_at < ? LIMIT 50",
      cutoff,
    );
    for (const row of rows) {
      app.enqueue(`sweep ${row.repository_id}#${row.number}`, async () => {
        const repo = app.db.repo(row.repository_id);
        if (repo) await verifyPullRequest(app.verifyContext(), repo, row.number);
      });
    }
  };
  setInterval(sweep, 15 * 60_000).unref();
  const { backup } = app.settings;
  if (backup.intervalHours > 0) {
    if (!backup.passphrase) {
      app.log.error("PACTDOCK_BACKUP_INTERVAL_HOURS is set but PACTDOCK_BACKUP_PASSPHRASE is not; scheduled backups are disabled.");
      return;
    }
    const run = () =>
      createBackup(app.db, app.settings.dataDir, backup.dir, backup.passphrase!, backup.keep).then(
        (file) => app.db.audit("system", "backup.created", file),
        (err: Error) => app.log.error(`Backup failed: ${err.message}`),
      );
    setInterval(run, backup.intervalHours * 3600_000).unref();
  }
}

async function main(argv: string[]): Promise<void> {
  const settings = loadSettings();
  const command = argv[0] ?? "serve";
  if (command === "restore") {
    const file = argv[1];
    if (!file || !settings.backup.passphrase) throw new Error("Usage: restore <file>, with PACTDOCK_BACKUP_PASSPHRASE set.");
    const written = restoreBackup(file, settings.backup.passphrase, settings.dataDir);
    log.info(`Restored ${written.length} file(s) into ${settings.dataDir}.`);
    return;
  }
  const app = buildApp(settings);
  if (command === "backup") {
    if (!settings.backup.passphrase) throw new Error("Set PACTDOCK_BACKUP_PASSPHRASE to create backups.");
    const file = await createBackup(app.db, settings.dataDir, settings.backup.dir, settings.backup.passphrase, settings.backup.keep);
    app.db.audit("system", "backup.created", file);
    log.info(`Backup written to ${file}`);
    app.db.close();
    return;
  }
  if (command !== "serve") throw new Error(`Unknown command "${command}". Use serve, backup or restore.`);
  const server = createServer(httpHandler(app));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.listen(settings.port, () => log.info(`PactDock Server listening on :${settings.port} (${settings.publicUrl})`));
  startTimers(app);
  const stop = () => {
    log.info("Shutting down…");
    server.close(() => void app.idle().then(() => (app.db.close(), process.exit(0))));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: Error) => {
    log.error(err.message);
    process.exit(1);
  });
}
