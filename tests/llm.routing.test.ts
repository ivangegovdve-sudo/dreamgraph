import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getModelCapabilities,
  initLlmProvider,
  llmRouteFailureReason,
  parseLlmConfig,
  selectLlmRoute,
  type LlmProvider,
} from "../src/cognitive/llm.js";

function mockProvider(name: string, available: boolean): LlmProvider {
  return {
    name,
    isAvailable: vi.fn(async () => available),
    complete: vi.fn(async () => ({ text: "", model: name })),
  };
}

describe("getModelCapabilities", () => {
  it("declares GPT-5.5 as Responses API without temperature support", () => {
    expect(getModelCapabilities("openai", "gpt-5.5")).toEqual({
      model: "gpt-5.5",
      api: "responses",
      supportsTemperature: false,
      supportsReasoningEffort: true,
      supportsStructuredOutputs: true,
      supportsJsonSchema: true,
    });
  });

  it("keeps GPT-5.4 on Chat Completions with temperature support", () => {
    expect(getModelCapabilities("openai", "gpt-5.4")).toEqual({
      model: "gpt-5.4",
      api: "chat-completions",
      supportsTemperature: true,
      supportsReasoningEffort: false,
      supportsStructuredOutputs: true,
      supportsJsonSchema: true,
    });
  });
});

