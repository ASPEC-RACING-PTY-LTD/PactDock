# PactDock licensing

> **Status: ASPEC RACING PTY LTD approved PolyForm Shield 1.0.0 on 2026-10-20.** It is adopted unmodified in [LICENSE.md](../LICENSE.md). Items L2–L5 below are still open.

## Requirements

1. PactDock's source is public. It is "source-available", not "open source".
2. Anyone, including businesses, may use and modify it free of charge to manage contributions to their own repositories.
3. No one may resell, monetise, rebrand or offer PactDock itself as a competing paid product or hosted service without ASPEC's written permission.

## Options compared

Sources: polyformproject.org, mariadb.com/bsl11, elastic.co/licensing/elastic-license, fsl.software, commonsclause.com. All were checked in October 2026.

| Licence | Business use free? | Blocks resale of copies? | Blocks hosted SaaS? | Blocks free rebranded competing fork? | Expires into open source? | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| **PolyForm Shield 1.0.0** | Yes, for any non-competing purpose | Yes | Yes | Yes (competition covers products "even when provided free of charge") | No | **Best** |
| PolyForm Perimeter 1.0.0 | Yes | Yes | Yes | Yes | No | Close second. It protects only against competition with PactDock itself, not ASPEC's other products, and has no "new products" clause. |
| PolyForm Noncommercial / Small Business / Internal Use / Free Trial | No or limited | — | — | — | No | Do not fit, because businesses must be able to use it |
| Business Source License 1.1 | Only via an Additional Use Grant | Depends on the grant | Depends on the grant | Depends on the grant | **Yes, within 4 years at most** | Poor. The restrictions lapse. |
| Functional Source License 1.1 | Yes | Yes (commercial only) | Yes (commercial only) | Not if free | **Yes, after 2 years** | Poor |
| Elastic License 2.0 | Yes | **No** | Yes | No | No | Weak |
| Apache-2.0 / MIT + Commons Clause | Yes | Yes ("Sell") | Yes | No | No | Ambiguous ("substantially"). Also blocks paid installation consulting. Widely criticised. |

## Recommendation

**Adopt PolyForm Shield 1.0.0, unmodified**, with a plain-English notice outside the licence text.

Why:

- It is a standard licence, short, recognised and free to use. It has no change date, so ASPEC's protection does not expire.
- Anyone may use PactDock for any purpose **except** providing a product (a good or a service, paid or free) that competes with PactDock or with ASPEC's products built using it. Internal business use, modification, and redistribution for non-competing purposes are all allowed.
- Under Shield:
  - (a) Selling copies, (b) hosted CLA-as-a-service, and (c) a rebranded fork offered as a substitute are all **blocked**.
  - (d) A consultant charging a client to install PactDock is **likely permitted**. This matches the requirement that businesses can use it.
- It includes a patent licence with a defensive termination clause, and a 32-day cure period for first violations.

### Gaps and items flagged for ASPEC decision

| # | Item | Why it matters | Options |
| --- | --- | --- | --- |
| L1 | PolyForm Shield 1.0.0 as PactDock's licence | This is a legal decision reserved to ASPEC | **Approved 2026-10-20** |
| L2 | Trademark policy | Shield says nothing about trademarks or names. | **Declined by ASPEC (2026-10-20): "PactDock" will not be trademarked and there is no trademark policy.** Rebranded forks are restricted only when they compete (Shield's noncompete). Renaming a non-competing copy is allowed. |
| L3 | **Monetising PactDock inside a larger, non-competing paid product** (e.g. a paid DevOps bundle that includes PactDock) | Shield probably does **not** block this, because the bundle does not compete with PactDock as such. | (a) Accept it (simplest, recommended). (b) Add a custom extra clause or dual licence. That requires bespoke wording and loses Shield's predictability. **Paused for approval.** |
| L4 | **Required Notice line** | Shield passes on "Required Notice:" lines to all recipients | **Done**: copyright, ABN 41 676 208 227, website and legal@aspecracing.com.au. Optionally also add a `Licensor Line of Business:` line (see the Shield "Discontinued Products" section). |
| L5 | **Inbound licence for PactDock's own contributors** | Contributions to PactDock are covered by the ASPEC Contributor Agreement (copyright assignment with licence back), configured in `.github/pactdock.json` | Turn on enforcement for the PactDock repository: a PactDock Server, or a Lite workflow once a release SHA exists |

**No custom licence is needed** unless ASPEC chooses option L3(b).

## Wording to use once approved

- "PactDock is **free and source-available** under the PolyForm Shield License 1.0.0."
- Never call it "open source". None of the options above are OSI-approved.

## Adoption steps

1. ~~Replace `LICENSE.md` with the verbatim text (from the official `polyformproject/polyform-licenses` repository, tag `1.0.0`) plus a Required Notice line.~~ Done.
2. ~~Set `"license": "PolyForm-Shield-1.0.0"` in `package.json`.~~ Done.
3. ~~Update the README licence section.~~ Done.
