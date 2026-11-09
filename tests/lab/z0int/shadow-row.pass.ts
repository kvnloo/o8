import { classifyShadowRow, retainShadowRows } from "../../../src/lib/lab/z0int/shadow-row.ts";

const legal = ["worker-a", "worker-b"];
const agreed = classifyShadowRow({
  controlAction: "worker-a",
  prediction: "worker-a",
  confidence: 1,
  rejectedReason: "none",
  legalActions: legal,
});
if (agreed.kind !== "agreement" || agreed.agreementIsGold !== false || agreed.promoted !== false || agreed.acted !== false) {
  throw new Error("agreement was treated as gold");
}
const rows = retainShadowRows([
  { controlAction: "worker-a", prediction: "worker-b", confidence: 0.1, rejectedReason: "none", legalActions: legal },
  { controlAction: "worker-a", prediction: null, confidence: null, rejectedReason: "none", legalActions: legal },
  { controlAction: "worker-a", prediction: "worker-z", confidence: 1, rejectedReason: "none", legalActions: legal },
]);
if (rows.length !== 3) throw new Error("a row was dropped");
if (rows[0].kind !== "disagreement" || rows[1].kind !== "inconclusive" || rows[2].kind !== "rejected") {
  throw new Error("kinds " + rows.map((row) => row.kind).join(","));
}
if (rows[2].legalActions.includes("worker-z")) throw new Error("confidence expanded the legal set");
console.log("PASS");
