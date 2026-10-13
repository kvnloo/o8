import { compactHandoffIdentity } from "../../../src/lib/lab/z0int/compaction-identity.ts";

const body = "full private narrative that compaction must not keep";
const kept = compactHandoffIdentity({
  narrativeRef: "narrative:full:1",
  narrativeBody: body,
  intentRevision: "intent:7",
  stateRevision: "state:3",
  hadAuthoredIntent: true,
});
const dropped = compactHandoffIdentity({
  narrativeRef: "narrative:full:1",
  narrativeBody: body,
  intentRevision: "",
  stateRevision: "state:3",
  hadAuthoredIntent: true,
});
const legacy = compactHandoffIdentity({
  narrativeRef: "narrative:legacy",
  narrativeBody: body,
  intentRevision: null,
  stateRevision: null,
  hadAuthoredIntent: false,
});
if (!kept.ok || kept.identity.intentRevision !== "intent:7" || kept.identity.stateRevision !== "state:3") {
  throw new Error("authored identity was not preserved");
}
if (JSON.stringify(kept.identity).includes(body)) throw new Error("narrative body leaked");
if (dropped.ok || dropped.reason !== "dropped-intent") throw new Error("dropped intent was accepted");
if (!legacy.ok || legacy.identity.intentRevision !== null) throw new Error("legacy handoff was not valid");
console.log("PASS");
