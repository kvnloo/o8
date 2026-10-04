import { resumeAuthoredRevision } from "../../../src/lib/lab/z0int/resume-revision.ts";

const worker = resumeAuthoredRevision({
  currentRevision: 4,
  actor: "worker",
  explicitRevise: true,
  requestedRevision: 9,
});
const operator = resumeAuthoredRevision({
  currentRevision: 4,
  actor: "operator",
  explicitRevise: true,
  requestedRevision: 5,
});
const same = resumeAuthoredRevision({
  currentRevision: 4,
  actor: "compaction",
  explicitRevise: false,
  requestedRevision: 4,
});
if (worker.revision !== 4 || worker.changed || worker.reason !== "rejected-rewrite") {
  throw new Error("worker rewrite was accepted");
}
if (operator.revision !== 5 || !operator.changed || operator.reason !== "operator-revised") {
  throw new Error("operator revise did not move");
}
if (same.revision !== 4 || same.reason !== "preserved") throw new Error("same revision was not preserved");
console.log("PASS");
