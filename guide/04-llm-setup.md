# 4. LLM setup

> **TL;DR** — Edit `~/.dreamgraph/<instance-uuid>/config/engine.env`, set `DREAMGRAPH_LLM_PROVIDER`, `DREAMGRAPH_LLM_URL`, `DREAMGRAPH_LLM_API_KEY`, and a model. Restart the daemon. The VS Code architect is configured separately in VS Code settings.

DreamGraph has **two** distinct LLM configurations. Don't mix them up:

1. **Daemon-side engine** — used by the cognitive engine (dreaming, normalizing, etc.). Lives in `engine.env`.
2. **VS Code architect** — used by the chat panel in VS Code. Lives in VS Code settings.

You can run with only one of them configured. Many users only ever set the Architect.

---

## Part 1 — Daemon-side engine

### Where the config lives

```
~/.dreamgraph/<instance-uuid>/config/engine.env
```

You can find the UUID from `dg status <name>`.

### Minimum viable config

New instances are local-first: DreamGraph tries Jan's local llama.cpp server with Qwen3 Coder first, then uses SailResearch if Jan is unavailable or explicitly disabled. The SailResearch key must be supplied through the process environment or a secret-manager wrapper; it is never stored in the template.

```dotenv
DREAMGRAPH_LLM_PROVIDER=jan
DREAMGRAPH_JAN_ENABLED=true
DREAMGRAPH_JAN_URL=http://127.0.0.1:1338/v1
DREAMGRAPH_JAN_MODEL=Qwen3-Coder-30B-A3B-Instruct.gguf
DREAMGRAPH_SAILRESEARCH_URL=https://api.sailresearch.com/v1
DREAMGRAPH_SAILRESEARCH_API_KEY=<provided-at-runtime>
DREAMGRAPH_SAILRESEARCH_MODEL=google/gemma-4-31B-it
```

Set `DREAMGRAPH_JAN_ENABLED=false` to skip the local route and go directly to SailResearch. If both routes are unavailable, DreamGraph records deterministic fallback provenance and does not claim an LLM result.

Jan's local API server must expose an OpenAI-compatible `/v1` endpoint. Override `DREAMGRAPH_JAN_URL` when Jan is configured on a non-loopback host or a different port.

For an explicitly selected non-Jan provider, use the existing configuration:

```bash
DREAMGRAPH_LLM_PROVIDER=openai
DREAMGRAPH_LLM_URL=https://api.openai.com/v1
DREAMGRAPH_LLM_API_KEY=sk-...
DREAMGRAPH_LLM_MODEL=gpt-4o-mini
```

After editing: **`dg restart <name>`**. Config is read at startup.

### Supported providers

| Provider | URL example | Notes |
|----------|-------------|-------|
| `openai` | `https://api.openai.com/v1` | Most common. Needs `DREAMGRAPH_LLM_API_KEY`. |
| `anthropic` | `https://api.anthropic.com` | Needs `DREAMGRAPH_LLM_API_KEY`. |
| `ollama` | `http://localhost:11434` | Local. No API key. Default model `qwen3:8b`. |
| `lmstudio` | `http://localhost:1234/v1` | Local. OpenAI-compatible server inside LM Studio. Load a model in the UI, start its server, set the model id. API key is ignored — the literal `lm-studio` is sent automatically. |
| `sampling` | — | Uses the MCP client's own sampling capability. No URL/key needed. |
| `none` | — | Disables LLM features. Structural strategies still work. |

### Dreamer / Normalizer split

The cognitive engine has two roles with very different needs:

- **Dreamer** — creative hypothesis generation. Higher temperature, larger budget.
- **Normalizer** — strict validation. Low temperature, smaller budget.

A good split for OpenAI:

```bash
DREAMGRAPH_LLM_PROVIDER=openai
DREAMGRAPH_LLM_URL=https://api.openai.com/v1
DREAMGRAPH_LLM_API_KEY=sk-...

DREAMGRAPH_LLM_DREAMER_MODEL=gpt-4o-mini
DREAMGRAPH_LLM_DREAMER_TEMPERATURE=0.9
DREAMGRAPH_LLM_DREAMER_MAX_TOKENS=10240

DREAMGRAPH_LLM_NORMALIZER_MODEL=gpt-5.4-nano
DREAMGRAPH_LLM_NORMALIZER_TEMPERATURE=0.1
DREAMGRAPH_LLM_NORMALIZER_MAX_TOKENS=4096
```

Rules:

- `DREAMGRAPH_LLM_MODEL` / `_TEMPERATURE` / `_MAX_TOKENS` are the base defaults.
- `DREAMGRAPH_LLM_DREAMER_*` overrides only apply to the Dreamer.
- `DREAMGRAPH_LLM_NORMALIZER_*` overrides only apply to the Normalizer.
- If no Normalizer temperature is set, it defaults to `0.1`.

### Standalone Architect token economy

The browser Architect reads token economy settings from the same per-instance `engine.env`. Defaults are enabled for safe rollout and easy benchmarking:

```bash
DREAMGRAPH_ARCHITECT_PREAMBLE_COMPILER=true
DREAMGRAPH_ARCHITECT_TOKEN_ECONOMY=true
DREAMGRAPH_ARCHITECT_TOKEN_ECONOMY_SOFT_TARGET=16384
```

Set `DREAMGRAPH_ARCHITECT_TOKEN_ECONOMY=false` to request full-context mode for that instance if compact context causes problems. The Architect prompt box shows the current status next to the attachment button after restart.

### Saving a config as a template

If you find a setup you like, save it as a template so future instances inherit it:

