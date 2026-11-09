import { describe, expect, it } from "vitest";
import {
  resolveClarification,
  surfaceOneClarification,
  type RippleQuestion,
} from "../../../src/lib/lab/z0int/ripple-clarification";

const latency: RippleQuestion = {
  question: "Which latency should stay under the budget?",
  choices: [
    { id: "p99", patchPath: "constraints.latency" },
    { id: "paint", patchPath: "verification.paint" },
  ],
};

const scope: RippleQuestion = {
  question: "Which surface is in scope?",
  choices: [
    { id: "mobile", patchPath: "intent.surface" },
    { id: "desktop", patchPath: "intent.surface" },
  ],
};

describe("ripple_one_clarification_no_autosend", () => {
  it("surfaces at most one question and does not auto-send", () => {
    const surfaced = surfaceOneClarification([latency, scope, scope]);
    expect(surfaced.questions).toHaveLength(1);
    expect(surfaced.questions[0]?.question).toBe(latency.question);
    expect(surfaced.patch).toBeNull();
    expect(surfaced.durableChange).toBe(false);
    expect(surfaced.autoSent).toBe(false);
  });

  it("disappears when there is no consequential question", () => {
    const surfaced = surfaceOneClarification([
      { question: "   ", choices: latency.choices },
      { question: "only one choice", choices: [latency.choices[0]] },
    ]);
    expect(surfaced.questions).toEqual([]);
    expect(surfaced.autoSent).toBe(false);
    expect(surfaced.durableChange).toBe(false);
  });

  it("keeps an allowlisted accepted patch and still does not auto-send", () => {
    const surfaced = surfaceOneClarification([latency]);
    const resolved = resolveClarification(surfaced, "accept", "p99");
    expect(resolved.patch).toEqual({ path: "constraints.latency", choiceId: "p99" });
    expect(resolved.durableChange).toBe(true);
    expect(resolved.questions).toEqual([]);
    expect(resolved.autoSent).toBe(false);
  });

  it("drops a non-allowlisted patch and does not auto-send", () => {
    const surfaced = surfaceOneClarification([{
      question: "Grant merge?",
      choices: [
        { id: "yes", patchPath: "authority.approve" },
        { id: "no", patchPath: "authority.deny" },
      ],
    }]);
    const resolved = resolveClarification(surfaced, "accept", "yes");
    expect(resolved.patch).toBeNull();
    expect(resolved.durableChange).toBe(false);
    expect(resolved.autoSent).toBe(false);
  });

  it("dismissed changes nothing and does not auto-send", () => {
    const before = surfaceOneClarification([latency]);
    const resolved = resolveClarification(before, "dismiss", "p99");
    expect(resolved.patch).toBeNull();
    expect(resolved.durableChange).toBe(false);
    expect(resolved.questions).toEqual([]);
    expect(resolved.autoSent).toBe(false);
    expect(before.patch).toBeNull();
    expect(before.durableChange).toBe(false);
  });
});