describe("OpenAI-compatible provider safety", () => {
  it("honors the configured model for an explicit compatible endpoint", async () => {
    await withEnv(
      {
        DREAMGRAPH_LLM_PROVIDER: "openai",
        DREAMGRAPH_LLM_URL: "http://127.0.0.1:1337/v1",
        DREAMGRAPH_LLM_API_KEY: undefined,
        DREAMGRAPH_LLM_MODEL: "qwen3-coder",
      },
      async () => {
        expect(parseLlmConfig()).toMatchObject({
          provider: "openai",
          baseUrl: "http://127.0.0.1:1337/v1",
          apiKey: "",
          model: "qwen3-coder",
        });
      },
    );
  });

  it("allows an explicit local compatible endpoint without an API key", async () => {
    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      expect(String(input)).toBe("http://127.0.0.1:1337/v1/models");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = initLlmProvider({
      provider: "openai",
      model: "qwen3-coder",
      baseUrl: "http://127.0.0.1:1337/v1",
      apiKey: "",
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 120_000,
    });

    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not probe api.openai.com when the default provider has no key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = initLlmProvider({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 120_000,
    });

    await expect(provider.isAvailable()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send a completion to the default OpenAI endpoint without a key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = initLlmProvider({
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 120_000,
    });

    await expect(provider.complete([{ role: "user", content: "hello" }])).rejects.toThrow(/DREAMGRAPH_LLM_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("selectLlmRoute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    initLlmProvider({
      provider: "none",
      model: "",
      baseUrl: "",
      apiKey: "",
      temperature: 0.7,
      maxTokens: 2048,
      timeoutMs: 120_000,
    });
  });

  it("prefers an available connected caller model without probing daemon config", async () => {
    const connected = mockProvider("architect-provider", true);

    const route = await selectLlmRoute({
      task: "task_preamble_compilation",
      max_tokens: 512,
      connected: {
        provider: connected,
        source: "architect",
        model: "connected-model",
      },
    });

    expect(route.layer).toBe("connected");
    expect(route.provider).toBe(connected);
    expect(route.model).toBe("connected-model");
    expect(route.options).toEqual({ model: "connected-model", maxTokens: 512 });
    expect(route.provenance).toEqual({
      task: "task_preamble_compilation",
      layer: "connected",
      provider: "architect-provider",
      model: "connected-model",
      source: "architect",
    });
    expect(connected.isAvailable).toHaveBeenCalledOnce();
  });

  it("falls through to an available daemon model when the connected model is unavailable", async () => {
    const connected = mockProvider("caller-provider", false);
    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      expect(String(input)).toBe("http://daemon.example/v1/models");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await withEnv(
      {
        DREAMGRAPH_LLM_PROVIDER: "openai",
        DREAMGRAPH_LLM_URL: "http://daemon.example/v1",
        DREAMGRAPH_LLM_API_KEY: "test-key",
        DREAMGRAPH_LLM_DREAMER_MODEL: "daemon-dreamer",
        DREAMGRAPH_LLM_DREAMER_MAX_TOKENS: "4096",
      },
      async () => {
        initLlmProvider();

        const route = await selectLlmRoute({
          task: "remediation_drafting",
          connected: {
            provider: connected,
            source: "caller",
            model: "offline-connected",
          },
        });

        expect(route.layer).toBe("daemon");
        expect(route.provider?.name).toBe("openai");
        expect(route.model).toBe("daemon-dreamer");
        expect(route.options).toEqual({
          model: "daemon-dreamer",
          temperature: 0.3,
          maxTokens: 4096,
        });
        expect(route.provenance).toEqual({
          task: "remediation_drafting",
          layer: "daemon",
          provider: "openai",
          model: "daemon-dreamer",
          source: "daemon",
          temperature: 0.3,
        });
      },
    );
  });

  it("uses normalizer daemon settings and caller max tokens when requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );

    await withEnv(
      {
        DREAMGRAPH_LLM_PROVIDER: "openai",
        DREAMGRAPH_LLM_URL: "http://daemon.example/v1",
        DREAMGRAPH_LLM_API_KEY: "test-key",
        DREAMGRAPH_LLM_NORMALIZER_MODEL: "daemon-normalizer",
        DREAMGRAPH_LLM_NORMALIZER_MAX_TOKENS: "1234",
      },
      async () => {
        initLlmProvider();

        const route = await selectLlmRoute({
          task: "normalization",
          daemon_component: "normalizer",
          max_tokens: 256,
        });

        expect(route.layer).toBe("daemon");
        expect(route.model).toBe("daemon-normalizer");
        expect(route.options).toEqual({
          model: "daemon-normalizer",
          temperature: 0.1,
          maxTokens: 256,
        });
      },
    );
  });

  it("returns deterministic fallback when no connected or daemon model is configured", async () => {
    await withEnv(
      {
        DREAMGRAPH_LLM_PROVIDER: "none",
      },
      async () => {
        initLlmProvider();

        const route = await selectLlmRoute({ task: "task_preamble_compilation" });

        expect(route.layer).toBe("deterministic_fallback");
        expect(route.provider).toBeNull();
        expect(route.model).toBeNull();
        expect(route.options).toEqual({});
        expect(route.provenance).toEqual({
          task: "task_preamble_compilation",
          layer: "deterministic_fallback",
          provider: null,
          model: null,
          source: "deterministic_fallback",
          fallback_reason: "no_connected_model",
        });
      },
    );
  });

  it("returns deterministic fallback when the configured daemon provider is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));

    await withEnv(
      {
        DREAMGRAPH_LLM_PROVIDER: "openai",
        DREAMGRAPH_LLM_URL: "http://daemon.example/v1",
        DREAMGRAPH_LLM_API_KEY: "test-key",
        DREAMGRAPH_LLM_DREAMER_MODEL: "daemon-dreamer",
      },
      async () => {
        initLlmProvider();

        const route = await selectLlmRoute({ task: "remediation_drafting" });

        expect(route.layer).toBe("deterministic_fallback");
        expect(route.provenance.fallback_reason).toBe("daemon_model_unavailable");
      },
    );
  });
});

describe("llmRouteFailureReason", () => {
  it("normalizes runtime failure classes into compact fallback reasons", () => {
    expect(llmRouteFailureReason("provider")).toBe("provider_failed");
    expect(llmRouteFailureReason("invalid_output")).toBe("invalid_output");
    expect(llmRouteFailureReason("validation")).toBe("validation_failed");
  });
});