```bash
# Copy the default template scaffold
cp -r ~/.dreamgraph/templates/default ~/.dreamgraph/templates/openai

# Edit ~/.dreamgraph/templates/openai/config/engine.env to taste

# Use it on a new instance
dg init --name another-project --template openai
```

---

## Part 2 — VS Code architect

The Architect is the chat panel in VS Code. It is configured through VS Code settings, not `engine.env`.

### Settings to configure

Open VS Code settings (`Ctrl+,`) and search for `dreamgraph.architect`:

| Setting | Purpose |
|---------|---------|
| `dreamgraph.architect.provider` | `openai`, `anthropic`, `ollama`, `lmstudio`, `copilot-cli`, or `codex-cli`. |
| `dreamgraph.architect.model` | Model id (e.g. `gpt-5.5`, `gpt-5.6-sol` for Codex CLI, or `claude-opus-4-7`). |
| `dreamgraph.architect.baseUrl` | Override only when needed (custom proxy, Azure, etc.). |
| `dreamgraph.architect.openai.reasoningEffort` | GPT-5.5 only: `low`, `medium`, `high`. |
| `dreamgraph.architect.openai.verbosity` | GPT-5.5 only: text verbosity. |

### Setting the API key

Don't paste the key into settings.json. Use the command palette:

> `Ctrl+Shift+P` → **DreamGraph: Set Architect API Key**

Keys are stored in VS Code's secret storage.

### GPT-5.5 / OpenAI Responses API

For `gpt-5.5*` models, the Architect uses the OpenAI Responses API (not Chat Completions). This is automatic — DreamGraph detects the model id and switches transports. You get:

- Responses-style `input` instead of `messages`
- Function-tool calling with `function_call` / `function_call_output` replay
- `reasoning.effort` and `text.verbosity` controls

The DreamGraph knowledge graph remains the source of memory; Responses API is used statelessly.

### GitHub Copilot CLI (no API key)

Set `dreamgraph.architect.provider` to `copilot-cli` to run passes through your locally-installed GitHub Copilot CLI (`copilot` binary on `PATH`, or set an absolute path in `dreamgraph.architect.copilotCli.command`). This uses your existing Copilot login — no API key, no separate billing.

When this provider is active the Architect:

- Talks to the **same** DreamGraph daemon the extension is connected to. The extension injects an in-process MCP **inheritance proxy** as Copilot CLI's `dreamgraph` server, which forwards every tool call over HTTP to the live daemon. ADRs you record, dreams you trigger, and tools you call from a Copilot CLI pass land in the same graph as everything else.
- **Fails closed** before a pass runs if the daemon is unreachable: the proxy will refuse to come up, Copilot CLI reports `dreamgraph` as a failed MCP server, and the orchestrator aborts the run instead of letting the model hallucinate against a missing graph.

Knobs:

| Setting | Purpose |
|---------|---------|
| `dreamgraph.architect.copilotCli.command` | Path to the `copilot` binary (default: `copilot` on `PATH`). |
| `dreamgraph.architect.copilotCli.timeoutMs` | Hard wall-clock cap per pass (default 180000). |
| `dreamgraph.architect.copilotCli.toolListTimeoutMs` | Bridge health-probe timeout against the daemon (default 30000). Bump if your daemon is slow to respond. |

### Codex CLI (no API key)

Set `dreamgraph.architect.provider` to `codex-cli` to route Architect chat turns through your locally-installed Codex CLI (`codex` binary on `PATH`, or set an absolute path in `dreamgraph.architect.codexCli.command`). This uses your existing Codex login and the same DreamGraph MCP inheritance proxy model as Copilot CLI: the extension validates the live tool registry, injects the audited `dreamgraph` MCP server, and fails closed if graph grounding is unavailable.

The model selector includes `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. The adapter defaults GPT-5.6-family runs to `xhigh` reasoning effort unless you explicitly override the CLI configuration.

Knobs:

| Setting | Purpose |
|---------|---------|
| `dreamgraph.architect.codexCli.command` | Path to the `codex` binary (default: `codex` on `PATH`). |
| `dreamgraph.architect.codexCli.timeoutMs` | Hard wall-clock cap per pass (default 1800000). |
| `dreamgraph.architect.codexCli.idleTimeoutMs` | Idle-output cap per pass (default 180000). |
| `dreamgraph.architect.codexCli.toolListTimeoutMs` | Bridge health-probe timeout against the daemon (default 30000). |

---

## Picking a model

For most users:

- **OpenAI users:** `gpt-4o-mini` for both roles is a fine starting point. Upgrade Dreamer to `gpt-4o` or `gpt-5.5` if cycles feel shallow.
- **Anthropic users:** `claude-3-5-haiku` for Normalizer, `claude-3-5-sonnet` for Dreamer.
- **Local-first / privacy-first:** Ollama with `qwen3:8b` (default) or `qwen3:14b` if your machine can handle it. Cycles will be slower.
- **LM Studio users:** any GGUF you've loaded in LM Studio works. Copy its model id from the LM Studio UI into `DREAMGRAPH_LLM_MODEL`. Start with the same model for Dreamer and Normalizer; split later if you have a smaller validator model loaded as well.

---

## Verifying it works

After editing `engine.env` and restarting:

```bash
dg restart my-project
dg status my-project
```

Then trigger a small dream cycle from the VS Code architect or via MCP:

> Ask the Architect: *"run a dream cycle with strategy `gap_detection` and max_dreams 5"*

If you see candidate edges appear in the Explorer's Candidates panel, the LLM is wired correctly. If you get an error about provider/key, re-check `engine.env` and that you actually restarted.

---

## Next

You have an instance with a brain. Now feed it: **[5. Bootstrapping the graph](05-bootstrapping-the-graph.md)**.
