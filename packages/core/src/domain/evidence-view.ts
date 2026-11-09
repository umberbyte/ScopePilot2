import type { EvidenceView, Finding } from "@scopepilot2/contracts";
import type { StoredEvidence } from "../ports/infra.ts";

/** Deliberately conservative display derivative: no body, arbitrary metadata or header values. */
export function projectEvidence(
  record: StoredEvidence,
  findings: readonly Finding[],
  raw: string | null,
): EvidenceView {
  const linked = findings.filter((f) =>
    f.evidenceRefs.includes(record.evidenceId),
  );
  let request: string | null = null;
  let response: string | null = null;
  if (raw !== null) {
    try {
      const data = JSON.parse(raw) as {
        alerts?: readonly Record<string, unknown>[];
        engineRunId?: unknown;
      };
      const alert = Array.isArray(data.alerts)
        ? data.alerts.find((a) =>
            linked.some(
              (f) => f.url === a.url && f.enginePluginId === a.pluginId,
            ),
          )
        : undefined;
      if (alert !== undefined) {
        // Only an observed request line and response status; never invent a replayable exchange.
        const header =
          typeof alert.requestHeader === "string" ? alert.requestHeader : "";
        const line = header.split(/\r?\n/)[0] ?? "";
        if (/^[A-Z]+ \S+ HTTP\/[0-9.]+$/.test(line)) {
          const [method, target, version] = line.split(" ");
          const url = new URL(target!, String(alert.url));
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          request = `${method} ${url.origin}${url.pathname}${target!.includes("?") ? "?[omitted]" : ""} ${version}`;
        }
        const status =
          typeof alert.responseHeader === "string"
            ? alert.responseHeader.match(/^HTTP\/[0-9.]+ [0-9]{3}/)?.[0]
            : undefined;
        response = status ?? null;
      }
    } catch {
      /* Unsupported evidence formats remain metadata-only. */
    }
  }
  const prefix = record.label.split(":")[0] ?? "";
  const knownSource = [
    "zap-alerts-raw",
    "nuclei-jsonl-raw",
    "workflow-http-raw",
    "dom-flows",
  ].includes(prefix);
  return {
    evidenceId: record.evidenceId,
    sha256: record.sha256,
    savedAt: record.savedAt,
    kind: "original",
    findingIds: linked.map((f) => f.findingId),
    source: knownSource ? prefix : "evidence",
    // The existing ledger has no reliable job linkage. Never relabel an engine run as a ScopePilot job.
    sourceRunId: null,
    sourceJobId: null,
    display: { kind: "display", request, response, bodies: "omitted" },
    sharing: "not-generated",
  };
}
