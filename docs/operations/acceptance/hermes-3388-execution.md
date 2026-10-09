# Hermes acceptance harness execution receipt

Date: October 9, 2026. This is **harness qualification, not installed acceptance**.

## Source and ownership

- Upstream base, rechecked before publication:
  `74022d868254222df0e496229f4ca54bc36975e6`.
- Fork main when inspected: `4f6f34d718d916e80b2d03e1e36eb9e37181b414`.
- Tested code: `7946de47a75563a520156cc7ba0b223a6436680e`.
- Fork branch: `chore/hermes-installed-acceptance-3388`.
- Scope claim was committed before code (`0a2515e2`). No production `src/`,
  existing `tests/`, package manifest, lockfile, or runtime implementation changed.
- This receipt/coordination update is documentation-only after the tested code.

## Commands and results

Runtime: Node `22.23.3`, npm `11.9.0`.

1. `npm ci --prefer-offline --ignore-scripts`: installed 1,497 packages. Because
   lifecycle scripts were intentionally not run at first, the initial full gate
   failed: 115 failed / 814 passed / 3 skipped files; 432 failed / 5,602 passed /
   17 skipped tests, plus five errors. Missing native SQLite was the dominant
   environment failure. This was not called a product pass.
2. `npm rebuild better-sqlite3 node-pty`: passed with a private writable cache.
   The next full gate reached 927 passing files and 6,088 passing tests, with two
   failures caused by missing checked-in dependency patches.
3. `node scripts/postinstall.mjs`: native modules ready; all four repository
   patches applied. Focused patch checks passed, 2 files / 4 tests:
   `npx vitest run --config config/vitest/vitest.unit.config.ts tests/dependency-patch-compatibility.test.ts tests/vitest-source-map-residue.test.ts`.
4. `npm test`: **PASS**, 929 files passed, 3 skipped; **6,090 tests passed,
   4 skipped**, 156.03 seconds. This final full gate began at `73e696f4`; its
   production/test inputs remained byte-identical through the two subsequent
   harness-only cleanup safeguards. No test baseline or skip was weakened.
5. `node --test scripts/acceptance/hermes-harness.test.mjs`: **24 passed,
   0 failed, 0 skipped**, rerun against the final code. Covers fail-closed missing
   evidence, model/process/session/cancellation invariants, replay, UI scope/time,
   byte hashes, split Unicode, default preflight, saved-receipt revalidation, and
   a real observer subprocess relay. All positive controls are synthetic.
6. Independent reviewer: `npm run test:integration -- tests/hermes-worker-real-path.test.ts`:
   **1 file / 3 tests passed**, 2.3 seconds. This is the existing simulated ACP
   test and is explicitly not real Hermes/provider proof. The reviewer also
   exercised all 77 split-byte boundaries of a Unicode observation frame.
7. `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit`: **PASS**, rerun
   against final code. The initial default-heap attempt exhausted its 2 GiB heap;
   the bounded 4 GiB retry completed without TypeScript diagnostics.
8. `npx eslint scripts/acceptance/hermes-installed-driver.ts scripts/acceptance/*.mjs`:
   **PASS**, rerun against final code.
9. `node --import tsx scripts/rule-check.ts --base=74022d868254222df0e496229f4ca54bc36975e6`:
   **PASS**, 1 TypeScript file, zero violations. The ordinary npm/tsx CLI invocation
   was blocked by its sandbox Unix-socket IPC; the direct Node loader ran the same
   repository rule-check script and arguments without that CLI listener.
10. `npm run test:classification:check`, `npm run protocol:check`, and
    `git diff --check`: **PASS**.
11. `git diff --exit-code 74022d868254222df0e496229f4ca54bc36975e6 HEAD -- src tests package.json package-lock.json`:
    **PASS** (no changes). Production and existing-test baseline are unchanged.
12. `node scripts/acceptance/hermes-installed.mjs --output <new-private-directory>`:
    **exit 2 / BLOCKED**, clean source at the tested code commit. Exact redacted
    output is in [hermes-3388-preflight.json](./hermes-3388-preflight.json).

## Acceptance still open

No installed Hermes executable or configured profile was available. No provider
route/model was selected, no model was called, and no physical paired-device/UI
flow was run. The final preflight reports both installed runtime and mission/Ripple
UI as **BLOCKED**. No paid call, installation change, upstream PR, merge, or release
was performed.

Current inspected Hermes source may return an empty model-switch response without
an active-model state update. The strict before-prompt model oracle intentionally
does not convert that ACK into observed state. This known compatibility/evidence
residual is explained in the [runbook](../hermes-installed-acceptance.md), along with
the precise installed-host and manual UI steps needed to complete acceptance.

