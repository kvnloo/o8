---
name: verify-o8
description: Comprehensive verification framework for o8 — validates core features, CLI commands, API endpoints, and development workflows. Provides structured pass/fail/inconclusive evidence for quality gates.
---

# o8 Verification Skill

This skill provides a systematic verification framework for o8 features and infrastructure. It maps the o8 surface area and provides structured verification commands that agents and operators can run.

## When to Use

- Before merging major changes to validate no regression
- After infrastructure changes (DB schema, API routes, CLI commands)
- When diagnosing production issues
- As part of the ship gate
- When the user explicitly asks to "verify o8" or "check if o8 works"

## Feature Map

The o8 verification surface covers these domains:

### 1. CLI Commands (`o8 <command>`)
- **doctor** — port resolution, server reachability, runtime detection
- **status** — fleet snapshot, packet states
- **version** — CLI + server version sync
- **repo** — repository registry operations
- **project** — project management
- **packet** — packet lifecycle (info, diff, scope, heartbeat)
- **mission** — mission orchestration
- **ask** — Engineering Brain Q&A
- **cortex** — memory operations (observe, recall)
- **browser** — embedded/engine browser control
- **spec** — o8.md review surface
- **team** — git-native coordination
- **inbox** — governance approval queue
- **task** — project-backed task pool

### 2. API Endpoints
- **/api/panel/status** — server health
- **/api/setup/detect** — runtime detection
- **/api/panel/repos** — repository list
- **/api/orchestrator/\*** — orchestrator operations
- **/api/lanes/\*** — lane management
- **/api/cortex/\*** — memory & brain
- **/api/runtime/\*** — runtime adapter registry
- **/api/worktrees/\*** — worktree operations
- **/api/review/\*** — review surface
- **/api/mobile/\*** — mobile real-time

### 3. Development Workflow
- **Type safety** — `npx tsc --noEmit`
- **Tests** — `npm test` (hermetic), `npm run test:integration` (resource-owning)
- **Build** — `npm run build`
- **Dev server** — `npm run dev:next` + `npm run dev:ws`
- **Rule checks** — file ceiling, port hardcoding, path hardcoding

### 4. Runtime Adapters
- **Codex** — default worker runtime
- **Claude Code** — resident orchestrator
- **Gemini** — standard-tier worker
- **Cursor** — frontier worker
- **opencode** — standard-tier worker
- **Grok** — frontier worker
- **Pi** — worker runtime

### 5. Infrastructure
- **SQLite** — `~/.o8/cortex-ide.db` integrity
- **Port allocation** — `~/.o8/api-port` + `~/.o8/ws-port`
- **Token auth** — `~/.o8/ws-token`
- **WebSocket** — WS server health
- **Theme system** — light/dark palette switching
- **MCP servers** — operator + cortex MCP

## Verification Commands

### Quick Health Check
```bash
o8 doctor --human
```
**Pass criteria**: `OK` output, no error-level findings, server reachable

### Comprehensive Verification
```bash
# 1. CLI health
o8 doctor
o8 version
o8 status

# 2. Type safety
npx tsc --noEmit

# 3. Core tests
npm test

# 4. API reachability
curl -s http://localhost:$(cat ~/.o8/api-port 2>/dev/null || echo 47100)/api/panel/status | jq .

# 5. Runtime detection
o8 doctor --human | grep -A 10 "runtimes"

# 6. Engineering Brain
o8 ask "What is the default file ceiling?" --terse
```

### Feature-Specific Verification

#### Verify CLI Doctor
```bash
# Should pass: server reachable, config resolved
o8 doctor --human | grep "reachable.*yes"

# Should detect runtimes
o8 doctor | jq '.runtimes | length'
```

#### Verify Repository Management
```bash
# List repos (should not error)
o8 repo list

# Add current repo (idempotent)
o8 repo add /workspace
```

#### Verify Engineering Brain
```bash
# Ask a question
result=$(o8 ask "What is the theming rule?" --terse)
echo "$result" | jq -r '.answer' | grep -q "." && echo "PASS" || echo "FAIL"
```

#### Verify Packet Commands
```bash
# These require being inside a packet worktree
# o8 packet info
# o8 packet scope
# o8 packet diff
```

## Evidence Recording Pattern

All verification results should follow this schema:

```json
{
  "schema": "o8/verify/v1",
  "timestamp": "2026-09-09T23:24:00Z",
  "feature": "doctor-command",
  "status": "passed" | "failed" | "inconclusive",
  "evidence": {
    "command": ["o8", "doctor"],
    "exitCode": 0,
    "output": "...",
    "duration_ms": 234
  },
  "blockers": []
}
```

## Running the Full Verification Suite

```bash
# Run all verifications
.cursor/skills/verify-o8/verify-all.sh

# Or use the CLI
o8 verify-suite --report /tmp/verify-results.json
```

## Pass/Fail/Inconclusive Rules

### PASS
- Command exits 0
- Expected output present (e.g., `OK`, valid JSON schema)
- No error-level findings
- Matches known-good baseline

### FAIL
- Command exits non-zero (unless expected)
- Error-level findings present
- Required output missing
- Regression from baseline

### INCONCLUSIVE
- Dependencies missing (e.g., server not running)
- Credentials unavailable
- Environment setup incomplete
- Test skipped due to precondition

## Common Blockers

1. **Server not running** → start `npm run dev`
2. **Dependencies missing** → `npm install`
3. **Port conflicts** → `o8 doctor --repair`
4. **SQLite locked** → close other o8 instances
5. **Node version mismatch** → use Node 22

## Integration with Ship Gate

Before shipping:

1. ✓ `npx tsc --noEmit` — type safety
2. ✓ `npm test` — hermetic tests
3. ✓ `npm run rule-check -- --base=staging` — rule compliance
4. ✓ `o8 doctor` — CLI + server health
5. ✓ `npm run build` — production build succeeds

## Output Formats

### Human-readable
```bash
o8 doctor --human
```

### Machine-readable (default)
```bash
o8 doctor | jq .
```

## Extending the Verification Suite

To add a new verification:

1. Add the feature to the feature map above
2. Define pass/fail criteria
3. Write a test script in `verify-o8/checks/`
4. Update `verify-all.sh` to include it
5. Document the verification command

## Architecture Notes

- All CLI commands use JSON output by default (`--human` for pretty print)
- Exit codes are stable: 0=ok, 1=invalid args, 2=connection refused, 3=unauthorized, 4=not found, 5=conflict
- The verification suite should be hermetic (no external dependencies)
- Evidence should survive cleanup (write to `/tmp/verify-evidence-<timestamp>/`)

## Related Files

- `cli/src/commands/doctor.ts` — doctor command implementation
- `cli/src/commands/doctor.test.ts` — doctor test suite
- `tests/route-coverage.test.ts` — API route policy tests
- `scripts/smoke.mjs` — smoke test suite
- `vitest.config.ts` — test configuration

## Future Enhancements

- [ ] Visual regression testing (screenshot capture + diff)
- [ ] Performance benchmarks (CLI latency, API response times)
- [ ] Load testing (concurrent packet operations)
- [ ] Mobile app verification (WebSocket + push notifications)
- [ ] Browser automation tests (Playwright for UI)
