<div align="center">

# cursor-byok

Bring your own model APIs to Cursor — a personal, heavily modified fork.

[Download](https://github.com/Judgecut/cursor-byok/releases) · [Upstream](https://github.com/leehainuo/cursor-byok) · [Original project](https://github.com/leookun/cursor-byok) · [中文说明](./README-CN.md)

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
![Platforms](https://img.shields.io/badge/platform-Windows%20tested-lightgrey?style=flat-square)
![Status](https://img.shields.io/badge/status-personal%20fork-orange?style=flat-square)

</div>

![Connect cursor-byok to a wide range of model APIs](./images/en-brand-1.png)

![cursor-byok dashboard](./images/en-home-1.png)

## About This Repository

This is a personal fork of [leehainuo/cursor-byok](https://github.com/leehainuo/cursor-byok), which in turn builds on [leookun/cursor-byok](https://github.com/leookun/cursor-byok).

Cursor keeps changing its client protocol. When upstream trails behind those changes, this local build simply stops working. Rather than wait for a fix, I patch the protocol adaptation here myself so the setup I actually use keeps running.

## Current Status

| Item | Notes |
| --- | --- |
| Maintenance | Personal fork, flying solo. No longer follows upstream's pace and makes no promise to merge upstream changes |
| Platform | Windows only, and only tested on Windows |
| Distribution | Mainly Windows installers (NSIS), which are convenient for my own use. None published yet — build from source for now, releases will follow |
| Roadmap | May gradually add features that suit my own habits. Ad hoc, no guarantee of being general-purpose |

## Differences From Upstream

- **Cursor protocol adaptation is maintained here.** When the upstream implementation stops working, this repo is patched directly against Cursor's current protocol — which may in turn diverge further from upstream.
- **The feature set will drift toward personal use.** Later additions target what I find convenient, not what covers every use case.

Beyond that, the product itself is still the upstream one: local protocol adaptation, model request forwarding, tool-call coordination, and conversation state on your machine, with tool calling, Skills, MCP, and multi-turn conversations intact.

## How It Works

```text
Cursor client
    │
    │ Agent requests and tool results
    ▼
cursor-byok local service
    │
    │ OpenAI- / Anthropic-compatible requests
    ▼
Your model API
```

API keys and application settings are stored locally; requests are still sent to the model provider you configure.

## Build and Run

Requires Rust stable, Node.js 22 or newer, and the [Tauri 2 prerequisites for Windows](https://v2.tauri.app/start/prerequisites/) (MSVC build tools, WebView2).

```powershell
npm --prefix apps/desktop ci
npm --prefix apps/desktop run tauri:dev
```

Build an NSIS installer:

```powershell
npm --prefix apps/desktop run tauri:build -- --bundles nsis
```

The output lands in `apps/desktop/src-tauri/target/release/bundle/nsis/`. With `make` installed, `make dev-desktop` and `make build-desktop` do the same two things.

If you would rather not compile it yourself, built installers go to [Releases](https://github.com/Judgecut/cursor-byok/releases) — currently empty.

## Caveats

- Only Windows is tested; macOS and Linux are unverified.
- When Cursor changes its protocol again, I may need to catch up, and this may be unusable in the meantime.
- Divergence from upstream will keep growing, so upstream docs and issues may not match what you see here.

## Acknowledgements

Thanks to [leookun](https://github.com/leookun/cursor-byok) for the original project, to [leehainuo](https://github.com/leehainuo/cursor-byok) for the upstream version, and to everyone in the community who contributed code and feedback. This fork would not exist without that work.

Released under the [MIT License](./LICENSE). Upstream copyright and license notices are preserved in [Third-Party Licenses](./THIRD-PARTY-LICENSES.md).

If this modified build is useful to you, take it and adapt it however you like — the MIT License is all it asks.
