/**
 * DreamGraph LLM Provider — The dream engine's brain.
 *
 * Dreams don't work without an LLM. The deterministic strategies find
 * structural patterns; the LLM provides the creative leap — proposing
 * connections no graph algorithm would discover. The normalizer then
 * filters hallucinations from insights.
 *
 * Provider hierarchy (tried in order):
 *   1. Jan local llama.cpp / Qwen3 Coder, then SailResearch — autonomous daemon dreaming
 *   2. Other explicitly configured direct providers (Ollama / OpenAI-compatible / Anthropic)
 *   3. MCP Sampling — ask the connected client's LLM (human-in-the-loop)
 *   4. None — structural-only fallback (degraded mode)
 *
 * Configuration (env vars):
 *   Shared:
 *     DREAMGRAPH_LLM_PROVIDER   = "jan" | "ollama" | "openai" | "anthropic" | "sampling" | "none"
 *     DREAMGRAPH_LLM_URL        = API base URL (default: http://localhost:11434 for Ollama)
 *     DREAMGRAPH_LLM_API_KEY    = API key for OpenAI-compatible providers
 *
 *   Dreamer (creative dream generation):
 *     DREAMGRAPH_LLM_DREAMER_MODEL       = model name (default: provider-specific)
 *     DREAMGRAPH_LLM_DREAMER_TEMPERATURE = creativity (default: 0.7)
 *     DREAMGRAPH_LLM_DREAMER_MAX_TOKENS  = max response tokens (default: 2048)
 *
 *   Normalizer (semantic validation):
 *     DREAMGRAPH_LLM_NORMALIZER_MODEL       = model name (default: provider-specific)
 *     DREAMGRAPH_LLM_NORMALIZER_TEMPERATURE = temperature (default: 0.1)
 *     DREAMGRAPH_LLM_NORMALIZER_MAX_TOKENS  = max response tokens (default: 2048)
 *
 *   Architect (interactive browser chat):
 *     DREAMGRAPH_LLM_ARCHITECT_PROVIDER    = provider override (default: shared provider)
 *     DREAMGRAPH_LLM_ARCHITECT_MODEL       = model override (fallback: general -> normalizer -> dreamer)
 *     DREAMGRAPH_LLM_ARCHITECT_TEMPERATURE = temperature (default: shared temperature)
 *     DREAMGRAPH_LLM_ARCHITECT_MAX_TOKENS  = max response tokens (default: shared max tokens)
 */

import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type LlmProviderType = "jan" | "ollama" | "lmstudio" | "openai" | "anthropic" | "sampling" | "none";

export interface LlmConfig {
  provider: LlmProviderType;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  /** Per-request abort timeout in milliseconds. Defaults to 120_000. */
  timeoutMs: number;
}

export type LlmConfigSource = "architect" | "general" | "normalizer" | "dreamer" | "provider_default";

export interface ArchitectLlmConfig extends LlmConfig {
  component: "architect";
  providerSource: "architect" | "general";
  modelSource: LlmConfigSource;
  textVerbosity?: "low" | "medium" | "high";
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LlmResult {
  text: string;
  finishReason?: string;
  usage?: TokenUsage;
}

export interface LlmResponse extends LlmResult {
  model: string;
  tokensUsed?: number;
  stopReason?: string;
}

export type LlmModelApi = "chat-completions" | "responses" | "anthropic-messages" | "ollama-chat" | "mcp-sampling" | "none";

export interface ModelCapabilities {
  model: string;
  api: LlmModelApi;
  supportsTemperature: boolean;
  supportsReasoningEffort: boolean;
  supportsStructuredOutputs: boolean;
  supportsJsonSchema: boolean;
}

/**
 * Options for LLM completion requests.
 *
 * JSON enforcement hierarchy (OpenAI provider):
 *   1. `jsonSchema` — Structured Outputs (`strict: true`) — guaranteed schema conformance
 *   2. `jsonMode` — `response_format: json_object` — guaranteed valid JSON, no schema
 *   3. Neither — free-form text
 *
 * For Ollama both fall back to `format: "json"`.
 */
export interface LlmCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /** Override the model for this request (uses provider default if omitted) */
  model?: string;
  /** Optional OpenAI Responses text verbosity. Ignored by providers without native support. */
  textVerbosity?: "low" | "medium" | "high";
  /** Basic JSON mode — model must output valid JSON (no schema enforcement) */
  jsonMode?: boolean;
  /**
   * Strict JSON Schema (OpenAI Structured Outputs).
   * When provided, the OpenAI provider sends `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`.
   * This guarantees the response matches the schema exactly — no malformed JSON, no missing fields.
   * Implies `jsonMode` — you don't need to set both.
   */
  jsonSchema?: {
    /** Schema name (e.g. "dream_response") */
    name: string;
    /** JSON Schema object */
    schema: Record<string, unknown>;
  };
}

export interface LlmProvider {
  readonly name: string;
  /** Check if provider is reachable */
  isAvailable(): Promise<boolean>;
  /** Generate a completion */
  complete(messages: LlmMessage[], options?: LlmCompletionOptions): Promise<LlmResponse>;
  /** Optional route metadata for composite providers. */
  getRouteInfo?(componentModel: string): {
    provider: string;
    model: string;
    fallbackReason?: LlmRouteFallbackReason;
  };
}

export type LlmToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type LlmToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type LlmToolContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type LlmToolLoopMessage = {
  role: "system" | "user" | "assistant";
  content: string | LlmToolContentBlock[];
};

export type LlmToolLoopResponse = {
  text: string;
  model: string;
  stopReason: string;
  toolCalls: LlmToolCall[];
};

export type LlmRouteLayer = "connected" | "daemon" | "deterministic_fallback";

export type LlmRouteFallbackReason =
  | "no_connected_model"
  | "connected_model_unavailable"
  | "no_daemon_model"
  | "daemon_model_unavailable"
  | "provider_failed"
  | "invalid_output"
  | "validation_failed"
  | "jan_unavailable"
  | "jan_disabled"
  | "sailresearch_unavailable";

export type LlmRouteTask =
  | "remediation_drafting"
  | "task_preamble_compilation"
  | "graph_enrichment"
  | "dream_generation"
  | "normalization"
  | "generic";

export interface ConnectedLlmContext {
  provider: LlmProvider;
  /** Compact source label only; do not include prompt or secret material. */
  source: "architect" | "external" | "caller" | "sampling";
  model?: string;
}

export interface LlmRouteRequest {
  task: LlmRouteTask;
  /** Defaults to dreamer. Normalizer stays available for low-temperature validation tasks. */
  daemon_component?: "dreamer" | "normalizer";
  /** Task-specific daemon temperature required by ADR-203. */
  daemon_temperature?: number;
  max_tokens?: number;
  connected?: ConnectedLlmContext | null;
}

