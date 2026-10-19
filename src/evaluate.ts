// Pure decision logic: given contributors and the store, decide pass/fail.

import type { Config } from "./config.ts";
import type { Contributor, ContributorSet, UnresolvedIdentity } from "./contributors.ts";
import { hasValidSignature, type SignatureStore } from "./store.ts";

export type Coverage =
  | { kind: "individual"; version: string }
  | { kind: "entity"; entityName: string; version: string }
  | { kind: "allowlisted" };

export interface Verdict {
  passed: boolean;
  covered: (Contributor & { coverage: Coverage })[];
  unsigned: (Contributor & { pendingEntity?: string })[];
  unresolved: UnresolvedIdentity[];
  problems: string[];
}

export async function evaluate(config: Config, set: ContributorSet, store: SignatureStore): Promise<Verdict> {
  const covered: Verdict["covered"] = [];
  const unsigned: Verdict["unsigned"] = [];

  for (const contributor of set.contributors) {
    if (config.allowlist.accountIds.includes(contributor.id)) {
      covered.push({ ...contributor, coverage: { kind: "allowlisted" } });
      continue;
    }
    const record = await store.getIndividual(config.individual, contributor.id);
    const individual = record ? hasValidSignature(record.signatures, config.individual) : null;
    if (individual) {
      covered.push({ ...contributor, coverage: { kind: "individual", version: individual.version } });
      continue;
    }
    if (config.entity) {
      const entities = await store.getEntities(config.entity);
      const mine = entities.filter((e) => e.authorisedAccounts.some((a) => a.id === contributor.id));
      const active = mine.find((e) => e.status === "active" && hasValidSignature(e.signatures, config.entity!));
      if (active) {
        const sig = hasValidSignature(active.signatures, config.entity)!;
        covered.push({ ...contributor, coverage: { kind: "entity", entityName: active.entityName, version: sig.version } });
        continue;
      }
      const pending = mine.find((e) => e.status === "pending");
      if (pending) {
        unsigned.push({ ...contributor, pendingEntity: pending.entityName });
        continue;
      }
    }
    unsigned.push(contributor);
  }

  return {
    passed: unsigned.length === 0 && set.unresolved.length === 0 && set.problems.length === 0,
    covered,
    unsigned,
    unresolved: set.unresolved,
    problems: set.problems,
  };
}
