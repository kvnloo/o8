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
