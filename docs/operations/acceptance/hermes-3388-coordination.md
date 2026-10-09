# Installed Hermes acceptance coordination

- Owner: dot/ayo
- Issue: [hurttlocker/o8#3388](https://github.com/hurttlocker/o8/issues/3388)
- Base: `74022d868254222df0e496229f4ca54bc36975e6` (upstream main checked October 9, 2026)
- Fork main: `4f6f34d718d916e80b2d03e1e36eb9e37181b414`
- Branch: `chore/hermes-installed-acceptance-3388`
- Status: harness delivered and qualified; installed/provider/physical-UI acceptance remains blocked. The initial claim was recorded before implementation in commit `0a2515e2`.
- Intended files: `scripts/acceptance/hermes-*`, harness tests under that directory,
  `docs/operations/hermes-installed-acceptance.md`, and this receipt/coordination directory.
- Intended symbols: installed preflight, production AgentRuntime driver, redacted ACP
  observer, evidence validation, and a separately evidenced manual Ripple checklist.

The existing `tests/hermes-worker-real-path.test.ts`,
`tests/fixtures/hermes-acp-runtime.mjs`, and
`tests/smoke/hermes-governed-profile-smoke.ts` were inspected first. No existing
installed-worker acceptance script or fork acceptance branch was found. The open
issue's latest owner comment explicitly keeps installed-provider acceptance open.
This work does not replace the existing fixture or alter production runtime code.

Credits remain with Kevin's #3391 implementation, hurttlocker's model-selection
and resume-replay corrections/review, and LavonTMCQ/Marquise's Ripple work (#3146
builds on #640). This acceptance tooling claims none of that implementation.

A new public fork issue was not created: publication approval was unavailable.
This branch-local coordination record is the authorized fallback. No upstream
comment, PR, merge, release, or main-branch write is part of this lane.
