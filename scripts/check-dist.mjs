// Verifies that the committed dist/ matches a fresh build of src/, so the code
// reviewers read is the code the action runs.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "pactdock-dist-"));
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json", "--outDir", out], { stdio: "inherit" });

const list = (dir) => readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
const expected = list(out);
const actual = list("dist");
const problems = [];
if (JSON.stringify(expected) !== JSON.stringify(actual)) problems.push(`file list differs: built ${expected.join(",")} vs committed ${actual.join(",")}`);
for (const file of expected) {
  const a = readFileSync(join(out, file), "utf8").replace(/\r\n/g, "\n");
  let b = "";
  try { b = readFileSync(join("dist", file), "utf8").replace(/\r\n/g, "\n"); } catch {}
  if (a !== b) problems.push(`dist/${file} is out of date`);
}
if (problems.length) {
  console.error(problems.join("\n") + "\nRun `npm run build` and commit dist/.");
  process.exit(1);
}
console.log(`dist/ is up to date (${expected.length} files).`);