export interface LlmRouteSelection {
  layer: LlmRouteLayer;
  provider: LlmProvider | null;
  model: string | null;
  options: LlmCompletionOptions;
  provenance: {
    task: LlmRouteTask;
    layer: LlmRouteLayer;
    provider: string | null;
    model: string | null;
    source: ConnectedLlmContext["source"] | "daemon" | "deterministic_fallback";
    fallback_reason?: LlmRouteFallbackReason;
    temperature?: number;
  };
}

// ---------------------------------------------------------------------------
// Ollama Provider — local model, no API key, autonomous
// ---------------------------------------------------------------------------

class OllamaProvider implements LlmProvider {
  readonly name = "ollama";

  constructor(
    private baseUrl: string,
    private model: string,
    private defaultTemperature: number,
    private defaultMaxTokens: number,
    private timeoutMs: number = 120_000,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(messages: LlmMessage[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    const temp = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens ?? this.defaultMaxTokens;

    const model = options?.model ?? this.model;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: temp,
        num_predict: maxTokens,
      },
    };

    // Ollama: both jsonSchema and jsonMode map to format: "json"
    // (Ollama doesn't support strict schema enforcement)
    if (options?.jsonSchema || options?.jsonMode) {
      body.format = "json";
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      throw new Error(`Ollama ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      message?: { content?: string };
      model?: string;
      eval_count?: number;
      done_reason?: string;
    };

    return {
      text: data.message?.content ?? "",
      model: data.model ?? this.model,
      tokensUsed: data.eval_count,
      stopReason: data.done_reason,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-Compatible Provider — Anthropic, OpenAI, Groq, LM Studio, etc.
// ---------------------------------------------------------------------------

/**
 * Process-lifetime cache of (provider, model) pairs known to reject strict
 * `response_format: json_schema`. When a downgrade has been detected once,
 * subsequent requests for the same model skip straight to `json_object` mode
 * to avoid wasting a round trip.
 *
 * Provider-agnostic — affects any OpenAI-compatible endpoint, including
 * LM Studio runtimes that don't implement Structured Outputs and Ollama
 * behind a compatibility shim.
 */
const _jsonSchemaUnsupported = new Set<string>();
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

const OPENAI_MODEL_CAPABILITIES: Array<{ pattern: RegExp; capabilities: Omit<ModelCapabilities, "model"> }> = [
  {
    pattern: /^gpt-5\.5(?:\b|[-_])/i,
    capabilities: {
      api: "responses",
      supportsTemperature: false,
      supportsReasoningEffort: true,
      supportsStructuredOutputs: true,
      supportsJsonSchema: true,
    },
  },
  {
    pattern: /^gpt-[4-9]\.[1-9]/i,
    capabilities: {
      api: "chat-completions",
      supportsTemperature: true,
      supportsReasoningEffort: false,
      supportsStructuredOutputs: true,
      supportsJsonSchema: true,
    },
  },
  {
    pattern: /^(o[1-9]|gpt-5(?:\b|[-_]))/i,
    capabilities: {
      api: "chat-completions",
      supportsTemperature: false,
      supportsReasoningEffort: true,
      supportsStructuredOutputs: true,
      supportsJsonSchema: true,
    },
  },
];

export function getModelCapabilities(provider: LlmProviderType | string, model: string): ModelCapabilities {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = model.trim();
  if (normalizedProvider === "openai") {
    const match = OPENAI_MODEL_CAPABILITIES.find((entry) => entry.pattern.test(normalizedModel));
    return {
      model: normalizedModel,
      ...(match?.capabilities ?? {
        api: "chat-completions" as const,
        supportsTemperature: true,
        supportsReasoningEffort: false,
        supportsStructuredOutputs: true,
        supportsJsonSchema: true,
      }),
    };
  }
  if (normalizedProvider === "anthropic") {
    return {
      model: normalizedModel,
      api: "anthropic-messages",
      supportsTemperature: true,
      supportsReasoningEffort: false,
      supportsStructuredOutputs: false,
      supportsJsonSchema: false,
    };
  }
  if (
    normalizedProvider === "jan" ||
    normalizedProvider === "lmstudio" ||
    normalizedProvider === "sailresearch" ||
    normalizedProvider === "ollama"
  ) {
    return {
      model: normalizedModel,
      api: normalizedProvider === "ollama" ? "ollama-chat" : "chat-completions",
      supportsTemperature: true,
      supportsReasoningEffort: false,
      supportsStructuredOutputs: false,
      supportsJsonSchema: false,
    };
  }
  return {
    model: normalizedModel,
    api: normalizedProvider === "sampling" ? "mcp-sampling" : "none",
    supportsTemperature: false,
    supportsReasoningEffort: false,
    supportsStructuredOutputs: false,
    supportsJsonSchema: false,
  };
}

/** Heuristic: error body indicates the strict json_schema form is unsupported. */
function _isJsonSchemaUnsupportedError(status: number, body: string): boolean {
  if (status < 400 || status >= 500) return false;
  const lower = body.toLowerCase();
  if (!lower.includes("response_format") && !lower.includes("json_schema")) {
    return false;
  }
  return (
    lower.includes("unsupported") ||
    lower.includes("not supported") ||
    lower.includes("not support") ||
    lower.includes("invalid") ||
    lower.includes("unknown")
  );
}

class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string,
    private defaultTemperature: number,
    private defaultMaxTokens: number,
    name: string = "openai",
    private timeoutMs: number = 120_000,
  ) {
    this.name = name;
  }

  private isUnconfiguredDefaultOpenAi(): boolean {
    return this.name === "openai" &&
      this.baseUrl.replace(/\/+$/, "") === OPENAI_DEFAULT_BASE_URL &&
      this.apiKey.trim().length === 0;
  }

  async isAvailable(): Promise<boolean> {
    if (this.isUnconfiguredDefaultOpenAi()) return false;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(messages: LlmMessage[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    if (this.isUnconfiguredDefaultOpenAi()) {
      throw new Error(
        "OpenAI provider is missing DREAMGRAPH_LLM_API_KEY; configure a key or set DREAMGRAPH_LLM_URL to an explicit OpenAI-compatible endpoint.",
      );
    }
    const temp = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens ?? this.defaultMaxTokens;
    const model = options?.model ?? this.model;
    const capabilities = getModelCapabilities(this.name, model);

    // Newer OpenAI models (o1/o3/o4-mini, gpt-4.1, gpt-5.4-nano, etc.) require
    // "max_completion_tokens" instead of the legacy "max_tokens" parameter.
    const useNewTokenParam = /^(o[1-9]|gpt-[4-9]\.[1-9]|gpt-5)/i.test(model);

    const downgradeKey = `${this.name}:${model}`;
    const knownUnsupported = _jsonSchemaUnsupported.has(downgradeKey);

    if (capabilities.api === "responses") {
      return this.completeWithResponses(messages, model, temp, maxTokens, capabilities, options?.textVerbosity);
    }

    const buildBody = (useStrictSchema: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        ...(capabilities.supportsTemperature ? { temperature: temp } : {}),
        ...(useNewTokenParam
          ? { max_completion_tokens: maxTokens }
          : { max_tokens: maxTokens }),
      };

      // Structured Outputs (strict schema) > basic JSON mode > free-form
      if (options?.jsonSchema && useStrictSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: options.jsonSchema.name,
            strict: true,
            schema: options.jsonSchema.schema,
          },
        };
      } else if (options?.jsonSchema || options?.jsonMode) {
        // Either jsonMode requested directly, or jsonSchema downgraded.
        body.response_format = { type: "json_object" };
      }

      return body;
    };

    const callOnce = (useStrictSchema: boolean): Promise<Response> =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(buildBody(useStrictSchema)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

    // First attempt: use strict schema if requested AND not known-unsupported.
    let useStrict = !!options?.jsonSchema && !knownUnsupported;
    let res = await callOnce(useStrict);

    // One-shot downgrade: strict schema rejected → retry once with json_object.
    if (!res.ok && useStrict) {
      const errText = await res.text().catch(() => "unknown");
      if (_isJsonSchemaUnsupportedError(res.status, errText)) {
        _jsonSchemaUnsupported.add(downgradeKey);
        logger.warn(
          `LLM ${this.name}: model "${model}" rejected response_format=json_schema (${res.status}); ` +
          `falling back to json_object for this process. Body: ${errText.slice(0, 200)}`,
        );
        useStrict = false;
        res = await callOnce(false);
      } else {
        throw new Error(`OpenAI-compat ${res.status}: ${errText}`);
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      throw new Error(`OpenAI-compat ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      model?: string;
      usage?: { completion_tokens?: number };
    };

    const choice = data.choices?.[0];
    const usage: TokenUsage | undefined = data.usage?.completion_tokens === undefined
      ? undefined
      : { outputTokens: data.usage.completion_tokens };
    return {
      text: choice?.message?.content ?? "",
      model: data.model ?? this.model,
      tokensUsed: usage?.outputTokens,
      stopReason: choice?.finish_reason,
      finishReason: choice?.finish_reason,
      usage,
    };
  }

  private async completeWithResponses(
    messages: LlmMessage[],
    model: string,
    temp: number,
    maxTokens: number,
    capabilities: ModelCapabilities,
    textVerbosity?: "low" | "medium" | "high",
  ): Promise<LlmResponse> {
    const instructions = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const input = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }));
    const body: Record<string, unknown> = {
      model,
      input,
      max_output_tokens: maxTokens,
      ...(textVerbosity ? { text: { verbosity: textVerbosity } } : {}),
      ...(capabilities.supportsTemperature ? { temperature: temp } : {}),
    };
    if (instructions) {
      body.instructions = instructions;
    }

    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      throw new Error(`OpenAI Responses ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      output_text?: string;
      model?: string;
      status?: string;
      usage?: { output_tokens?: number; completion_tokens?: number };
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    const text = data.output_text ?? (data.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((content) => content.type === "output_text" || content.type === "text")
      .map((content) => content.text ?? "")
      .join("");
    const outputTokens = data.usage?.output_tokens ?? data.usage?.completion_tokens;
    const usage: TokenUsage | undefined = outputTokens === undefined ? undefined : { outputTokens };
    return {
      text,
      model: data.model ?? model,
      tokensUsed: usage?.outputTokens,
      stopReason: data.status,
      finishReason: data.status,
      usage,
    };
  }
}

export async function completeWithNativeTools(
  config: ArchitectLlmConfig,
  messages: LlmToolLoopMessage[],
  tools: LlmToolDefinition[],
): Promise<LlmToolLoopResponse> {
  if (config.provider === "anthropic") {
    return callAnthropicWithTools(config, messages, tools);
  }
  const capabilities = getModelCapabilities(config.provider, config.model);
  if (config.provider === "openai" && capabilities.api === "responses") {
    return callOpenAiResponsesWithTools(config, messages, tools);
  }
  return callOpenAiCompatibleWithTools(config, messages, tools);
}

async function callOpenAiCompatibleWithTools(
  config: ArchitectLlmConfig,
  messages: LlmToolLoopMessage[],
  tools: LlmToolDefinition[],
): Promise<LlmToolLoopResponse> {
  const capabilities = getModelCapabilities(config.provider, config.model);
  const useNewTokenParam = /^(o[1-9]|gpt-[4-9]\.[1-9]|gpt-5)/i.test(config.model);
  const body: Record<string, unknown> = {
    model: config.model,
    messages: toOpenAiMessages(messages),
    ...(capabilities.supportsTemperature ? { temperature: config.temperature } : {}),
    ...(useNewTokenParam
      ? { max_completion_tokens: config.maxTokens }
      : { max_tokens: config.maxTokens }),
    tools: tools.map(toOpenAiTool),
    tool_choice: "auto",
  };

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`OpenAI-compatible tool call ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      finish_reason?: string;
    }>;
    model?: string;
  };
  const choice = data.choices?.[0];
  const toolCalls = (choice?.message?.tool_calls ?? []).map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.function.name,
    input: parseToolArguments(toolCall.function.arguments),
  }));
  return {
    text: choice?.message?.content ?? "",
    model: data.model ?? config.model,
    stopReason: choice?.finish_reason === "tool_calls" ? "tool_use" : (choice?.finish_reason ?? "stop"),
    toolCalls,
  };
}

