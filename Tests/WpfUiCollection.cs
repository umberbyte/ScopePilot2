using Xunit;

namespace ScopePilot.Tests;

// WPF's shared BAML cache must not be initialized concurrently on separate STA threads.
[CollectionDefinition("WPF UI", DisableParallelization = true)]
public sealed class WpfUiCollection;
