import { verifyAgainstAuthoredIntent } from "../../../src/lib/lab/z0int/verify-authored";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error("FAIL", message);
    process.exit(1);
  }
}

const ref = { id: "intent-1", revision: 1 };
const checks = [
  { id: "latency", satisfied: true },
  { id: "interaction", satisfied: true },
];

const failed = verifyAgainstAuthoredIntent({
  intentRef: ref,
  workerStatus: "done",
  checks: [
    { id: "latency", satisfied: true },
    { id: "interaction", satisfied: false },
  ],
});
assert(failed.workerDone === true && failed.passed === false, "done cannot pass when authored checks fail");
assert(failed.reason === "authored-checks-failed", "reason names the authored failure");

const missing = verifyAgainstAuthoredIntent({
  intentRef: null,
  workerStatus: "done",
  checks,
});
assert(missing.passed === false && missing.reason === "missing-ref", "missing ref fails closed");

const blank = verifyAgainstAuthoredIntent({
  intentRef: { id: " ", revision: 1 },
  workerStatus: "done",
  checks,
});
assert(blank.passed === false && blank.reason === "missing-ref", "blank ref fails closed");

const noChecks = verifyAgainstAuthoredIntent({
  intentRef: ref,
  workerStatus: "done",
  checks: null,
});
assert(noChecks.passed === false && noChecks.reason === "missing-checks", "missing checks fail closed");

const ok = verifyAgainstAuthoredIntent({
  intentRef: ref,
  workerStatus: "done",
  checks,
});
assert(ok.passed === true && ok.reason === "verified", "all authored checks pass");

const running = verifyAgainstAuthoredIntent({
  intentRef: ref,
  workerStatus: "running",
  checks,
});
assert(running.passed === false && running.workerDone === false, "not done is not verified success");

console.log("PASS");
