namespace ScopePilot.Services;

internal sealed class InterventionInbox
{
    private string? _lastRequest;
    public HumanInterventionRequest? Observe(string? json)
    {
        if (json is null) { _lastRequest = null; return null; }
        var request = AuthenticationFlow.ParseRequest(json);
        if (request is null) return null;
        var identity = $"{request.Id}\n{request.Authentication}\n{request.Reason}\n{request.Page}\n{request.Instruction}";
        if (identity == _lastRequest) return null;
        _lastRequest = identity;
        return request;
    }
}
