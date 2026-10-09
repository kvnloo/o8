# Installed Hermes and Ripple acceptance (#3388)

This downstream harness complements [#3391](https://github.com/hurttlocker/o8/pull/3391)
and [#3146](https://github.com/hurttlocker/o8/pull/3146). It reuses the production
`hermesRuntime` and its shared owned-ACP store. It does not implement another runtime,
install Hermes, change the operator's installation, configure credentials, launch the
app, send a mobile message, or make a provider call by default.

Kevin's implementation, hurttlocker's model/resume fixes and review, and
LavonTMCQ/Marquise's existing Ripple work are the foundation. Existing
`tests/hermes-worker-real-path.test.ts` and the governed-profile smoke remain unchanged.
The latter tests the **orchestrator**, not this worker acceptance boundary.

## Safe one-command preflight

From a clean committed checkout, with Node 22:

```sh
node scripts/acceptance/hermes-installed.mjs
```

Exit codes: `0` all gates passed, `1` an attempted gate failed, `2` blocked or not run.
Preflight always leaves live/UI gates BLOCKED, even if every prerequisite exists.
It writes a private temporary `receipt.json` and `ui-template.json`. Supply
`--output /absolute/new-directory` to choose a **new** output directory. Existing
output directories are refused to prevent overwriting evidence.

Qualification tests (no provider use):

```sh
node --test scripts/acceptance/hermes-harness.test.mjs
npm run test:integration -- tests/hermes-worker-real-path.test.ts
```

These tests validate the harness and existing simulated ACP seam only. They are
never evidence of installed/native/provider PASS.

## Prepare the installed acceptance host manually

1. Use an already authorized POSIX acceptance machine, Node 22 / npm 11, Git,
   Python 3, and `npm ci` in this checkout. Do not run against production data.
2. If Hermes is absent, the operator installs it using the official
   [Hermes repository instructions](https://github.com/NousResearch/hermes-agent)
   and completes `hermes setup` themselves. This harness does not install or
   modify the user's existing installation. Never paste credentials into receipts.
3. Review the existing provider route. Only an authorized **local** or confirmed
   **subscription** route is eligible; metered/API spending is not authorized here.
   A model name or this environment flag cannot prove billing. If eligibility is
   unknown, stop at preflight. The harness never changes provider settings or
   falls back to another provider.
4. Review the selected worker profile's tool policy before authorizing the run.
   Use an existing dedicated acceptance profile if available via `HERMES_HOME`.
   Disable unrelated network/MCP/delegation integrations there manually. The
   worker runtime's one-shot permission behavior is unchanged. Prompts are not
   a security sandbox; use a host/tool boundary already authorized for scratch
   execution. Do not point this at a profile with unreviewed hooks.
5. Select a supported **non-default** model ID from the installed Hermes ACP
   model list. Set `O8_HERMES_BIN` to its installed executable if not on PATH.
   Verify `hermes --version` locally. Do not substitute the test fixture or a mock.

After explicit authorization of these bounded prompts, run:

```sh
O8_HERMES_ACCEPTANCE_MODEL='YOUR_NON_DEFAULT_MODEL_ID' \
O8_HERMES_ACCEPTANCE_ROUTE='subscription' \
O8_HERMES_ACCEPTANCE_AUTHORIZED='yes' \
node scripts/acceptance/hermes-installed.mjs --live --output /absolute/new-run
```

Use `local` instead of `subscription` only for a reviewed local provider. The flag
is an operator attestation, not a billing detector. Four prompt submissions occur:
first, same-process second, a cancellable 60-second local Python probe, and a
new-process resumed turn. An unsupported-model launch is attempted first and must
be rejected **before any prompt**. If a regression accepts it, the production launch
may submit the harmless sentinel prompt; the driver immediately interrupts that
unexpected session and fails. No other application or upstream communication
is sent. The driver has bounded waits and a ten-minute outer deadline.

## What is measured

- The exact production `hermesRuntime.launch/resume/interrupt` entry points,
  `hermes acp --accept-hooks`, installed executable SHA-256 and ACP identity/version, a generated scratch
  Git working tree, and packet/lane metadata. This is not a mission-control route
  test: the actual mission dispatch/picker remains a separate manual gate below.
- Normal `HOME` remains unchanged. `O8_DATA_DIR`, legacy `CORTEX_IDE_DATA_DIR`, and
  session roots point to the private run. Production code seeds a distinct
  `HERMES_HOME` for each worker. A tool-written observation proves actual cwd/HOME/
  HERMES_HOME; source profile file metadata must remain unchanged.
- The non-default model pin precedes every prompt, is acknowledged, and is followed
  by an observed current-model state. An empty acknowledgement alone is insufficient.
  If an installed Hermes version does not expose current/default model evidence,
  this gate fails rather than inventing proof; inspect the protocol locally.
- Exactly three completed turns plus one interrupted turn; the second uses the same
  actual Hermes PID, reconnect uses a new PID and the same remote session ID, and
  `session/resume` succeeds before the resumed prompt.
- Cancel is sent while a prompt is in flight; the original process exits, the local
  Python probe PID exits, and its post-sleep marker never appears. If tool cancellation
  fails, the bounded probe may finish after 60 seconds; do not call this a PASS or
  assume the tool was stopped because the UI said “interrupted.”
- Prior transcript prefix and IDs remain stable; each user prompt/completion token
  and tool is represented once. Persisted tool IDs match only live post-prompt ACP
  output, excluding reconnect replay. Scratch file contents must match the three
  intended mutations exactly, without duplicated appends.
- Fleet, transcript, changed-files/review discovery, observed provider readiness,
  and `costSource: unknown`. No context-size number is converted into a token charge.

The observer is a byte relay around the installed executable, not a simulated
server. It records allowlisted protocol metadata and hashes, not prompts, tool
arguments, response text, config, credentials, or stderr. Unredacted production logs,
worker profiles (which may contain copied credentials), and the scratch tree remain
under `private/` with restrictive permissions. Never attach or commit `private/`.
Review all receipts and screenshots before sharing; no upload happens automatically.

## Physical paired-device / Ripple evidence

Keep [#3388](https://github.com/hurttlocker/o8/issues/3388) open until this is done.
The harness cannot establish real UI behavior from unit tests or manifest booleans.
A reviewer must perform each check and capture actual screenshots/redacted logs on
an already paired physical device. No new pairing or permission is created here.
Use the app built from the exact tested commit and record device/app version.

Copy `ui-template.json` to `ui-evidence.json` in the run directory. Fill reviewer,
appCommit, device, observedAt (after the run began), and physicalPairedDevice.
For each check record PASS only after observing the behavior. Keep artifacts under
that directory, with relative paths and SHA-256 hashes of the actual file bytes.
No expected-output templates or screenshots from another run qualify.

1. `worker-picker-and-model`: choose the ready Hermes **worker**, not orchestrator;
   show the non-default model selection and actionable readiness/auth errors when
   unavailable. Capture model selection before dispatch, without displaying keys.
2. `packet-dispatch-cwd`: explicitly send one harmless mission/packet from o8 to an
   authorized scratch working tree. Capture its packet/session link and a
   tool-written cwd/result. Verify it did not operate in the user's repository root.
3. `fleet-transcript-review`: show the same packet in fleet, ordered transcript,
   review diff, and truthful unknown cost. Verify no replay duplicates after stop/
   reconnect. Record real identifiers locally and redact before sharing.
4. `ripple-choice-manual-send`: use final voice dictation with a consequential
   ambiguity. Choose a clarification, observe no outgoing message before manually
   pressing Send, then exactly one outgoing turn with the confirmed choice.
5. `ripple-edit-dismiss-invalidation`: repeat with a fresh draft, edit after choice;
   confirm the old receipt is not reused. Repeat with dismissal and new dictation.
6. `ripple-chat-repo-scope-and-late-response`: with a pending resolution, change chat
   or repository and allow the old response to arrive. It must not change the newer
   composer or authorize that turn. Repeat with a newer dictation response arriving
   first. Record both scopes and outgoing message IDs in redacted evidence.
7. `ripple-offline-reconnect-exactly-once`: confirm a choice, go offline, manually
   queue the message, reconnect. The original scope's receipt must accompany exactly
   one outgoing message with no automatic sending of an unsent draft.
8. `ripple-stale-or-malformed-receipt-blocked`: on an isolated test profile only,
   exercise an expired or malformed queued receipt using the existing composer
   test scenarios as reference. It must remain queued with no ambiguous dispatch.
9. `ripple-no-authority-expansion`: inspect the outgoing confirmed patch. Only
   intent/constraints/references/verification may change, never permissions or
   execution authority. Capture rejection of an out-of-scope patch in the test
   profile. Do not alter a production queue or grant new authority to perform this.

A manifest entry looks like:

```json
{"status":"PASS","artifacts":[{"path":"evidence/manual-send.png","sha256":"64 lowercase hex characters"}]}
```

Revalidate saved runtime evidence plus UI artifacts without any new provider calls:

```sh
node scripts/acceptance/hermes-installed.mjs --verify /absolute/new-run \
  --ui /absolute/new-run/ui-evidence.json
```

Runtime logs/facts are revalidated on every verification, app commit/run/timestamp
must match, and artifact hashes/path bounds are checked. Artifact contents still
require human review; this is an attested manual gate, not image understanding or
cryptographic provenance. A missing UI gate leaves overall BLOCKED even if the
installed runtime gate passed. Fixture CI cannot close either live gate.

After reviewing evidence, remove only the private run directory you created when
its credentials/logs are no longer needed. The script never cleans a user profile.

### Known active-model evidence limitation

The inspected Hermes ACP implementation returns an empty `SetSessionModelResponse`
after switching its agent, and does not necessarily emit a current-model update.
Its new-session response reports the default; an empty new session also need not
exist in `state.db` yet. Therefore neither an empty ACK nor a missing initial DB row
proves the selected model was active before the first prompt. This harness deliberately
fails that oracle on such versions. It remains a useful lifecycle/transcript run,
not completed installed acceptance. Do not replace the current-model requirement
with a fixture response or the requested model recorded by o8 itself.

To close this residual, use an installed version that exposes the actual current
model after selection, or obtain an independently reviewed upstream observation
of the live session model before prompt dispatch and adapt the evidence reader.
No protocol-injecting `session/load` probe is hidden in this observer: that would
introduce its own replay and change the execution path being measured.
