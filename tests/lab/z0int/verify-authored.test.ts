import { describe, expect, it } from "vitest";
import { verifyAgainstAuthoredIntent } from "../../../src/lib/lab/z0int/verify-authored";

const ref = { id: "intent-1", revision: 1 };
const checks = [
  { id: "latency", satisfied: true },
  { id: "interaction", satisfied: true },
];

describe("verify_against_authored_intent", () => {
  it("does not pass a done worker when an authored check fails", () => {
    const result = verifyAgainstAuthoredIntent({
      intentRef: ref,
      workerStatus: "done",
      checks: [
        { id: "latency", satisfied: true },
        { id: "interaction", satisfied: false },
      ],
    });
    expect(result.workerDone).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("authored-checks-failed");
  });

  it("fails closed when the authored ref is missing", () => {
    const missing = verifyAgainstAuthoredIntent({
      intentRef: null,
      workerStatus: "done",
      checks,
    });
    expect(missing.passed).toBe(false);
    expect(missing.reason).toBe("missing-ref");
    const blank = verifyAgainstAuthoredIntent({
      intentRef: { id: "  ", revision: 1 },
      workerStatus: "done",
      checks,
    });
    expect(blank.passed).toBe(false);
    expect(blank.reason).toBe("missing-ref");
  });

  it("fails closed when checks are missing", () => {
    const result = verifyAgainstAuthoredIntent({
      intentRef: ref,
      workerStatus: "done",
      checks: [],
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("missing-checks");
  });

  it("passes only when the worker is done and every authored check passed", () => {
    const result = verifyAgainstAuthoredIntent({
      intentRef: ref,
      workerStatus: "done",
      checks,
    });
    expect(result.passed).toBe(true);
    expect(result.reason).toBe("verified");
    const running = verifyAgainstAuthoredIntent({
      intentRef: ref,
      workerStatus: "running",
      checks,
    });
    expect(running.passed).toBe(false);
    expect(running.workerDone).toBe(false);
    expect(running.reason).toBe("worker-not-done");
  });
});