async function callOpenAiResponsesWithTools(
  config: ArchitectLlmConfig,
  messages: LlmToolLoopMessage[],
  tools: LlmToolDefinition[],
): Promise<LlmToolLoopResponse> {
  const capabilities = getModelCapabilities(config.provider, config.model);
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : blocksToText(message.content))
    .filter(Boolean)
    .join("\n\n");
  const body: Record<string, unknown> = {
    model: config.model,
    input: toOpenAiResponsesInput(messages.filter((message) => message.role !== "system")),
    tools: tools.map(toOpenAiResponsesTool),
    tool_choice: "auto",
    max_output_tokens: config.maxTokens,
    ...(config.textVerbosity ? { text: { verbosity: config.textVerbosity } } : {}),
    ...(capabilities.supportsTemperature ? { temperature: config.temperature } : {}),
  };
  if (systemText) {
    body.instructions = systemText;
  }

  const res = await fetch(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`OpenAI Responses tool call ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    id?: string;
    model?: string;
    output_text?: string;
    status?: string;
    output?: Array<{
      id?: string;
      type?: string;
      status?: string;
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
  const output = data.output ?? [];
  const text = data.output_text ?? output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" || content.type === "text")
    .map((content) => content.text ?? "")
    .join("");
  const toolCalls = output
    .filter((item) => item.type === "function_call" && item.name && item.call_id)
    .map((item) => ({
      id: item.call_id!,
      name: item.name!,
      input: parseToolArguments(item.arguments ?? "{}"),
    }));
  return {
    text,
    model: data.model ?? config.model,
    stopReason: toolCalls.length > 0 ? "tool_use" : (data.status ?? "stop"),
    toolCalls,
  };
}

async function callAnthropicWithTools(
  config: ArchitectLlmConfig,
  messages: LlmToolLoopMessage[],
  tools: LlmToolDefinition[],
): Promise<LlmToolLoopResponse> {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : blocksToText(message.content))
    .filter(Boolean)
    .join("\n\n");

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    messages: messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicToolMessage),
    tools: tools.map(toAnthropicTool),
  };
  if (systemText) {
    body.system = systemText;
  }

  const res = await fetch(`${config.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown");
    throw new Error(`Anthropic tool call ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    model?: string;
    stop_reason?: string;
  };
  const blocks = data.content ?? [];
  return {
    text: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join(""),
    model: data.model ?? config.model,
    stopReason: data.stop_reason ?? "stop",
    toolCalls: blocks
      .filter((block) => block.type === "tool_use" && block.id && block.name)
      .map((block) => ({
        id: block.id!,
        name: block.name!,
        input: isRecord(block.input) ? block.input : {},
      })),
  };
}

function toOpenAiResponsesInput(messages: LlmToolLoopMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        out.push({ role: message.role === "assistant" ? "assistant" : "user", content: block.text });
      } else if (block.type === "tool_use") {
        out.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === "tool_result") {
        out.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.content });
      }
    }
  }
  return out;
}

function toOpenAiMessages(messages: LlmToolLoopMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const text = blocksToText(message.content);
    const toolUses = message.content.filter((block): block is Extract<LlmToolContentBlock, { type: "tool_use" }> => block.type === "tool_use");
    const toolResults = message.content.filter((block): block is Extract<LlmToolContentBlock, { type: "tool_result" }> => block.type === "tool_result");

    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((block) => ({
                id: block.id,
                type: "function",
                function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }

    if (text) {
      out.push({ role: message.role, content: text });
    }
    for (const result of toolResults) {
      out.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content });
    }
  }
  return out;
}

function toAnthropicToolMessage(message: LlmToolLoopMessage): Record<string, unknown> {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: message.content.map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
    }),
  };
}

function toOpenAiTool(tool: LlmToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "DreamGraph MCP tool",
      parameters: normalizeToolInputSchema(tool.inputSchema),
    },
  };
}

function toOpenAiResponsesTool(tool: LlmToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? "DreamGraph MCP tool",
    parameters: normalizeToolInputSchema(tool.inputSchema),
  };
}

function toAnthropicTool(tool: LlmToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? "DreamGraph MCP tool",
    input_schema: normalizeToolInputSchema(tool.inputSchema),
  };
}

function normalizeToolInputSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return {
    type: schema.type === "object" ? "object" : "object",
    properties: isRecord(schema.properties) ? schema.properties : {},
    required: Array.isArray(schema.required) ? schema.required : [],
    ...(schema.additionalProperties !== undefined ? { additionalProperties: schema.additionalProperties } : {}),
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return { _raw: raw };
  }
}

function blocksToText(blocks: LlmToolContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<LlmToolContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test-only: clear the json_schema downgrade cache. */
export function _resetJsonSchemaDowngradeForTest(): void {
  _jsonSchemaUnsupported.clear();
}

// ---------------------------------------------------------------------------
// Anthropic Provider — native Claude API
// ---------------------------------------------------------------------------

/**
 * Native Anthropic Messages API provider.
 * Uses /v1/messages endpoint with x-api-key auth and anthropic-version header.
 * System messages are extracted and sent as the top-level `system` param.
 */
class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";

  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string,
    private defaultTemperature: number,
    private defaultMaxTokens: number,
    private timeoutMs: number = 120_000,
  ) {}

  async isAvailable(): Promise<boolean> {
    // Anthropic doesn't have a lightweight ping endpoint;
    // just verify we have an API key configured.
    return !!this.apiKey;
  }

  async complete(messages: LlmMessage[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    const temp = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens ?? this.defaultMaxTokens;
    const model = options?.model ?? this.model;

    // Anthropic requires system messages as a top-level param, not in the messages array
    const systemMessages = messages.filter(m => m.role === "system");
    const nonSystemMessages = messages.filter(m => m.role !== "system");
    const systemText = systemMessages.map(m => m.content).join("\n\n") || undefined;

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      temperature: temp,
      messages: nonSystemMessages.map(m => ({ role: m.role, content: m.content })),
    };

    if (systemText) {
      body.system = systemText;
    }

    // Anthropic doesn't support OpenAI-style structured outputs or json_mode,
    // but we can hint via a prefill trick: append an assistant message starting with "{"
    // to encourage JSON output when jsonMode or jsonSchema is requested.
    if (options?.jsonSchema || options?.jsonMode) {
      // Add instruction to system message
      const jsonHint = "\n\nYou MUST respond with valid JSON only. No markdown, no explanation — just the JSON object.";
      if (body.system) {
        body.system = (body.system as string) + jsonHint;
      } else {
        body.system = jsonHint.trim();
      }
    }

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      throw new Error(`Anthropic ${res.status}: ${errText}`);
    }

    const data = await res.json() as {
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      usage?: { output_tokens?: number };
      stop_reason?: string;
    };

    const textBlock = data.content?.find(b => b.type === "text");
    return {
      text: textBlock?.text ?? "",
      model: data.model ?? this.model,
      tokensUsed: data.usage?.output_tokens,
      stopReason: data.stop_reason,
    };
  }
}

// ---------------------------------------------------------------------------
// MCP Sampling Provider — uses the connected client's LLM
// ---------------------------------------------------------------------------

/**
 * MCP Sampling provider — asks the connected client's LLM via the
 * MCP sampling/createMessage protocol.
 *
 * Requires:
 * - A connected client that supports sampling capability
 * - Human-in-the-loop approval from the client side
 * - Server reference set via setMcpServer()
 *
 * Use this when DreamGraph is connected to an AI IDE (VS Code + Copilot).
 * For autonomous daemon dreaming, prefer Ollama or OpenAI provider.
 */
class McpSamplingProvider implements LlmProvider {
  readonly name = "sampling";
  private _server: unknown = null;

  /** Inject the MCP Server instance after connection */
  setServer(server: unknown): void {
    this._server = server;
  }

  async isAvailable(): Promise<boolean> {
    if (!this._server) return false;
    try {
      // Check if the low-level Server has client capabilities with sampling
      const srv = this._server as {
        getClientCapabilities?: () => { sampling?: unknown } | undefined;
      };
      const caps = srv.getClientCapabilities?.();
      return !!caps?.sampling;
    } catch {
      return false;
    }
  }

  async complete(messages: LlmMessage[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    if (!this._server) {
      throw new Error("MCP Sampling: No server connected");
    }

    const srv = this._server as {
      createMessage: (params: Record<string, unknown>) => Promise<{
        content: { type: string; text?: string } | Array<{ type: string; text?: string }>;
        model?: string;
        stopReason?: string;
      }>;
    };

    // Convert our messages to MCP sampling format
    // MCP sampling expects: messages array + optional systemPrompt
    const systemMsg = messages.find(m => m.role === "system");
    const nonSystemMsgs = messages.filter(m => m.role !== "system");

    const params: Record<string, unknown> = {
      messages: nonSystemMsgs.map(m => ({
        role: m.role,
        content: { type: "text", text: m.content },
      })),
      maxTokens: options?.maxTokens ?? 2048,
    };

    if (systemMsg) {
      params.systemPrompt = systemMsg.content;
    }

    if (options?.temperature !== undefined) {
      params.modelPreferences = {
        costPriority: 0.3,
        speedPriority: 0.5,
        intelligencePriority: 0.8,
      };
    }

    const result = await srv.createMessage(params);

    // Extract text from response content
    const content = Array.isArray(result.content)
      ? result.content
      : [result.content];
    const text = content
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("");

    return {
      text,
      model: result.model ?? "client-llm",
      stopReason: result.stopReason,
    };
  }
}

// ---------------------------------------------------------------------------
// Jan-first provider — local llama.cpp with SailResearch failover
// ---------------------------------------------------------------------------

class JanFirstProvider implements LlmProvider {
  private activeProvider: LlmProvider | null = null;
  private fallbackReason: LlmRouteFallbackReason | undefined;

  constructor(
    private jan: LlmProvider,
    private sailResearch: LlmProvider,
    private janEnabled: boolean,
    private janModel: string,
    private sailResearchModel: string,
  ) {}

  get name(): string {
    return this.activeProvider?.name ?? "jan";
  }

  async isAvailable(): Promise<boolean> {
    this.activeProvider = null;
    this.fallbackReason = undefined;

    if (!this.janEnabled) {
      this.fallbackReason = "jan_disabled";
    } else if (await this.jan.isAvailable().catch(() => false)) {
      this.activeProvider = this.jan;
      return true;
    } else {
      this.fallbackReason = "jan_unavailable";
    }

    if (await this.sailResearch.isAvailable().catch(() => false)) {
      this.activeProvider = this.sailResearch;
      return true;
    }

    this.activeProvider = null;
    this.fallbackReason = "sailresearch_unavailable";
    return false;
  }

  async complete(messages: LlmMessage[], options?: LlmCompletionOptions): Promise<LlmResponse> {
    if (!this.activeProvider && !(await this.isAvailable())) {
      throw new Error("Jan and SailResearch are unavailable");
    }

    const provider = this.activeProvider!;
    const model = provider === this.jan ? this.janModel : this.sailResearchModel;
    try {
      return await provider.complete(messages, { ...options, model: options?.model ?? model });
    } catch (error) {
      if (provider !== this.jan || !(await this.sailResearch.isAvailable().catch(() => false))) {
        throw error;
      }

      this.activeProvider = this.sailResearch;
      this.fallbackReason = "jan_unavailable";
      return this.sailResearch.complete(messages, {
        ...options,
        model: options?.model ?? this.sailResearchModel,
      });
    }
  }

  getRouteInfo(componentModel: string): {
    provider: string;
    model: string;
    fallbackReason?: LlmRouteFallbackReason;
  } {
    const usingJan = this.activeProvider === this.jan || !this.activeProvider;
    return {
      provider: usingJan ? "jan" : "sailresearch",
      model: usingJan ? (componentModel || this.janModel) : this.sailResearchModel,
      fallbackReason: this.fallbackReason,
    };
  }
}

// ---------------------------------------------------------------------------
// Null Provider — structural-only fallback (degraded mode)
// ---------------------------------------------------------------------------

class NullProvider implements LlmProvider {
  readonly name = "none";

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async complete(): Promise<LlmResponse> {
    throw new Error(
      "LLM provider not configured. Dreams require an LLM. " +
      "Ensure Jan is running or set DREAMGRAPH_JAN_ENABLED=false to use SailResearch, " +
      "or explicitly select another supported provider."
    );
  }
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

export function parseLlmConfig(): LlmConfig {
  const provider = (process.env.DREAMGRAPH_LLM_PROVIDER ?? "jan") as LlmProviderType;

  // Provider defaults — model/temperature/maxTokens serve as fallbacks
  // for per-component configs (dreamer, normalizer) when their env vars
  // are not set. The base model can be selected with DREAMGRAPH_LLM_MODEL;
  // temperature and maxTokens remain shared defaults.
  const temperature = 0.7;
  const maxTokens = 2048;
  const timeoutEnv = Number(process.env.DREAMGRAPH_LLM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : 120_000;

  let model: string;
  let baseUrl: string;
  let apiKey: string;

  switch (provider) {
    case "jan":
      model = process.env.DREAMGRAPH_JAN_MODEL ?? process.env.DREAMGRAPH_LLM_MODEL ?? "Qwen3-Coder-30B-A3B-Instruct.gguf";
      baseUrl = process.env.DREAMGRAPH_JAN_URL ?? "http://127.0.0.1:1338/v1";
      apiKey = process.env.DREAMGRAPH_JAN_API_KEY ?? "";
      break;
    case "ollama":
      model = "qwen3:8b";
      baseUrl = process.env.DREAMGRAPH_LLM_URL ?? "http://localhost:11434";
      apiKey = "";
      break;
    case "lmstudio":
      model = process.env.DREAMGRAPH_LLM_MODEL ?? "";
      baseUrl = process.env.DREAMGRAPH_LLM_URL ?? "http://localhost:1234/v1";
      // LM Studio ignores the auth header, but the OpenAI-compat code path
      // still sends one. A literal placeholder keeps both sides happy and
      // avoids special-casing the request layer.
      apiKey = process.env.DREAMGRAPH_LLM_API_KEY ?? "lm-studio";
      break;
    case "openai":
      model = process.env.DREAMGRAPH_LLM_MODEL ?? "gpt-4o-mini";
      baseUrl = process.env.DREAMGRAPH_LLM_URL ?? OPENAI_DEFAULT_BASE_URL;
      apiKey = process.env.DREAMGRAPH_LLM_API_KEY ?? "";
      break;
    case "anthropic":
      model = "claude-sonnet-4-20250514";
      baseUrl = process.env.DREAMGRAPH_LLM_URL ?? "https://api.anthropic.com/v1";
      apiKey = process.env.DREAMGRAPH_LLM_API_KEY ?? "";
      break;
    case "sampling":
      model = "client";
      baseUrl = "";
      apiKey = "";
      break;
    default: // "none"
      model = "";
      baseUrl = "";
      apiKey = "";
      break;
  }

  return { provider, model, baseUrl, apiKey, temperature, maxTokens, timeoutMs };
}

// ---------------------------------------------------------------------------
// Per-component config — dreamer and normalizer can have different settings
// ---------------------------------------------------------------------------

/**
 * Parse per-component LLM settings.
 * Reads DREAMGRAPH_LLM_{COMPONENT}_MODEL / TEMPERATURE / MAX_TOKENS,
 * falling back to provider-specific defaults from the base LlmConfig.
 * The `defaultTemperature` override allows the normalizer to default to
 * low temperature (0.1) for consistent, deterministic validation even
 * when no env var is set.
 */
function parseComponentConfig(
  component: "DREAMER" | "NORMALIZER",
  base: LlmConfig,
  defaultTemperature?: number,
): { model: string; temperature: number; maxTokens: number } {
  const prefix = `DREAMGRAPH_LLM_${component}`;
  const model = process.env[`${prefix}_MODEL`] ?? base.model;
  const temperature = process.env[`${prefix}_TEMPERATURE`]
    ? parseFloat(process.env[`${prefix}_TEMPERATURE`]!)
    : (defaultTemperature ?? base.temperature);
  const maxTokens = process.env[`${prefix}_MAX_TOKENS`]
    ? parseInt(process.env[`${prefix}_MAX_TOKENS`]!, 10)
    : base.maxTokens;
  return { model, temperature, maxTokens };
}

const LLM_PROVIDER_TYPES: readonly LlmProviderType[] = ["jan", "ollama", "lmstudio", "openai", "anthropic", "sampling", "none"];

function envText(key: string): string | null {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : null;
}

function envNumber(key: string, fallback: number): number {
  const raw = envText(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFlag(key: string, fallback: boolean): boolean {
  const value = envText(key);
  if (!value) return fallback;
  return !["0", "false", "no", "off", "disabled"].includes(value.toLowerCase());
}

function parseProviderOverride(raw: string | null): LlmProviderType | null {
  const normalized = raw?.toLowerCase() as LlmProviderType | undefined;
  return normalized && LLM_PROVIDER_TYPES.includes(normalized) ? normalized : null;
}

function providerDefaults(provider: LlmProviderType, base: LlmConfig): Pick<LlmConfig, "model" | "baseUrl" | "apiKey"> {
  switch (provider) {
    case "jan":
      return {
        model: process.env.DREAMGRAPH_JAN_MODEL ?? "Qwen3-Coder-30B-A3B-Instruct.gguf",
        baseUrl: process.env.DREAMGRAPH_JAN_URL ?? "http://127.0.0.1:1338/v1",
        apiKey: process.env.DREAMGRAPH_JAN_API_KEY ?? "",
      };
    case "ollama":
      return { model: "qwen3:8b", baseUrl: "http://localhost:11434", apiKey: "" };
    case "lmstudio":
      return { model: envText("DREAMGRAPH_LLM_MODEL") ?? "", baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio" };
    case "openai":
      return { model: envText("DREAMGRAPH_LLM_MODEL") ?? "gpt-4o-mini", baseUrl: OPENAI_DEFAULT_BASE_URL, apiKey: process.env.DREAMGRAPH_LLM_API_KEY ?? "" };
    case "anthropic":
      return { model: "claude-sonnet-4-20250514", baseUrl: "https://api.anthropic.com/v1", apiKey: process.env.DREAMGRAPH_LLM_API_KEY ?? "" };
    case "sampling":
      return { model: "client", baseUrl: "", apiKey: "" };
    default:
      return { model: base.model, baseUrl: base.baseUrl, apiKey: base.apiKey };
  }
}

let _dreamerConfig: { model: string; temperature: number; maxTokens: number } | null = null;
let _normalizerConfig: { model: string; temperature: number; maxTokens: number } | null = null;
let _architectConfig: ArchitectLlmConfig | null = null;

/** Get dreamer-specific LLM settings (model, temperature, maxTokens) */
export function getDreamerLlmConfig(): { model: string; temperature: number; maxTokens: number } {
  if (!_dreamerConfig) {
    _dreamerConfig = parseComponentConfig("DREAMER", getLlmConfig());
    const base = getLlmConfig();
    if (_dreamerConfig.model !== base.model || _dreamerConfig.temperature !== base.temperature) {
      logger.info(
        `LLM dreamer config: model=${_dreamerConfig.model}, temp=${_dreamerConfig.temperature}, maxTokens=${_dreamerConfig.maxTokens}`
      );
    }
  }
  return _dreamerConfig;
}

/**
 * Get normalizer-specific LLM settings (model, temperature, maxTokens).
 * Normalizer defaults to temperature 0.1 (low) for consistent, deterministic
 * validation judgments. This is intentionally different from the dreamer's
 * creative 0.7-0.9 temperature — the normalizer is a strict critic.
 */
export function getNormalizerLlmConfig(): { model: string; temperature: number; maxTokens: number } {
  if (!_normalizerConfig) {
    _normalizerConfig = parseComponentConfig("NORMALIZER", getLlmConfig(), 0.1);
    const base = getLlmConfig();
    if (_normalizerConfig.model !== base.model || _normalizerConfig.temperature !== 0.1) {
      logger.info(
        `LLM normalizer config: model=${_normalizerConfig.model}, temp=${_normalizerConfig.temperature}, maxTokens=${_normalizerConfig.maxTokens}`
      );
    }
  }
  return _normalizerConfig;
}

/**
 * Get Architect chat LLM settings and expose the exact fallback source.
 * Model order: ARCHITECT -> general -> normalizer -> dreamer.
 */
export function getArchitectLlmConfig(): ArchitectLlmConfig {
  if (!_architectConfig) {
    const base = getLlmConfig();
    const requestedProvider = parseProviderOverride(envText("DREAMGRAPH_LLM_ARCHITECT_PROVIDER"));
    const provider = requestedProvider ?? base.provider;
    const providerSource: ArchitectLlmConfig["providerSource"] = requestedProvider ? "architect" : "general";
    const defaults = providerDefaults(provider, base);
    const modelCandidates: Array<{ value: string | null; source: LlmConfigSource }> = [
      { value: envText("DREAMGRAPH_LLM_ARCHITECT_MODEL"), source: "architect" },
      { value: envText("DREAMGRAPH_LLM_MODEL") ?? base.model ?? defaults.model, source: "general" },
      { value: envText("DREAMGRAPH_LLM_NORMALIZER_MODEL"), source: "normalizer" },
      { value: envText("DREAMGRAPH_LLM_DREAMER_MODEL"), source: "dreamer" },
      { value: defaults.model, source: "provider_default" },
    ];
    const selected = modelCandidates.find((candidate) => candidate.value != null && candidate.value.length > 0) ?? {
      value: "",
      source: "provider_default" as const,
    };

    _architectConfig = {
      component: "architect",
      provider,
      providerSource,
      model: selected.value ?? "",
      modelSource: selected.source,
      baseUrl: envText("DREAMGRAPH_LLM_ARCHITECT_URL") ?? (provider === base.provider ? base.baseUrl : defaults.baseUrl),
      apiKey: process.env.DREAMGRAPH_LLM_ARCHITECT_API_KEY ?? (provider === base.provider ? base.apiKey : defaults.apiKey),
      temperature: envNumber("DREAMGRAPH_LLM_ARCHITECT_TEMPERATURE", base.temperature),
      maxTokens: Math.trunc(envNumber("DREAMGRAPH_LLM_ARCHITECT_MAX_TOKENS", base.maxTokens)),
      timeoutMs: base.timeoutMs,
    };
    logger.info(
      `LLM architect config: provider=${_architectConfig.provider} (${_architectConfig.providerSource}), ` +
        `model=${_architectConfig.model || "n/a"} (${_architectConfig.modelSource}), ` +
        `temp=${_architectConfig.temperature}, maxTokens=${_architectConfig.maxTokens}`,
    );
  }
  return _architectConfig;
}

/** Update Architect chat LLM settings at runtime. */
export function updateArchitectLlmConfig(
  partial: Partial<Pick<ArchitectLlmConfig, "provider" | "model" | "baseUrl" | "temperature" | "maxTokens">>,
): ArchitectLlmConfig {
  const current = getArchitectLlmConfig();
  const base = getLlmConfig();
  const provider = partial.provider ?? current.provider;
  const providerChanged = provider !== current.provider;
  const defaults = providerDefaults(provider, base);
  const model = partial.model ?? current.model;

  _architectConfig = {
    ...current,
    provider,
    providerSource: partial.provider != null ? "architect" : current.providerSource,
    model,
    modelSource: partial.model != null ? "architect" : current.modelSource,
    baseUrl: partial.baseUrl ?? (providerChanged ? defaults.baseUrl : current.baseUrl),
    apiKey: providerChanged ? defaults.apiKey : current.apiKey,
    temperature: partial.temperature ?? current.temperature,
    maxTokens: Math.trunc(partial.maxTokens ?? current.maxTokens),
  };
  logger.info(
    `LLM architect config updated: provider=${_architectConfig.provider}, ` +
      `model=${_architectConfig.model || "n/a"}, temp=${_architectConfig.temperature}, ` +
      `maxTokens=${_architectConfig.maxTokens}`,
  );
  return _architectConfig;
}

/** Update dreamer-specific LLM settings at runtime. */
export function updateDreamerLlmConfig(
  partial: Partial<{ model: string; temperature: number; maxTokens: number }>,
): void {
  const current = getDreamerLlmConfig();
  _dreamerConfig = { ...current, ...partial };
  logger.info(
    `LLM dreamer config updated: model=${_dreamerConfig.model}, temp=${_dreamerConfig.temperature}, maxTokens=${_dreamerConfig.maxTokens}`,
  );
}

/** Update normalizer-specific LLM settings at runtime. */
export function updateNormalizerLlmConfig(
  partial: Partial<{ model: string; temperature: number; maxTokens: number }>,
): void {
  const current = getNormalizerLlmConfig();
  _normalizerConfig = { ...current, ...partial };
  logger.info(
    `LLM normalizer config updated: model=${_normalizerConfig.model}, temp=${_normalizerConfig.temperature}, maxTokens=${_normalizerConfig.maxTokens}`,
  );
}

// ---------------------------------------------------------------------------
// Singleton — the active LLM provider
// ---------------------------------------------------------------------------

let _provider: LlmProvider | null = null;
let _samplingProvider: McpSamplingProvider | null = null;
let _config: LlmConfig | null = null;

function createJanFirstProvider(c: LlmConfig): LlmProvider {
  const sailResearchUrl = process.env.DREAMGRAPH_SAILRESEARCH_URL ?? "https://api.sailresearch.com/v1";
  const sailResearchApiKey = process.env.DREAMGRAPH_SAILRESEARCH_API_KEY ?? process.env.DREAMGRAPH_LLM_API_KEY ?? "";
  const sailResearchModel = process.env.DREAMGRAPH_SAILRESEARCH_MODEL ?? "google/gemma-4-31B-it";
  const jan = new OpenAiCompatibleProvider(c.baseUrl, c.model, c.apiKey, c.temperature, c.maxTokens, "jan", c.timeoutMs);
  const sailResearch = new OpenAiCompatibleProvider(
    sailResearchUrl,
    sailResearchModel,
    sailResearchApiKey,
    c.temperature,
    c.maxTokens,
    "sailresearch",
    c.timeoutMs,
  );
  return new JanFirstProvider(
    jan,
    sailResearch,
    envFlag("DREAMGRAPH_JAN_ENABLED", true),
    c.model,
    sailResearchModel,
  );
}

export function createLlmProviderForConfig(c: LlmConfig): LlmProvider {
  switch (c.provider) {
    case "jan":
      return createJanFirstProvider(c);
    case "ollama":
      return new OllamaProvider(c.baseUrl, c.model, c.temperature, c.maxTokens, c.timeoutMs);
    case "openai":
      if (!c.apiKey) {
        logger.warn("LLM: OpenAI provider configured but no API key set (DREAMGRAPH_LLM_API_KEY)");
      }
      return new OpenAiCompatibleProvider(c.baseUrl, c.model, c.apiKey, c.temperature, c.maxTokens, "openai", c.timeoutMs);
    case "lmstudio":
      return new OpenAiCompatibleProvider(c.baseUrl, c.model, c.apiKey, c.temperature, c.maxTokens, "lmstudio", c.timeoutMs);
    case "anthropic":
      if (!c.apiKey) {
        logger.warn("LLM: Anthropic provider configured but no API key set (DREAMGRAPH_LLM_API_KEY)");
      }
      return new AnthropicProvider(c.baseUrl, c.model, c.apiKey, c.temperature, c.maxTokens, c.timeoutMs);
    case "sampling":
      return new McpSamplingProvider();
    default:
      return new NullProvider();
  }
}

/** Initialize the LLM provider based on config. Call once at startup. */
export function initLlmProvider(cfg?: LlmConfig): LlmProvider {
  const c = cfg ?? parseLlmConfig();
  _config = c;

  // Clear per-component caches so they re-parse from the new base config
  // on next access. Without this, a provider change (e.g., ollama→openai)
  // via dashboard would leave stale model/temp values in memory.
  _dreamerConfig = null;
  _normalizerConfig = null;
  _architectConfig = null;

  switch (c.provider) {
    case "jan":
      _provider = createJanFirstProvider(c);
      break;
    case "ollama":
      _provider = new OllamaProvider(c.baseUrl, c.model, c.temperature, c.maxTokens, c.timeoutMs);
      break;
    case "openai":
      if (!c.apiKey) {
        logger.warn("LLM: OpenAI provider configured but no API key set (DREAMGRAPH_LLM_API_KEY)");
      }
      _provider = new OpenAiCompatibleProvider(c.baseUrl, c.model, c.apiKey, c.temperature, c.maxTokens, "openai", c.timeoutMs);
      break;
    case "lmstudio":
      _provider = new OpenAiCompatibleProvider(c.baseUrl, c.model, c.apiKey, c.temperature, c.maxTokens, "lmstudio", c.timeoutMs);
      break;
    case "anthropic":
      if (!c.apiKey) {
        logger.warn("LLM: Anthropic provider configured but no API key set (DREAMGRAPH_LLM_API_KEY)");
      }
      _provider = new AnthropicProvider(c.baseUrl, c.model, c.apiKey, c.temperature, c.maxTokens, c.timeoutMs);
      break;
    case "sampling":
      _samplingProvider = new McpSamplingProvider();
      _provider = _samplingProvider;
      break;
    default:
      _provider = new NullProvider();
      break;
  }

  logger.info(`LLM provider: ${c.provider} (model: ${c.model || "n/a"})`);
  return _provider;
}

/**
 * Inject the MCP Server reference for the sampling provider.
 * Call this after server.connect() when using provider="sampling".
 */
export function setMcpServerForSampling(server: unknown): void {
  if (_samplingProvider) {
    _samplingProvider.setServer(server);
  }
}

/** Get the active LLM provider. Initializes with defaults if not yet set. */
export function getLlmProvider(): LlmProvider {
  if (!_provider) {
    return initLlmProvider();
  }
  return _provider;
}

/** Get the current LLM config */
export function getLlmConfig(): LlmConfig {
  if (!_config) {
    _config = parseLlmConfig();
  }
  return _config;
}

function taskDefaultTemperature(task: LlmRouteTask): number {
  switch (task) {
    case "normalization":
      return 0.1;
    case "task_preamble_compilation":
      return 0.2;
    case "remediation_drafting":
      return 0.3;
    case "graph_enrichment":
      return 0.4;
    case "dream_generation":
      return 0.7;
    default:
      return getDreamerLlmConfig().temperature;
  }
}

function componentConfig(component: "dreamer" | "normalizer"): { model: string; temperature: number; maxTokens: number } {
  return component === "normalizer" ? getNormalizerLlmConfig() : getDreamerLlmConfig();
}

function fallbackSelection(
  request: LlmRouteRequest,
  fallbackReason: LlmRouteFallbackReason,
): LlmRouteSelection {
  return {
    layer: "deterministic_fallback",
    provider: null,
    model: null,
    options: {},
    provenance: {
      task: request.task,
      layer: "deterministic_fallback",
      provider: null,
      model: null,
      source: "deterministic_fallback",
      fallback_reason: fallbackReason,
    },
  };
}

/**
 * Select the ADR-203 model route for an LLM-enabled tool.
 *
 * Order is connected/caller model, daemon-side configured model, then deterministic fallback.
 * The returned provenance is intentionally compact and never includes prompt content or secrets.
 */
export async function selectLlmRoute(request: LlmRouteRequest): Promise<LlmRouteSelection> {
  const maxTokens = request.max_tokens;

  if (request.connected) {
    const available = await request.connected.provider.isAvailable().catch(() => false);
    if (available) {
      const connectedModel = request.connected.model?.trim();
      const model = connectedModel || request.connected.provider.name;
      return {
        layer: "connected",
        provider: request.connected.provider,
        model,
        options: { model, maxTokens },
        provenance: {
          task: request.task,
          layer: "connected",
          provider: request.connected.provider.name,
          model,
          source: request.connected.source,
        },
      };
    }
  }

  const provider = getLlmProvider();
  const cfg = getLlmConfig();

  if (cfg.provider === "sampling") {
    const available = await provider.isAvailable().catch(() => false);
    if (available) {
      return {
        layer: "connected",
        provider,
        model: "client",
        options: { model: "client", maxTokens },
        provenance: {
          task: request.task,
          layer: "connected",
          provider: provider.name,
          model: "client",
          source: "sampling",
        },
      };
    }
  } else if (cfg.provider !== "none") {
    const component = request.daemon_component ?? "dreamer";
    const componentCfg = componentConfig(component);
    const available = await provider.isAvailable().catch(() => false);
    const routeInfo = provider.getRouteInfo?.(componentCfg.model.trim());
    const daemonModel = (routeInfo?.model ?? componentCfg.model).trim();
    if (!daemonModel) {
      return fallbackSelection(request, "no_daemon_model");
    }

    if (available) {
      const temperature = request.daemon_temperature ?? taskDefaultTemperature(request.task);
      return {
        layer: "daemon",
        provider,
        model: daemonModel,
        options: {
          model: daemonModel,
          temperature,
          maxTokens: maxTokens ?? componentCfg.maxTokens,
        },
        provenance: {
          task: request.task,
          layer: "daemon",
          provider: routeInfo?.provider ?? provider.name,
          model: daemonModel,
          source: "daemon",
          temperature,
          ...(routeInfo?.fallbackReason ? { fallback_reason: routeInfo.fallbackReason } : {}),
        },
      };
    }

    return fallbackSelection(
      request,
      provider.getRouteInfo?.(componentCfg.model.trim())?.fallbackReason ?? "daemon_model_unavailable",
    );
  }

  return fallbackSelection(
    request,
    request.connected ? "connected_model_unavailable" : "no_connected_model",
  );
}

/** Normalize an LLM route failure into compact fallback provenance. */
export function llmRouteFailureReason(kind: "provider" | "invalid_output" | "validation"): LlmRouteFallbackReason {
  switch (kind) {
    case "provider":
      return "provider_failed";
    case "invalid_output":
      return "invalid_output";
    case "validation":
      return "validation_failed";
  }
}

/** Check if LLM dreaming is available */
export async function isLlmAvailable(): Promise<boolean> {
  const provider = getLlmProvider();
  return provider.isAvailable();
}
