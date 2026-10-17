namespace ScopePilot.Domain;

public enum BrunoVerificationStatus
{
    Confirmed,
    NotConfirmed,
    Blocked
}

public sealed class BrunoVerification
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "";
    public BrunoVerificationStatus Status { get; set; }
    public string Result { get; set; } = "";
    public string BlockReason { get; set; } = "";
    public string RequiredInput { get; set; } = "";
    public string Method { get; set; } = "";
    public string Url { get; set; } = "";
    public int ResponseStatus { get; set; }
    public string Role { get; set; } = "";
    public DateTimeOffset RecordedAt { get; set; } = DateTimeOffset.Now;
    public EvidenceReference Exchange { get; set; } = new("", "", "", "bruno-http-exchange", "local-only");
}
