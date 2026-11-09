import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { Finding } from "@scopepilot2/contracts";

test("P6: finding → evidence → captured request; per-finding review and canonical/AI export isolation", async () => {
  const app = await electron.launch({
    args: ["test/fixtures/results-main.cjs"],
    env: { ...process.env, SCOPEPILOT_DISABLE_NUCLEI: "1" },
  });
  try {
    const page = await app.firstWindow();
    const findings: Finding[] = ["f1", "f2"].map((id) => ({
      findingId: id,
      title: `Fixture alert ${id}`,
      url: "https://fixture.test/path",
      method: "POST",
      source: { kind: "zap-alert", unverified: true },
      severity: "high",
      status: "candidate",
      evidenceRefs: ["e1"],
      firstSeenAt: "2026-11-10T00:00:00Z",
      lastSeenAt: "2026-11-10T00:00:00Z",
      occurrences: 1,
    }));
    const report = {
      reportId: "report-1",
      format: "markdown",
      modelHash: "canonical-hash",
      content: "# Canonical report",
      model: {
        caseId: "case-1",
        generatedAt: "2026-11-10T00:00:00Z",
        guidelines: ["OWASP ASVS 5.0"],
        findings,
        assessmentScope: {
          caseName: "Test case",
          allowedOrigins: ["https://fixture.test"],
          deniedOrigins: [],
          limits: { maxRequests: 10, maxPages: 10, maxDurationMinutes: 1 },
        },
        coverage: {
          exploredUrlCount: 1,
          scannedUrlCount: 1,
          delegatedSteps: [],
          limitations: ["Coverage does not prove safety"],
        },
      },
    };
    let reportRequest: unknown;
    // All target results are fixture data. No target requests or AI invocations.
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/findings")
        return route.fulfill({ json: { findings } });
      if (path === "/api/evidence")
        return route.fulfill({
          json: {
            evidence: [
              {
                evidenceId: "e1",
                sha256: "a".repeat(64),
                savedAt: "2026-11-10T00:00:00Z",
                kind: "original",
                findingIds: ["f1"],
                source: "zap-alerts-raw",
                sourceRunId: null,
                sourceJobId: null,
                display: {
                  kind: "display",
                  request: "POST https://fixture.test/path HTTP/1.1",
                  response: "HTTP/1.1 200",
                  bodies: "omitted",
                },
                sharing: "not-generated",
              },
            ],
          },
        });
      if (path === "/api/findings/status") {
        const body = route.request().postDataJSON() as {
          findingId: string;
          status: "confirmed";
          reproduction: "reproduced";
          notes: string;
          severityRationale: string;
        };
        const i = findings.findIndex((f) => f.findingId === body.findingId);
        findings[i] = {
          ...findings[i]!,
          status: body.status,
          humanReview: {
            result: "confirmed",
            reproduction: body.reproduction,
            notes: body.notes,
            severityRationale: body.severityRationale,
            reviewedBy: "reviewer",
            reviewedAt: "2026-11-10T00:00:00Z",
          },
        };
        return route.fulfill({ json: { finding: findings[i] } });
      }
      if (path === "/api/report") {
        reportRequest = route.request().postDataJSON();
        return route.fulfill({ json: report });
      }
      return route.continue();
    });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("scopepilot:save-report");
      ipcMain.handle("scopepilot:save-report", (_event, payload: unknown) => {
        (globalThis as { savedReport?: unknown }).savedReport = payload;
        return {
          markdownPath: "fixture.md",
          wordPath: "fixture.docx",
          technicalAnnexHtmlPath: "annex.html",
          structuredJsonPath: "report.json",
          manifestPath: "manifest.json",
        };
      });
      ipcMain.removeHandler("scopepilot:generate-ai-report");
      ipcMain.handle("scopepilot:generate-ai-report", () => ({
        content: "AI DRAFT ONLY",
        provider: "codex",
        model: "fixture",
        invocationId: "fixture-ai-1",
        modelHash: "canonical-hash",
        findingNarratives: [],
      }));
    });
    await page
      .getByRole("button", { name: "アドバンスド", exact: true })
      .click();
    await page
      .getByRole("button", { name: "A60 Findings", exact: true })
      .click();
    await page.getByRole("button", { name: /Fixture alert f1/ }).click();
    await page.getByLabel("検証メモ（この所見のみ）").fill("Only f1 notes");
    await page.getByRole("button", { name: /Fixture alert f2/ }).click();
    await expect(page.getByLabel("検証メモ（この所見のみ）")).toHaveValue("");
    await page.getByRole("button", { name: /Fixture alert f1/ }).click();
    await expect(page.getByLabel("検証メモ（この所見のみ）")).toHaveValue(
      "Only f1 notes",
    );
    await page.getByLabel("重要度の根拠").fill("Verified impact");
    await page.getByLabel("再現結果").selectOption("reproduced");
    await page
      .getByRole("button", { name: "確定して検証記録を保存", exact: true })
      .click();
    await expect(
      page.getByText("検証記録を保存しました", { exact: true }),
    ).toBeVisible();
    expect(findings[1]?.humanReview).toBeUndefined();
    await page
      .getByRole("button", { name: "証拠を開く: e1", exact: true })
      .click();
    await expect(
      page.getByText("POST https://fixture.test/path HTTP/1.1", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("HTTP/1.1 200", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "所見を開く: f1", exact: true })
      .click();
    await expect(page.getByRole("article", { name: "所見詳細" })).toBeVisible();
    await expect(
      page.getByText("保存済み検証記録", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "A62 Report", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: "正規モデルからプレビュー生成",
        exact: true,
      }),
    ).toBeDisabled();
    await page.getByLabel("OWASP ASVS 5.0", { exact: true }).check();
    await page
      .getByRole("button", {
        name: "正規モデルからプレビュー生成",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("article", { name: "正規レポート", exact: true }),
    ).toContainText(report.content);
    expect(reportRequest).toEqual({
      guidelines: ["OWASP ASVS 5.0"],
      excludeLowAndInfo: false,
    });
    await page
      .getByRole("button", { name: "AI 文章案を別枠で生成", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "AI 文章案", exact: true }),
    ).toContainText("AI DRAFT ONLY");
    await expect(
      page.getByRole("article", { name: "正規レポート", exact: true }),
    ).not.toContainText("AI DRAFT ONLY");
    await page
      .getByRole("button", {
        name: "DOCX / Markdown・保証レポートを保存",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "DOCX: fixture.docx", exact: true }),
    ).toBeVisible();
    const saved = await app.evaluate(
      () =>
        (
          globalThis as {
            savedReport?: {
              content: string;
              modelHash: string;
              findingNarratives?: unknown;
            };
          }
        ).savedReport,
    );
    expect(saved?.content).toBe(report.content);
    expect(saved?.modelHash).toBe(report.modelHash);
    expect(saved?.findingNarratives).toBeUndefined();
    await page.getByLabel("OWASP WSTG 4.2", { exact: true }).check();
    await expect(
      page.getByRole("article", { name: "正規レポート", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("complementary", { name: "AI 文章案", exact: true }),
    ).toHaveCount(0);
  } finally {
    await app.close();
  }
});
