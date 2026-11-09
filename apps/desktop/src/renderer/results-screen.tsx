import React, { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Field,
  Input,
  MessageBar,
  Select,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type {
  EvidenceView,
  Finding,
  ReportArtifact,
} from "@scopepilot2/contracts";
import { resultText } from "./results-resources.ts";
import { INITIAL_RENDERER_REPORT_PROFILE } from "./report-profile.ts";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 },
  row: { display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "end" },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "16px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "6px",
  },
  pre: {
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxHeight: "480px",
    overflowY: "auto",
    margin: 0,
  },
});
async function api<T>(base: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `${base}${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    const error = (await response.json()) as { message?: string };
    throw new Error(error.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function EvidenceScreen({
  apiBase,
  evidenceId,
  onFinding,
}: {
  apiBase: string;
  evidenceId?: string;
  onFinding: (id: string) => void;
}): React.ReactElement {
  const styles = useStyles();
  const [items, setItems] = useState<readonly EvidenceView[]>([]);
  const [selected, setSelected] = useState(evidenceId ?? "");
  const [detail, setDetail] = useState<EvidenceView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    setLoading(true);
    void api<{ evidence: readonly EvidenceView[] }>(apiBase, "/api/evidence")
      .then((r) => {
        if (live) {
          setItems(r.evidence);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [apiBase]);
  useEffect(() => {
    let live = true;
    setDetail(null);
    if (selected !== "")
      void api<{ evidence: readonly EvidenceView[] }>(
        apiBase,
        `/api/evidence?evidenceId=${encodeURIComponent(selected)}`,
      )
        .then((r) => {
          if (live) {
            setDetail(r.evidence[0] ?? null);
            setError("");
          }
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
    return () => {
      live = false;
    };
  }, [apiBase, selected]);
  return (
    <section
      className={styles.root}
      aria-label={resultText("Evidence browser")}
    >
      <Text>
        {resultText(
          "Originals stay in local storage. The API exposes hashes and display derivatives only. Bodies and header values are omitted; shared artifacts are not generated here.",
        )}
      </Text>
      {error && <MessageBar intent="error">{error}</MessageBar>}
      <Field label={resultText("Search evidence")}>
        <Input value={query} onChange={(_, d) => setQuery(d.value)} />
      </Field>
      {loading ? (
        <Text>{resultText("Loading")}</Text>
      ) : items.length === 0 ? (
        <Text>{resultText("No evidence")}</Text>
      ) : (
        items
          .filter((i) =>
            `${i.evidenceId} ${i.sha256} ${i.source}`.includes(query),
          )
          .map((i) => (
            <Button
              key={i.evidenceId}
              onClick={() => setSelected(i.evidenceId)}
            >
              {i.evidenceId} / {i.source}
            </Button>
          ))
      )}
      {detail && (
        <article
          className={styles.panel}
          aria-label={resultText("Evidence details")}
        >
          <Text weight="semibold">{detail.evidenceId}</Text>
          <Text>SHA-256: {detail.sha256}</Text>
          <Text>{detail.savedAt}</Text>
          <Text>
            {resultText(
              "Original reference / display derivative / shared copy not generated",
            )}
          </Text>
          <Text>
            {resultText("Source")}: {detail.source}
          </Text>
          <Text>{resultText("Source job / run: linkage not recorded")}</Text>
          {detail.findingIds.map((id) => (
            <Button key={id} onClick={() => onFinding(id)}>
              {resultText("Open finding")}: {id}
            </Button>
          ))}
          <Text weight="semibold">
            {resultText("Observed request (display)")}
          </Text>
          <pre className={styles.pre}>
            {detail.display.request ??
              resultText(
                "No captured HTTP request is available. Reproduction is not inferred.",
              )}
          </pre>
          <Text weight="semibold">
            {resultText("Observed response (display)")}
          </Text>
          <pre className={styles.pre}>
            {detail.display.response ??
              resultText("No captured HTTP response is available")}
          </pre>
          <Text>
            {resultText(
              "Bodies, query values and header values omitted. This view sends no replay requests.",
            )}
          </Text>
        </article>
      )}
    </section>
  );
}

type ReviewDraft = {
  notes: string;
  rationale: string;
  reproduction: "reproduced" | "not-reproduced";
  cvssVersion: string;
  cvssVector: string;
  cvssScore: string;
};
function reviewDraft(f: Finding): ReviewDraft {
  return {
    notes: f.humanReview?.notes ?? "",
    rationale: f.humanReview?.severityRationale ?? "",
    reproduction: f.humanReview?.reproduction ?? "not-reproduced",
    cvssVersion: f.humanReview?.cvss?.version ?? "",
    cvssVector: f.humanReview?.cvss?.vector ?? "",
    cvssScore:
      f.humanReview?.cvss === undefined ? "" : String(f.humanReview.cvss.score),
  };
}
export function FindingsScreen({
  apiBase,
  findingId,
  onEvidence,
}: {
  apiBase: string;
  findingId?: string;
  onEvidence: (id: string) => void;
}): React.ReactElement {
  const styles = useStyles();
  const [items, setItems] = useState<readonly Finding[]>([]);
  const [selected, setSelected] = useState(findingId ?? "");
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [group, setGroup] = useState("severity");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState("");
  const [mergeInto, setMergeInto] = useState("");
  const [mergeReason, setMergeReason] = useState("");
  async function load(): Promise<void> {
    const r = await api<{ findings: readonly Finding[] }>(
      apiBase,
      "/api/findings",
    );
    setItems(r.findings);
  }
  useEffect(() => {
    void load()
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [apiBase]);
  const finding = items.find((i) => i.findingId === selected);
  const draft =
    finding === undefined ? null : (drafts[selected] ?? reviewDraft(finding));
  function update(patch: Partial<ReviewDraft>): void {
    if (draft) setDrafts((s) => ({ ...s, [selected]: { ...draft, ...patch } }));
    setSaved("");
  }
  async function save(next: "confirmed" | "rejected"): Promise<void> {
    if (!draft || !finding) return;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      await api(apiBase, "/api/findings/status", {
        findingId: selected,
        status: next,
        reproduction: draft.reproduction,
        notes: draft.notes,
        severityRationale: draft.rationale,
        cvssVersion: draft.cvssVersion,
        cvssVector: draft.cvssVector,
        ...(draft.cvssScore === ""
          ? {}
          : { cvssScore: Number(draft.cvssScore) }),
      });
      await load();
      setSaved(resultText("Verification record saved"));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const visible = items.filter(
    (f) =>
      (status === "all" || f.status === status) &&
      (severity === "all" || f.severity === severity) &&
      `${f.title} ${f.url} ${f.enginePluginId ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const groups = [
    ...new Set(
      visible.map((f) =>
        group === "source"
          ? f.source.kind
          : group === "status"
            ? f.status
            : f.severity,
      ),
    ),
  ];
  const validCvss =
    draft === null ||
    (draft.cvssVersion === "" &&
      draft.cvssVector === "" &&
      draft.cvssScore === "") ||
    (["3.1", "4.0"].includes(draft.cvssVersion) &&
      draft.cvssVector.trim() !== "" &&
      draft.cvssScore.trim() !== "" &&
      Number.isFinite(Number(draft.cvssScore)) &&
      Number(draft.cvssScore) >= 0 &&
      Number(draft.cvssScore) <= 10);
  return (
    <section className={styles.root} aria-label="Findings">
      <Text>
        {resultText(
          "Alerts are unverified engine candidates imported into the Findings ledger with repeated observations deduplicated. Human confirmation or rejection requires evidence review and a verification record, separate from the engine judgment.",
        )}
      </Text>
      {error && <MessageBar intent="error">{error}</MessageBar>}
      {saved && <MessageBar intent="success">{saved}</MessageBar>}
      <div className={styles.row}>
        <Field label={resultText("Search findings")}>
          <Input value={query} onChange={(_, d) => setQuery(d.value)} />
        </Field>
        <Field label={resultText("Status")}>
          <Select value={status} onChange={(_, d) => setStatus(d.value)}>
            {["all", "candidate", "confirmed", "rejected", "merged"].map(
              (s) => (
                <option key={s}>{s}</option>
              ),
            )}
          </Select>
        </Field>
        <Field label={resultText("Severity")}>
          <Select value={severity} onChange={(_, d) => setSeverity(d.value)}>
            {["all", "high", "medium", "low", "info", "unknown"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Field label={resultText("Group by")}>
          <Select value={group} onChange={(_, d) => setGroup(d.value)}>
            {["severity", "status", "source"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
        <Button
          disabled={busy}
          onClick={() => {
            setError("");
            void load().catch((e) => setError(String(e)));
          }}
        >
          {resultText("Refresh")}
        </Button>
      </div>
      <Text>
        {resultText("Visible findings")}: {visible.length} / {items.length}
      </Text>
      {loading && <Text>{resultText("Loading")}</Text>}
      {!loading && visible.length === 0 && (
        <Text>{resultText("No matching findings")}</Text>
      )}
      {groups.map((g) => (
        <div key={g} className={styles.panel}>
          <Text weight="semibold">{g}</Text>
          {visible
            .filter(
              (f) =>
                (group === "source"
                  ? f.source.kind
                  : group === "status"
                    ? f.status
                    : f.severity) === g,
            )
            .map((f) => (
              <Button
                key={f.findingId}
                disabled={busy}
                onClick={() => {
                  setSelected(f.findingId);
                  setMergeInto("");
                  setMergeReason("");
                  setSaved("");
                  setError("");
                }}
              >
                {f.title} — {f.url} ({f.status}, ×{f.occurrences})
              </Button>
            ))}
        </div>
      ))}
      {finding && draft && (
        <article
          className={styles.panel}
          aria-label={resultText("Finding details")}
        >
          <Text as="h2" weight="semibold">
            {finding.title}
          </Text>
          <Text>
            {finding.findingId} / {finding.severity} / {finding.status}
          </Text>
          <Text>
            {finding.method ?? resultText("Method not recorded")} {finding.url}
          </Text>
          <Text>
            {resultText("Parameter")}: {finding.param ?? "—"}
          </Text>
          <Text>
            {finding.source.kind} / {finding.source.engineVersion ?? "—"} /{" "}
            {finding.enginePluginId ?? "—"}
          </Text>
          <Text>
            {resultText("Engine impact verification")}:{" "}
            {finding.source.unverified
              ? resultText("Unverified")
              : resultText("Verified")}
          </Text>
          <Text>
            {finding.firstSeenAt} → {finding.lastSeenAt} (×{finding.occurrences}
            )
          </Text>
          {finding.evidenceRefs.length === 0 ? (
            <Text>{resultText("No evidence: confirmation unavailable")}</Text>
          ) : (
            finding.evidenceRefs.map((id) => (
              <Button key={id} disabled={busy} onClick={() => onEvidence(id)}>
                {resultText("Open evidence")}: {id}
              </Button>
            ))
          )}
          {finding.humanReview && (
            <div className={styles.panel}>
              <Text weight="semibold">
                {resultText("Saved verification record")}
              </Text>
              <Text>
                {finding.humanReview.reviewedBy} /{" "}
                {finding.humanReview.reviewedAt} / {finding.humanReview.result}{" "}
                / {finding.humanReview.reproduction}
              </Text>
              <pre className={styles.pre}>{finding.humanReview.notes}</pre>
              <Text>{finding.humanReview.severityRationale}</Text>
              {finding.humanReview.cvss && (
                <Text>
                  CVSS {finding.humanReview.cvss.version}:{" "}
                  {finding.humanReview.cvss.vector} (
                  {finding.humanReview.cvss.score})
                </Text>
              )}
            </div>
          )}
          {finding.merge && (
            <Text>
              {resultText("Merged into")}: {finding.merge.intoFindingId} /{" "}
              {finding.merge.reason} / {finding.merge.mergedBy} /{" "}
              {finding.merge.mergedAt}
            </Text>
          )}
          {finding.status !== "merged" && (
            <div className={styles.panel}>
              <Text>
                {resultText(
                  "Duplicates are never merged automatically. Merging preserves evidence and reviews without confirming the destination.",
                )}
              </Text>
              <Field label={resultText("Merge destination")}>
                <Select
                  disabled={busy}
                  value={mergeInto}
                  onChange={(_, d) => setMergeInto(d.value)}
                >
                  <option value="">—</option>
                  {items
                    .filter(
                      (f) => f.findingId !== selected && f.status !== "merged",
                    )
                    .map((f) => (
                      <option key={f.findingId} value={f.findingId}>
                        {f.findingId}: {f.title} ({f.url})
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label={resultText("Merge reason")}>
                <Input
                  disabled={busy}
                  value={mergeReason}
                  onChange={(_, d) => setMergeReason(d.value)}
                />
              </Field>
              <Button
                disabled={
                  busy ||
                  mergeInto === "" ||
                  mergeInto === selected ||
                  mergeReason.trim() === ""
                }
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await api(apiBase, "/api/findings/merge", {
                        findingId: selected,
                        intoFindingId: mergeInto,
                        reason: mergeReason,
                      });
                      await load();
                      setMergeInto("");
                      setMergeReason("");
                      setSaved(resultText("Merge recorded"));
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                {resultText("Merge with recorded reason")}
              </Button>
            </div>
          )}
          <Field label={resultText("Reproduction result")}>
            <Select
              disabled={busy}
              value={draft.reproduction}
              onChange={(_, d) =>
                update({ reproduction: d.value as ReviewDraft["reproduction"] })
              }
            >
              <option value="not-reproduced">
                {resultText("Not reproduced")}
              </option>
              <option value="reproduced">{resultText("Reproduced")}</option>
            </Select>
          </Field>
          <Field
            label={resultText("Verification notes (this finding only)")}
            required
          >
            <Textarea
              disabled={busy}
              value={draft.notes}
              onChange={(_, d) => update({ notes: d.value })}
            />
          </Field>
          <Field label={resultText("Severity rationale")} required>
            <Textarea
              disabled={busy}
              value={draft.rationale}
              onChange={(_, d) => update({ rationale: d.value })}
            />
          </Field>
          <div className={styles.row}>
            <Field label="CVSS version">
              <Select
                disabled={busy}
                value={draft.cvssVersion}
                onChange={(_, d) => update({ cvssVersion: d.value })}
              >
                <option value="">—</option>
                <option>3.1</option>
                <option>4.0</option>
              </Select>
            </Field>
            <Field label="CVSS vector">
              <Input
                disabled={busy}
                value={draft.cvssVector}
                onChange={(_, d) => update({ cvssVector: d.value })}
              />
            </Field>
            <Field label="CVSS score (0–10)">
              <Input
                disabled={busy}
                type="number"
                min={0}
                max={10}
                step={0.1}
                value={draft.cvssScore}
                onChange={(_, d) => update({ cvssScore: d.value })}
              />
            </Field>
          </div>
          {!validCvss && (
            <Text>
              {resultText(
                "Supply CVSS version, vector and score (0–10) together",
              )}
            </Text>
          )}
          <div className={styles.row}>
            <Button
              disabled={
                busy ||
                finding.status === "merged" ||
                finding.status === "confirmed" ||
                draft.notes.trim() === "" ||
                draft.rationale.trim() === "" ||
                !validCvss ||
                draft.reproduction !== "reproduced" ||
                finding.evidenceRefs.length === 0
              }
              onClick={() => void save("confirmed")}
            >
              {resultText("Confirm and save review")}
            </Button>
            <Button
              disabled={
                busy ||
                finding.status === "merged" ||
                finding.status === "rejected" ||
                draft.notes.trim() === "" ||
                draft.rationale.trim() === "" ||
                !validCvss ||
                draft.reproduction !== "not-reproduced"
              }
              onClick={() => void save("rejected")}
            >
              {resultText("Reject and save review")}
            </Button>
          </div>
        </article>
      )}
    </section>
  );
}

const GUIDELINES = [
  "OWASP Top 10-2025",
  "OWASP ASVS 5.0",
  "OWASP WSTG 4.2",
  "OWASP AISVS 1.01",
  "OWASP CNAS Top 10",
  "デジタル庁 DS-221",
  "IPA/NISC/WebAppPentestGuidelines",
];
const PROFILE_LABELS = {
  systemName: "System name",
  clientName: "Client name",
  author: "Author",
  reviewer: "Reviewer",
} as const;
const FILE_LABELS: Readonly<
  Record<string, import("./results-resources.ts").ResultTextKey>
> = {
  markdownPath: "Markdown",
  wordPath: "DOCX",
  technicalAnnexHtmlPath: "Technical annex",
  structuredJsonPath: "Structured JSON",
  manifestPath: "Artifact manifest",
};
export function ReportScreen({
  apiBase,
}: {
  apiBase: string;
}): React.ReactElement {
  const styles = useStyles();
  const [guidelines, setGuidelines] = useState<readonly string[]>([]);
  const [exclude, setExclude] = useState(false);
  const [report, setReport] = useState<ReportArtifact | null>(null);
  const [draft, setDraft] = useState("");
  const [aiSource, setAiSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [profile, setProfile] = useState(INITIAL_RENDERER_REPORT_PROFILE);
  function invalidate(): void {
    setReport(null);
    setDraft("");
    setAiSource("");
    setFiles(null);
    setError("");
  }
  async function action(run: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.root} aria-label={resultText("Report")}>
      <Text>
        {resultText(
          "Export an assurance report and technical annex from the canonical API report model, including scope, evidence, coverage and limitations. Candidates remain candidates; coverage does not prove safety.",
        )}
      </Text>
      {error && <MessageBar intent="error">{error}</MessageBar>}
      <fieldset disabled={busy}>
        <legend>{resultText("Guidelines")}</legend>
        {GUIDELINES.map((g) => (
          <Checkbox
            key={g}
            label={g}
            checked={guidelines.includes(g)}
            onChange={(_, d) => {
              setGuidelines((s) =>
                d.checked ? [...s, g] : s.filter((v) => v !== g),
              );
              invalidate();
            }}
          />
        ))}
      </fieldset>
      <Checkbox
        disabled={busy}
        label={resultText("Exclude low / info")}
        checked={exclude}
        onChange={(_, d) => {
          setExclude(d.checked === true);
          invalidate();
        }}
      />
      <div className={styles.row}>
        {(["systemName", "clientName", "author", "reviewer"] as const).map(
          (key) => (
            <Field key={key} label={resultText(PROFILE_LABELS[key])}>
              <Input
                disabled={busy}
                value={profile[key]}
                onChange={(_, d) => {
                  setProfile((p) => ({ ...p, [key]: d.value }));
                  setFiles(null);
                }}
              />
            </Field>
          ),
        )}
      </div>
      <Button
        disabled={busy || guidelines.length === 0}
        onClick={() =>
          void action(async () => {
            invalidate();
            setReport(
              await api<ReportArtifact>(apiBase, "/api/report", {
                guidelines,
                excludeLowAndInfo: exclude,
              }),
            );
          })
        }
      >
        {resultText("Generate canonical preview")}
      </Button>
      {report && (
        <>
          <Text>Model hash: {report.modelHash}</Text>
          <Text>
            {resultText("Snapshot generated")}: {report.model.generatedAt}
          </Text>
          <article
            className={styles.panel}
            aria-label={resultText("Canonical report")}
          >
            <Text weight="semibold">
              {resultText("Canonical report (without AI text)")}
            </Text>
            <pre className={styles.pre}>{report.content}</pre>
          </article>
          <Button
            disabled={busy || !window.scopepilotDesktop}
            onClick={() =>
              void action(async () => {
                const bridge = window.scopepilotDesktop;
                if (!bridge) throw new Error("Desktop bridge unavailable");
                setFiles(
                  await bridge.saveReport({
                    content: report.content,
                    modelHash: report.modelHash,
                    reportId: report.reportId,
                    model: report.model,
                    profile,
                  }),
                );
              })
            }
          >
            {resultText("Save DOCX / Markdown assurance report")}
          </Button>
          {files && (
            <div className={styles.panel}>
              {Object.entries(files).map(([kind, path]) => (
                <Button
                  key={kind}
                  onClick={() =>
                    void action(async () => {
                      await window.scopepilotDesktop?.openSelectedPath(path);
                    })
                  }
                >
                  {resultText(FILE_LABELS[kind] ?? "Report file")}: {path}
                </Button>
              ))}
            </div>
          )}
          <Button
            disabled={busy || !window.scopepilotDesktop}
            onClick={() =>
              void action(async () => {
                const bridge = window.scopepilotDesktop;
                if (!bridge) throw new Error("Desktop bridge unavailable");
                setDraft("");
                const r = await bridge.generateAiReport({
                  baseContent: report.content,
                  baseModelHash: report.modelHash,
                  guidelines: report.model.guidelines,
                  findings: report.model.findings.map((f) => ({
                    findingId: f.findingId,
                    title: f.title,
                    url: f.url,
                    method: f.method ?? "",
                    parameter: f.param ?? "",
                  })),
                });
                setDraft(r.content);
                setAiSource(`${r.provider} / ${r.model} / ${r.invocationId}`);
              })
            }
          >
            {resultText("Generate separate AI draft")}
          </Button>
          {draft && (
            <aside className={styles.panel} aria-label={resultText("AI draft")}>
              <Text weight="semibold">
                {resultText(
                  "AI draft — unverified (excluded from canonical exports)",
                )}
              </Text>
              <Text>{aiSource}</Text>
              <pre className={styles.pre}>{draft}</pre>
            </aside>
          )}
        </>
      )}
    </section>
  );
}
