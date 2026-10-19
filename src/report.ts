// Rendering of the commit-status description and the single "sticky" PR comment.

import type { Config } from "./config.ts";
import type { Verdict } from "./evaluate.ts";
import { entityPhrase, individualPhrase } from "./signing.ts";

export const COMMENT_MARKER = "<!-- pactdock:status -->";

export interface DocumentLinks {
  individualUrl: string;
  entityUrl?: string;
}

/** Untrusted text (git names) rendered inert: no markup, mentions or HTML. */
export function inert(text: string): string {
  const cleaned = text.replace(/[^\p{L}\p{N} .,'_-]/gu, "").trim().slice(0, 80);
  return cleaned ? `\`${cleaned}\`` : "`(unnamed)`";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function statusDescription(verdict: Verdict): string {
  if (verdict.problems.length) return "Cannot verify CLA: " + verdict.problems[0]!.slice(0, 110);
  if (verdict.passed) return `All ${plural(verdict.covered.length, "contributor")} covered by the CLA.`;
  const missing = verdict.unsigned.length + verdict.unresolved.length;
  return `${plural(missing, "contributor")} must sign the CLA before merging.`;
}

export function renderComment(config: Config, verdict: Verdict, docs: DocumentLinks): string {
  const lines: string[] = [COMMENT_MARKER, ""];
  if (verdict.passed) {
    lines.push("### ✅ PactDock: CLA check passed", "");
    lines.push(`Every contributor to this pull request is covered by a Contributor Licence Agreement with ${config.rightsHolder}. Thank you!`);
    return lines.join("\n");
  }

  lines.push("### ✍️ PactDock: Contributor Licence Agreement required", "");
  lines.push(
    `Before this pull request can be merged, every contributor must accept the [${config.individual.name} (version ${config.individual.version})](${docs.individualUrl}) granting ${config.rightsHolder} the rights it describes. You keep the copyright in your contribution.`,
    "",
  );

  if (verdict.problems.length) {
    lines.push("**PactDock could not verify this pull request:**", "");
    for (const p of verdict.problems) lines.push(`- ${p}`);
    lines.push("");
  }

  if (verdict.unsigned.length) {
    lines.push("**Still to sign:**", "");
    for (const c of verdict.unsigned) {
      const pending = c.pendingEntity ? ` (entity agreement for ${inert(c.pendingEntity)} awaiting maintainer approval)` : "";
      lines.push(`- [ ] @${c.login} (${c.roles.join(", ")})${pending}`);
    }
    lines.push("");
  }
  if (verdict.covered.length) {
    lines.push("**Covered:** " + verdict.covered.map((c) => `@${c.login}`).join(", "), "");
  }
  if (verdict.unresolved.length) {
    lines.push("**Commits whose authors are not linked to a GitHub account:**", "");
    for (const u of verdict.unresolved) lines.push(`- ${inert(u.name)} (${u.role}) in ${u.commit.slice(0, 7)}`);
    lines.push(
      "",
      "Each person must add that commit email to their GitHub account (Settings → Emails) and sign, or the commits must be re-authored. PactDock cannot verify an identity it cannot see.",
      "",
    );
  }

  lines.push("#### How to sign", "");
  lines.push("Read the agreement, then post a new comment on this pull request containing **only** this line:", "");
  lines.push("```text", individualPhrase(config.individual), "```", "");
  if (config.entity && docs.entityUrl) {
    lines.push(
      `<details><summary>Contributing on behalf of a company or other organisation?</summary>`,
      "",
      `An authorised signatory can accept the [${config.entity.name} (version ${config.entity.version})](${docs.entityUrl}) by commenting:`,
      "",
      "```text",
      entityPhrase(config.entity),
      "```",
      "",
      "Entity agreements take effect once a maintainer has verified the signatory's authority and the list of authorised contributors." +
        (config.entityInstructionsUrl ? ` See [entity instructions](${config.entityInstructionsUrl}).` : ""),
      "",
      "</details>",
      "",
    );
  }
  lines.push(
    "<sub>Your signature is recorded against your GitHub account ID with a timestamp and a link to your comment. Comment `/pactdock recheck` to re-run the check. Powered by PactDock.</sub>",
  );
  return lines.join("\n");
}
