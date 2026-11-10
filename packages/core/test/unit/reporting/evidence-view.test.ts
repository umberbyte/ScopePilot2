import assert from "node:assert/strict";
import { test } from "node:test";
import { projectEvidence } from "../../../src/domain/evidence-view.ts";
import { FindingImporter } from "../../../src/domain/finding-importer.ts";
import type { Finding } from "@scopepilot2/contracts";
const finding = (id: string): Finding => ({
  findingId: id,
  title: "Candidate",
  url: "https://test.invalid/",
  source: { kind: "observation", unverified: true },
  severity: "medium",
  status: "candidate",
  evidenceRefs: [id],
  firstSeenAt: "t",
  lastSeenAt: "t",
  occurrences: 1,
});
test("unknown / malformed evidence never exposes raw text, metadata or labels", () => {
  for (const raw of [
    "secret raw",
    '{"request":"secret","response":"secret"}',
    null,
  ]) {
    const view = projectEvidence(
      {
        evidenceId: "e",
        label: "secret",
        sha256: "hash",
        savedAt: "t",
        metadata: { path: "secret" },
      },
      [],
      raw,
    );
    assert.doesNotMatch(JSON.stringify(view), /secret|metadata|path/);
    assert.equal(view.display.request, null);
    assert.equal(view.display.response, null);
  }
});
test("manual merge keeps originals and review boundaries; rejects cycles and repeated merge", () => {
  const importer = new FindingImporter([
    finding("a"),
    { ...finding("b"), enginePluginId: "b" },
    { ...finding("c"), enginePluginId: "c" },
  ]);
  const updated = importer.merge("a", "b", "duplicate", "operator", "now");
  assert.equal(updated[0]?.merge?.reason, "duplicate");
  assert.equal(updated[1]?.status, "candidate");
  assert.equal(updated[1]?.humanReview, undefined);
  assert.deepEqual(updated[0]?.evidenceRefs, ["a"]);
  assert.deepEqual(updated[1]?.evidenceRefs, ["b", "a"]);
  assert.throws(() => importer.merge("b", "a", "cycle", "op", "now"));
  assert.throws(() => importer.merge("a", "c", "again", "op", "now"));
  assert.throws(() => importer.merge("b", "c", "chain", "op", "now"));
  assert.throws(() => importer.merge("c", "b", " ", "op", "now"));
});
