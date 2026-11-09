import {
  resolveClarification,
  surfaceOneClarification,
} from "../../../src/lib/lab/z0int/ripple-clarification";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error("FAIL", message);
    process.exit(1);
  }
}

const latency = {
  question: "Which latency should stay under the budget?",
  choices: [
    { id: "p99", patchPath: "constraints.latency" },
    { id: "paint", patchPath: "verification.paint" },
  ],
};
const scope = {
  question: "Which surface is in scope?",
  choices: [
    { id: "mobile", patchPath: "intent.surface" },
    { id: "desktop", patchPath: "intent.surface" },
  ],
};

const many = surfaceOneClarification([latency, scope, scope]);
assert(many.questions.length === 1, "at most one question");
assert(many.questions[0]?.question === latency.question, "first consequential question");
assert(many.patch === null && many.durableChange === false && many.autoSent === false, "surface writes nothing");

const none = surfaceOneClarification([
  { question: "   ", choices: latency.choices },
  { question: "only one choice", choices: [latency.choices[0]!] },
]);
assert(none.questions.length === 0 && none.autoSent === false, "no question disappears");

const accepted = resolveClarification(surfaceOneClarification([latency]), "accept", "p99");
assert(accepted.patch?.path === "constraints.latency", "allowlisted patch");
assert(accepted.durableChange === true && accepted.autoSent === false, "accept does not auto-send");

const rejected = resolveClarification(surfaceOneClarification([{
  question: "Grant merge?",
  choices: [
    { id: "yes", patchPath: "authority.approve" },
    { id: "no", patchPath: "authority.deny" },
  ],
}]), "accept", "yes");
assert(rejected.patch === null && rejected.durableChange === false && rejected.autoSent === false, "non-allowlisted patch dropped");

const before = surfaceOneClarification([latency]);
const dismissed = resolveClarification(before, "dismiss", "p99");
assert(dismissed.patch === null && dismissed.durableChange === false && dismissed.autoSent === false, "dismissed changes nothing");
assert(before.patch === null && before.durableChange === false, "dismiss does not mutate the prior state");

console.log("PASS");
