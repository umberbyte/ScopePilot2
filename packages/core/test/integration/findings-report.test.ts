import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EvidenceView,
  Finding,
  ReportArtifact,
} from "@scopepilot2/contracts";
import {
  BaselineFlowService,
  FixedClock,
  InMemoryEvidenceStore,
  SequentialIdGenerator,
} from "@scopepilot2/core";
import { createCoreApiServer } from "../../src/application/api-server.ts";
import {
  FakeExplorer,
  FakeScanEngine,
  TEST_OPERATOR,
} from "../unit/support/test-flow.ts";

const now = "2026-11-10T00:00:00.000Z";
const makeFinding = (findingId: string, evidenceId: string): Finding => ({
  findingId,
  title: `Alert ${findingId}`,
  source: { kind: "zap-alert", unverified: true, engineVersion: "fixture-1" },
  url: "https://fixture.test/path?token=secret-query",
  method: "POST",
  severity: "high",
  status: "candidate",
  evidenceRefs: [evidenceId],
  firstSeenAt: now,
  lastSeenAt: now,
  occurrences: 1,
  enginePluginId: "1",
});

test("P6 API: original isolation, review, merge and canonical report", async () => {
  const evidence = new InMemoryEvidenceStore();
  const raw = JSON.stringify({
    engineRunId: "engine-1",
    alerts: [
      {
        pluginId: "1",
        url: "https://fixture.test/path?token=secret-query",
        requestHeader:
          "POST /path?token=secret-query HTTP/1.1\r\nAuthorization: secret-header",
        requestBody: "secret-request-body",
        responseHeader:
          "HTTP/1.1 200 secret-reason\r\nSet-Cookie: secret-cookie",
        responseBody: "secret-response-body",
      },
    ],
  });
  const stored = await evidence.saveText("zap-alerts-raw:engine-1", raw, {
    blob: "C:/private/path",
    password: "secret-metadata",
  });
  const other = await evidence.saveText(
    "private-user-label-secret",
    "secret-original",
  );
  const initial = [
    makeFinding("f1", stored.evidenceId),
    { ...makeFinding("f2", other.evidenceId), enginePluginId: "2" },
  ];
  const service = new BaselineFlowService({
    clock: new FixedClock([now]),
    ids: new SequentialIdGenerator(),
    evidence,
    explorer: new FakeExplorer(),
    scanEngine: new FakeScanEngine(),
    capabilities: [],
    runtimeBundleHash: "test",
    initialFindings: initial,
  });
  service.createCase(TEST_OPERATOR, {
    name: "Results test",
    allowedOrigins: ["https://fixture.test"],
    deniedOrigins: [],
    limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 1 },
  });
  const server = createCoreApiServer({ service, operator: TEST_OPERATOR });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const query of [
      "",
      `?evidenceId=${stored.evidenceId}`,
      `?evidenceId=${stored.evidenceId}&original=true`,
    ]) {
      const response = await fetch(base + "/api/evidence" + query);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(
        text,
        /secret-|private\/path|private-user|requestBody|responseBody|metadata|blob/,
      );
      const result = JSON.parse(text) as { evidence: readonly EvidenceView[] };
      assert.equal(result.evidence[0]?.sha256, stored.sha256);
      if (query) {
        assert.equal(
          result.evidence[0]?.display.request,
          "POST https://fixture.test/path?[omitted] HTTP/1.1",
        );
        assert.equal(result.evidence[0]?.display.response, "HTTP/1.1 200");
      }
    }
    assert.equal(
      (await fetch(base + "/api/evidence?evidenceId=missing")).status,
      400,
    );
    assert.equal((await fetch(base + "/api/evidence/original")).status, 404);
    const review = {
      findingId: "f1",
      status: "confirmed",
      reproduction: "reproduced",
      notes: "Reproduced with authorized account",
      severityRationale: "Impact confirmed",
      cvssVersion: "",
      cvssVector: "",
    };
    assert.equal(
      (await post("/api/findings/status", { ...review, notes: "" })).status,
      400,
    );
    assert.equal(
      (
        await post("/api/findings/status", {
          ...review,
          reproduction: "not-reproduced",
        })
      ).status,
      400,
    );
    assert.equal((await post("/api/findings/status", review)).status, 200);
    assert.equal(service.listFindings()[1]?.humanReview, undefined);
    assert.equal(
      (
        await post("/api/findings/merge", {
          findingId: "f2",
          intoFindingId: "f2",
          reason: "duplicate",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("/api/findings/merge", {
          findingId: "f2",
          intoFindingId: "f1",
          reason: "Same root cause",
        })
      ).status,
      200,
    );
    assert.equal(service.listFindings()[1]?.status, "merged");
    assert.equal(service.listFindings()[1]?.humanReview, undefined);
    assert.deepEqual(service.listFindings()[0]?.evidenceRefs, [
      stored.evidenceId,
      other.evidenceId,
    ]);
    const response = await post("/api/report", {
      guidelines: ["OWASP ASVS 5.0", "OWASP WSTG 4.2"],
    });
    assert.equal(response.status, 200);
    const report = (await response.json()) as ReportArtifact;
    assert.deepEqual(report.model.guidelines, [
      "OWASP ASVS 5.0",
      "OWASP WSTG 4.2",
    ]);
    assert.match(report.content, /Reproduced with authorized account/);
    assert.match(report.content, /Same root cause/);
    assert.equal(
      report.model.findings.find((f) => f.findingId === "f1")?.humanReview
        ?.reviewedBy,
      TEST_OPERATOR.operatorId,
    );
    assert.ok(
      service
        .events()
        .some((e) => e.type === "FindingStatusChanged" && e.to === "merged"),
    );
    await assert.rejects(
      service.listEvidence({ ...TEST_OPERATOR, permissions: [] }),
      /permission/,
    );
    assert.throws(
      () =>
        service.mergeFindings(
          { ...TEST_OPERATOR, permissions: [] },
          "f1",
          "f2",
          "x",
        ),
      /permission/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
