// Minimal GitHub Actions runtime helpers (replaces @actions/core so PactDock has
// zero runtime dependencies). Behaviour follows the documented workflow-command
// and environment-file protocols:
// https://docs.github.com/actions/reference/workflow-commands-for-github-actions

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EOL } from "node:os";

export function getInput(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  return (env[key] ?? "").trim();
}

export function getRequiredInput(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = getInput(name, env);
  if (!value) throw new Error(`Input "${name}" is required but was not supplied.`);
  return value;
}

function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function command(name: string, message: string): void {
  process.stdout.write(`::${name}::${escapeData(message)}${EOL}`);
}

export const log = {
  info(message: string): void {
    process.stdout.write(message + EOL);
  },
  debug(message: string): void {
    command("debug", message);
  },
  warning(message: string): void {
    command("warning", message);
  },
  error(message: string): void {
    command("error", message);
  },
};

/** Ask the runner to redact a value from all subsequent log output. */
export function setSecret(value: string): void {
  if (value) command("add-mask", value);
}

function appendEnvFile(variable: string, content: string): void {
  const file = process.env[variable];
  if (!file) return;
  appendFileSync(file, content, { encoding: "utf8" });
}

export function setOutput(name: string, value: string): void {
  const delimiter = `pactdock_${randomUUID()}`;
  if (process.env["GITHUB_OUTPUT"]) {
    appendEnvFile("GITHUB_OUTPUT", `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`);
  } else {
    log.info(`output ${name}=${value}`);
  }
}

export function appendSummary(markdown: string): void {
  appendEnvFile("GITHUB_STEP_SUMMARY", markdown + EOL);
}
