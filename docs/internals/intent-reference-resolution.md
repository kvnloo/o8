# Exact authored-intent reference resolution

First prerequisite for the mission-admission follow-up to #3185, stacked on
[kvnloo/o8#27](https://github.com/kvnloo/o8/pull/27).

`POST /api/orchestrator/intent-contract/resolve` accepts the complete `ref` object
returned by the existing authored-intent store: `id`, `revision`, `sourceHash`,
`semanticFingerprint`, `validatorRevision`, and `inputSha256`. The body is bounded
to 1 KiB. Only the existing operator principal is admitted; authorization is
checked before reading and again after asynchronous verification. No middleware
allowlist or worker/device capability is added. Responses are `no-store`.

The service copies and validates every reference field, loads only that exact
stored revision, compares the complete reference, and sends the stored authored
bytes through the existing configured AODL canonical consumer. A matching stored
fingerprint alone is not proof. No current/latest pointer, semantic hash
reimplementation, fallback validator, mutation, mission creation, worker launch,
or permission grant is introduced.

Results: `200` returns `{ok:true,record}`; malformed reference is `400`, oversized
input `413`, missing exact revision `404`, reference mismatch `409`, damaged
persisted identity `500`, and unavailable/mismatched configured validation `503`.
An originally accepted document that the current canonical consumer rejects also
fails closed. Errors return codes, not private document values. Authentication
failures retain the existing authentication boundary's response.

This API returns a verified **snapshot**, not a dispatch token or reservation.
It is not yet wired to `create-mission`. The next slice must resolve this full ref
inside mission admission and retain it through mission/packet normalization,
persistence, crash/retry reconciliation and worker prompts/handoffs. It must not
replace `PacketTaskContract` or claim that structural validation enforces runtime
budgets/authority. Caller-controlled paths or a `latest` revision must never be
substituted for the pinned reference.

The existing real-process test lane now includes resolution and corrupted-record
checks using the actual pinned AODL Python checkout plus real o8 routes and store.
Authentication/principal and the temporary data root are fixture boundaries;
installed-host bearer/middleware behavior and hostile filesystem mutation remain
separate acceptance work. Run the downstream workflow on this branch; a passing
check on the parent PR is not evidence for these new sources.

Credit: builds on Marquise Hurtt's continuity-first requirements, LavonTMCQ's
handoff/worker-contract foundations, and the existing AODL canonical consumer and
immutable store from #27. No independent review or end-to-end mission completion
is claimed by this slice.
