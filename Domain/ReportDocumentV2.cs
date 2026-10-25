namespace ScopePilot.Domain;

public sealed class ReportSettings
{
    public string SystemName { get; set; } = "";
    public string ClientName { get; set; } = "";
    public string ServiceProvider { get; set; } = "";
    public string Version { get; set; } = "0.1";
    public string DocumentStatus { get; set; } = "ドラフト";
    public string Classification { get; set; } = "関係者限定";
    public string Author { get; set; } = "";
    public string Reviewer { get; set; } = "";
    public string Approver { get; set; } = "";
    public string Distribution { get; set; } = "";
    public DateTimeOffset? AssessmentStartedAt { get; set; }
    public DateTimeOffset? AssessmentEndedAt { get; set; }
    public string AssessmentType { get; set; } = "Web アプリケーション脆弱性診断";
    public string SourceIps { get; set; } = "";
    public string Exclusions { get; set; } = "";
    public string Assumptions { get; set; } = "";
    public string Conclusion { get; set; } = "";
    public string Priorities { get; set; } = "";
    public string MajorLimitations { get; set; } = "";
    public string Contact { get; set; } = "";
}

public sealed record ReportDocumentV2(
    string FormatVersion,
    string TemplateId,
    ReportMetadataV2 Report,
    EngagementMetadataV2 Engagement,
    AssessmentMetadataV2 Assessment,
    ReportSummaryV2 Summary,
    IReadOnlyList<ReportAssetV2> Assets,
    IReadOnlyList<CoverageItemV2> Coverage,
    IReadOnlyList<ReportFindingV2> Findings,
    IReadOnlyList<ReportEvidenceV2> Evidence,
    IReadOnlyList<ReportResponseV2> Responses,
    IReadOnlyList<string> SpecialNotes);

public sealed record ReportMetadataV2(
    string Id,
    string Version,
    string Status,
    string Classification,
    DateTimeOffset GeneratedAt,
    string Author,
    string Reviewer,
    string Approver,
    IReadOnlyList<string> Distribution,
    IReadOnlyList<ReportRevisionV2> Revisions);

public sealed record ReportRevisionV2(string Version, DateTimeOffset Date, string Description, string Author);

public sealed record EngagementMetadataV2(
    Guid ProjectId,
    string Name,
    string SystemName,
    string ClientName,
    string ServiceProvider);

public sealed record AssessmentMetadataV2(
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    string Type,
    IReadOnlyList<string> Methods,
    IReadOnlyList<string> SourceIps,
    IReadOnlyList<string> AllowedOrigins,
    IReadOnlyList<string> SupportingOrigins,
    IReadOnlyList<string> Roles,
    IReadOnlyList<string> ForbiddenActions,
    IReadOnlyList<string> Exclusions,
    IReadOnlyList<string> Assumptions,
    ReportRequestLimitsV2 RequestLimits,
    IReadOnlyList<ReportToolV2> Tools);

public sealed record ReportRequestLimitsV2(int MaxRequests, int MaxMinutes, int MaxPages);
public sealed record ReportToolV2(string Name, string Version, string Purpose, string Settings);

public sealed record ReportSummaryV2(
    string Conclusion,
    string HighestSeverity,
    IReadOnlyDictionary<string, int> SeverityCounts,
    IReadOnlyDictionary<string, int> ValidationCounts,
    IReadOnlyList<string> Priorities,
    IReadOnlyList<string> MajorLimitations);

public sealed record ReportAssetV2(
    string Id,
    string Name,
    string Fqdn,
    IReadOnlyList<string> IpAddresses,
    IReadOnlyList<string> Urls,
    string Notes);

public sealed record CoverageItemV2(
    string ControlId,
    string Title,
    string Status,
    string Method,
    IReadOnlyList<string> Roles,
    IReadOnlyList<string> Targets,
    IReadOnlyList<string> EvidenceIds,
    string Limitations);

public sealed record ReportFindingV2(
    string Id,
    string Title,
    string Category,
    string Severity,
    string Exploitability,
    string ValidationStatus,
    string Confidence,
    ReportCvssV2 Cvss,
    IReadOnlyList<string> CweIds,
    IReadOnlyList<string> CveIds,
    IReadOnlyList<string> GuidelineReferences,
    IReadOnlyList<string> AffectedAssetIds,
    string Method,
    string Url,
    string Parameter,
    string Role,
    string Source,
    DateTimeOffset? ObservedAt,
    string Summary,
    string Conditions,
    string TechnicalCause,
    string BusinessImpact,
    ReportReproductionV2 Reproduction,
    ReportTechnicalEvidenceV2 TechnicalEvidence,
    IReadOnlyList<string> EvidenceIds,
    ReportRemediationV2 Remediation,
    string VerificationCriteria,
    IReadOnlyList<string> References,
    string Limitations);

public sealed record ReportCvssV2(string Version, decimal? Score, string Vector);
public sealed record ReportReproductionV2(string Prerequisites, IReadOnlyList<string> Steps, string Expected, string Actual);
public sealed record ReportTechnicalEvidenceV2(
    string Request,
    string Response,
    string AttackInput,
    string ObservedEvidence,
    string ExternalInteraction,
    string CollectionStatus);
public sealed record ReportRemediationV2(string Immediate, string Permanent);

public sealed record ReportEvidenceV2(
    string Id,
    string Type,
    string LocalPath,
    string Sha256,
    DateTimeOffset? CapturedAt,
    string Sensitivity,
    string RedactionStatus,
    IReadOnlyList<string> RelatedFindingIds);

public sealed record ReportResponseV2(
    string FindingId,
    string Plan,
    string Owner,
    DateOnly? DueDate,
    string Status,
    DateTimeOffset? RetestAt,
    string RetestResult,
    string ResidualRisk,
    IReadOnlyList<string> RetestEvidenceIds);
