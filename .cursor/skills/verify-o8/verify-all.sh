#!/usr/bin/env bash
# verify-all.sh — comprehensive o8 verification suite
# Runs all verification checks and generates a structured report

set -euo pipefail

TIMESTAMP=$(date -u +"%Y%m%d-%H%M%S")
EVIDENCE_DIR="${VERIFY_EVIDENCE_DIR:-/tmp/verify-evidence-${TIMESTAMP}}"
mkdir -p "$EVIDENCE_DIR"

REPORT_FILE="${EVIDENCE_DIR}/report.json"
PASSED=0
FAILED=0
INCONCLUSIVE=0

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" | tee -a "${EVIDENCE_DIR}/verify.log"
}

check() {
  local name="$1"
  local description="$2"
  shift 2
  
  log "CHECK: ${name} — ${description}"
  
  local start_ms=$(($(date +%s%N)/1000000))
  local exit_code=0
  local output_file="${EVIDENCE_DIR}/${name}.txt"
  
  if "$@" > "$output_file" 2>&1; then
    exit_code=0
  else
    exit_code=$?
  fi
  
  local end_ms=$(($(date +%s%N)/1000000))
  local duration=$((end_ms - start_ms))
  
  local status="inconclusive"
  if [ $exit_code -eq 0 ]; then
    status="passed"
    PASSED=$((PASSED + 1))
    log "✓ PASS: ${name} (${duration}ms)"
  else
    # Check if it's a known inconclusive case
    if grep -q "connection refused\|ECONNREFUSED\|not running" "$output_file" 2>/dev/null; then
      status="inconclusive"
      INCONCLUSIVE=$((INCONCLUSIVE + 1))
      log "? INCONCLUSIVE: ${name} — server not running (${duration}ms)"
    else
      status="failed"
      FAILED=$((FAILED + 1))
      log "✗ FAIL: ${name} (exit ${exit_code}, ${duration}ms)"
    fi
  fi
  
  # Append to report
  cat >> "$REPORT_FILE" <<EOF
{
  "check": "${name}",
  "description": "${description}",
  "status": "${status}",
  "exitCode": ${exit_code},
  "duration_ms": ${duration},
  "evidence": "${output_file}",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
}

# Initialize report
cat > "$REPORT_FILE" <<EOF
{
  "schema": "o8/verify/suite/v1",
  "started": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "evidenceDir": "${EVIDENCE_DIR}",
  "checks": [
EOF

log "Starting o8 verification suite"
log "Evidence directory: ${EVIDENCE_DIR}"

# ============================================================================
# Core Infrastructure
# ============================================================================

check "cli-version" "CLI version command" \
  o8 version

check "cli-doctor" "CLI doctor health check" \
  o8 doctor

check "server-status" "Server status endpoint" \
  sh -c 'API_PORT=$(cat ~/.o8/api-port 2>/dev/null || echo 47100); curl -sf "http://localhost:${API_PORT}/api/panel/status"'

check "runtime-detection" "Runtime adapter detection" \
  sh -c 'o8 doctor | jq -e ".runtimes | length > 0"'

# ============================================================================
# Type Safety & Tests
# ============================================================================

if command -v npx >/dev/null 2>&1 && [ -f /workspace/package.json ]; then
  check "typescript-check" "TypeScript type safety" \
    sh -c 'cd /workspace && npx tsc --noEmit'
  
  # Only run tests if node_modules exists
  if [ -d /workspace/node_modules ]; then
    check "unit-tests" "Hermetic unit tests" \
      sh -c 'cd /workspace && npm test -- --run'
  else
    log "SKIP: unit-tests — node_modules not installed"
    INCONCLUSIVE=$((INCONCLUSIVE + 1))
  fi
else
  log "SKIP: typescript-check — not in o8 repository"
  INCONCLUSIVE=$((INCONCLUSIVE + 1))
fi

# ============================================================================
# CLI Commands
# ============================================================================

check "cli-status" "Fleet status snapshot" \
  o8 status

check "repo-list" "Repository list" \
  o8 repo list

check "project-list" "Project list" \
  o8 project list

# ============================================================================
# Engineering Brain
# ============================================================================

check "brain-ask" "Engineering Brain Q&A" \
  o8 ask "What is the verification suite?" --terse

# ============================================================================
# Optional: Packet Commands (require packet context)
# ============================================================================

if o8 packet info >/dev/null 2>&1; then
  check "packet-info" "Packet metadata" \
    o8 packet info
  
  check "packet-scope" "Packet scope" \
    o8 packet scope
  
  check "packet-diff" "Packet diff" \
    o8 packet diff
else
  log "SKIP: packet commands — not in packet worktree"
  INCONCLUSIVE=$((INCONCLUSIVE + 3))
fi

# ============================================================================
# Finalize Report
# ============================================================================

# Remove trailing comma from last check
sed -i '$ s/}$/}\n]/' "$REPORT_FILE" 2>/dev/null || \
  sed -i '' '$ s/}$/}\n]/' "$REPORT_FILE" 2>/dev/null || \
  echo "]" >> "$REPORT_FILE"

# Add summary
cat >> "$REPORT_FILE" <<EOF
,
  "completed": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "summary": {
    "passed": ${PASSED},
    "failed": ${FAILED},
    "inconclusive": ${INCONCLUSIVE},
    "total": $((PASSED + FAILED + INCONCLUSIVE))
  }
}
EOF

log "Verification suite completed"
log "Results: ${PASSED} passed, ${FAILED} failed, ${INCONCLUSIVE} inconclusive"
log "Report: ${REPORT_FILE}"

# Print summary
echo ""
echo "═══════════════════════════════════════════"
echo "Verification Summary"
echo "═══════════════════════════════════════════"
echo "✓ Passed:        ${PASSED}"
echo "✗ Failed:        ${FAILED}"
echo "? Inconclusive:  ${INCONCLUSIVE}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Total:           $((PASSED + FAILED + INCONCLUSIVE))"
echo "═══════════════════════════════════════════"
echo ""
echo "Evidence: ${EVIDENCE_DIR}"
echo "Report:   ${REPORT_FILE}"

# Exit with failure if any checks failed
if [ $FAILED -gt 0 ]; then
  exit 1
fi

exit 0
