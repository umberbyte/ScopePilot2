# Third-party notices

ScopePilot's original source code, scripts and documentation are licensed under
BSD-3-Clause. Copyright (c) 2026, umberbyte. See `LICENSE`.

Third-party software retains its own copyright notices and license terms.
ScopePilot's BSD-3-Clause license does not relicense those components.

## Bundled components

| Component | License | Upstream | License files |
| --- | --- | --- | --- |
| Playwright MCP | Apache-2.0 | https://github.com/microsoft/playwright-mcp | `tools/playwright-runtime/node_modules/@playwright/mcp/LICENSE` |
| Playwright | Apache-2.0 | https://github.com/microsoft/playwright | `tools/playwright-runtime/node_modules/playwright/LICENSE`, `NOTICE` and `ThirdPartyNotices.txt` |
| Playwright Core | Apache-2.0 | https://github.com/microsoft/playwright | `tools/playwright-runtime/node_modules/playwright-core/LICENSE`, `NOTICE` and `ThirdPartyNotices.txt` |
| Markdig 1.4.0 | BSD-2-Clause | https://github.com/xoofx/markdig | `licenses/word/Markdig-1.4.0.txt` |
| Open XML SDK and Framework 3.5.1 | MIT | https://github.com/dotnet/Open-XML-SDK | `licenses/word/OpenXML-SDK-3.5.1.txt` |
| .NET / Windows Desktop runtime (self-contained distributions) | MIT and component-specific licenses | https://github.com/dotnet/runtime and https://github.com/dotnet/wpf | `licenses/dotnet/<runtime-package>/<version>/`: original `LICENSE` / `LICENSE.TXT` and `THIRD-PARTY-NOTICES.TXT` from the exact resolved runtime packages |

Keep the original license and notice files with the redistributed components.
Playwright package versions and integrity hashes are recorded in
`tools/playwright-runtime/package-lock.json`. Test dependencies are used for
development and are not included in the application payload.

## Burp integration

PortSwigger's MCP Proxy is GPL-3.0 software. It is not included in ScopePilot's
current source tree, portable ZIP or installer. The user obtains it separately
through Burp's MCP extension and places it under the ScopePilot data directory
at `mcp/mcp-proxy-all.jar`, or points `SCOPEPILOT_BURP_PROXY_JAR` to their copy.
Its terms are separate from ScopePilot's license:
https://github.com/PortSwigger/mcp-proxy/blob/main/LICENSE

Burp Suite, its MCP extension, Node.js, Microsoft Edge, Codex CLI and Claude
Code are supplied by their respective vendors and are installed separately by
the user. Their licenses and service terms apply to their use.
