# Items requiring legal review

> Prepared from research in October 2026. **This is not legal advice.** An Australian legal practitioner should review every item before the ASPEC CLAs are shown to contributors, or a licence is adopted.

## A. Harmony provisions: verified against the official texts

Sources: harmonyagreements.org/agreements, `docs/ha-cla-i-v1.pdf`, `docs/ha-cla-e-v1.pdf`, `/guide`.

- **Release.** Harmony has one release, version 1.0 (4 July 2011). It appears unmaintained since 2011–2012.
- **Template licence.** The templates are licensed CC BY 3.0 Unported. The ASPEC drafts are independently worded and only modelled on Harmony's structure. They carry an attribution footer and say they are not Harmony agreements.
- **Copyright grant.** Harmony's §2.1 has the contributor keep ownership and grant a perpetual, worldwide, non-exclusive, transferable, royalty-free, irrevocable licence. The licence is sublicensable through multiple tiers, but is limited to use "as part of the Material", and is subject to §2.3.
- **Patent licence.** Harmony's §2.2 patent licence has no defensive-termination clause.
- **Outbound licensing.** Harmony's §2.3 Option Five allows any licence, including proprietary ones. It is conditioned on the company also continuing to license the contribution under the licence the Material used at the Submission Date.
- **Moral rights.** Harmony's §2.4 is a *waiver* of moral rights, to the extent the law permits.
- **Entity variant.** HA-CLA-E adds Affiliates, defined as 50% or more control. It has **no designated-employee schedule**. The ASPEC draft adds Schedule 1.

## B. Deliberate departures from Harmony (confirm each)

| # | Clause (ASPEC draft) | Departure | Why |
| --- | --- | --- | --- |
| B1 | ICLA 2.2 / ECLA 2.2 | The grant is standalone, not limited to "as part of the Material", and adds "commercially exploiting" | So ASPEC can use, modify, distribute and commercially relicense the contributions |
| B2 | ICLA 2.3 / ECLA 2.3 | Relicensing on any terms, **without** Option Five's condition to keep licensing under the original licence | Matches the "commercially relicense" requirement. Confirm ASPEC wants no outbound commitment. |
| B3 | ICLA 2.5 / ECLA 2.5 | Moral rights handled by **consent** under Part IX of the *Copyright Act 1968* (Cth), with a fallback waiver for other jurisdictions | Australian moral rights cannot be waived or assigned, only consented to (ss 195AW–195AWA) |
| B4 | ICLA 5 | Mutual exclusion of consequential loss (Harmony protects only the contributor) | Business choice |
| B5 | ICLA 6.1 | Electronic acceptance by GitHub comment, with the record of evidence | PactDock's signing mechanism |
| B6 | ICLA 6.2 | Express consideration clause | Harmony has none |
| B7 | ICLA 6.5 | ASPEC may assign without consent. The contributor may not. | Harmony allows either party to assign, with the assignee bound |
| B8 | ICLA 6.6 | Australian Consumer Law carve-out | Non-excludable guarantees |
| B9 | ECLA 5, Schedule 1 | Maintainer verification of authority, and a list of authorised contributors | Harmony has no schedule. PactDock activates entity coverage only after verification. |

## C. Open questions for counsel

1. **Licence vs assignment.** A non-exclusive licence lets ASPEC relicense, but not sue third parties for infringing contributors' copyright, and gives ASPEC no exclusivity. Is that acceptable? The requirement says contributors keep copyright, so a licence is the intended model.
2. **Electronic acceptance.** Does a GitHub comment satisfy the *Electronic Transactions Act 1999* (Cth) and the State acts, for the method of identification and intention? The moral-rights consent must be "in writing". Is an electronic comment sufficient? Any assignment or exclusive licence would need a written signed instrument (s 196(3)), but none is used here.
3. **Governing law.** Which State (NSW / VIC / QLD …)? Exclusive or non-exclusive jurisdiction?
4. **Company details.** Insert the ACN/ABN and a contact email in both drafts and in the trademark policy.
5. **Minors.** Is acceptance by under-18s enforceable? Is a guardian process required?
6. **Employees of entities.** How should individual authors' moral-rights consents be obtained (ECLA 2.5)? Is the s 35(6) employer ownership assumption correct for contractors?
7. **Patent defence.** Should a defensive-termination clause be added?
8. **Consideration or deed.** Is clause 6.2 enough, or should acceptance be executed as a deed?
9. **Incorporation by reference.** ECLA 4 incorporates ICLA clauses 4–6. Should it set them out in full?
10. **Privacy.** Signature records hold personal information (GitHub IDs, logins, comment text). Is a collection notice needed under the *Privacy Act 1988* (Cth), and what retention period applies? Overseas contributors may raise GDPR questions.
11. **Versioning.** ICLA 6.8 says a new version applies only to later contributions. Confirm.
12. **Third-party users of PactDock.** Make clear that the ASPEC agreements are not a template for other organisations' legal needs.

## D. PactDock's own licence

PolyForm Shield 1.0.0 was approved and adopted unmodified on 2026-10-20 (item L1). Still open in [LICENSING.md](LICENSING.md): the trademark policy (L2), the optional bundling restriction (L3, which would need a custom clause) and the ABN/contact details for the Required Notice (L4).