An independent read-only review reproduced and then verified corrections for
missing-spawn/settlement false positives, stale model evidence, unbound UI evidence,
saved-PASS laundering, and binary hash corruption. The final review found no blocker
to publishing **qualification tooling**; it did not certify installed acceptance.

The only later code safeguards stop an unexpectedly accepted unsupported-model
session before failing, and suppress hooks/signing for the scratch bootstrap commit.
Normal HOME and the installed worker/orchestrator behavior remain unchanged.

## Follow-on: active-model confirmation and stricter correlation

October 9, 2026. This remains **qualification, not installed acceptance**.

- Continued from the published harness `b913f1dbcb2067bbc1769f954cf0de576e5f8bf4`
  on the separate fork branch `fix/hermes-model-evidence-3388`.
- Tested o8 code commit: `ad2e133b0f042821d6bdc1955e10383cd1cdd055`.
  Production `src/`, existing `tests/`, package manifest and lock remain unchanged.
- Companion [Hermes signal](https://github.com/kvnloo/hermes-agent/commit/53638457c8bd5343b069a0ae080dcaaad9118862)
  is fork-only, based on upstream `46d7718a52ff33accb15dc0501736fbdb6833cab`.
  Its published tree `40c0a6ac331e462ead8ec92d8a78b36b39bd3940` exactly matches
  the locally tested tree. See its [sanitized receipt](https://github.com/kvnloo/hermes-agent/blob/53638457c8bd5343b069a0ae080dcaaad9118862/tests/acp_adapter/active-model-confirmation.receipt.json).
- Ownership checks included fork #447, current ACP work and existing configOptions
  migrations #75358, #81067, #88630 and #106606. Those migrations were not duplicated.
  Kevin's worker implementation, hurttlocker's model/resume fixes, and
  LavonTMCQ/Marquise's Ripple work remain unchanged and credited.

The successful Hermes model response now includes optional
`_meta.hermes.activeModelId`, derived from the rebuilt live agent's literal
provider/model while model mutation is still excluded. It never substitutes the
requested alias or resolver proposal. Missing live identity gives no evidence;
rejections and failed construction still fail. No catalog call, session/load
replay, provider prompt or new persistence path is added.

The observer accepts the correlated successful server response and hashes its
request's session. The oracle requires the latest session pin's exact ACK or a
later independent model-state notification. It rejects errors, client echoes,
wrong sessions, empty ACKs and earlier model replies arriving after a newer pin.
Literal alias/provider-ID differences remain fail-closed.

### Executed checks

Node 22.23.3 / npm 11.9.0, Python 3.14.8 / locked ACP SDK 0.9.0:

1. New o8 tests on the old oracle: **4 failed / 26 passed**. After the change:
   `node --test scripts/acceptance/hermes-harness.test.mjs`: **31 passed**,
   zero failed/skipped, including the independent review's delayed-old-reply case.
2. `npm test`: **929 files passed / 3 skipped; 6,093 tests passed / 4 skipped**,
   155.17 seconds. No skip or failure baseline changed. An earlier run used
   Node-24-built native modules with Node 22 and failed (32 files / 202 tests plus
   five errors); it is not a pass. `npm rebuild better-sqlite3 node-pty` under
   Node 22 succeeded, SQLite loading was explicitly verified, then the full gate
   above was rerun successfully.
3. `npm run test:integration -- tests/hermes-worker-real-path.test.ts`:
   **1 file / 3 tests passed**. Simulated ACP remains distinct from installed proof.
4. `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit`: **PASS**.
5. `npx eslint scripts/acceptance/hermes-observer.mjs scripts/acceptance/hermes-evidence.mjs scripts/acceptance/hermes-harness.test.mjs`:
   **PASS**. Classification, protocol generation consistency and `git diff --check`:
   **PASS**.
6. Hermes actual SDK-router regression on unpatched main: **1 failed / 5 passed**;
   patched: **6 passed**. Full `scripts/run_tests.sh tests/acp_adapter -j 4`:
   **28 files / 204 tests passed / 1 existing Windows-only test skipped**.
   Official `scripts/check`: **11 checks passed**. Resolver/agent factory are
   controlled test doubles, while the SDK router and session manager are real.
7. Independent reviewer reran **31 o8 harness** and **13 Hermes focused tests**.
   They found and rechecked the delayed-old-ACK correction; no remaining blocking
   finding in the reviewed diff. This is not a provider or UI certification.
8. Clean committed preflight: **exit 2 / BLOCKED**. See the
   [redacted preflight](./hermes-3388-model-confirmation-preflight.json).

No installed Hermes executable/profile, reviewed route, or physical paired-device
UI was available. Neither installed ACP/provider nor mission/Ripple acceptance was
run. No provider spend, live installation change, upstream PR, merge or promotion.
Hermes exact published-SHA Actions/check-runs queries returned zero; neither repo's
normal CI runs on this non-main branch-only publication. Do not call remote CI green.
