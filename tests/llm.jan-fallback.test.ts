import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getArchitectLlmConfig,
  getLlmProvider,
  initLlmProvider,
  parseLlmConfig,
  selectLlmRoute,
} from "../src/cognitive/llm.js";

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const originals: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const baseEnv = {
  DREAMGRAPH_LLM_PROVIDER: "jan",
  DREAMGRAPH_JAN_ENABLED: "true",
  DREAMGRAPH_JAN_URL: "http://jan.test/v1",
  DREAMGRAPH_JAN_MODEL: "qwen3-coder-local",
  DREAMGRAPH_SAILRESEARCH_URL: "http://sail.test/v1",
  DREAMGRAPH_SAILRESEARCH_API_KEY: "sail-test-key",
  DREAMGRAPH_SAILRESEARCH_MODEL: "sail-fallback-model",
  DREAMGRAPH_LLM_DREAMER_MODEL: undefined,
  DREAMGRAPH_LLM_NORMALIZER_MODEL: undefined,
};

describe("Jan-first provider routing", () => {
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

  it("defaults to Jan with the local Qwen3 Coder route", async () => {
    await withEnv(
      {
        DREAMGRAPH_LLM_PROVIDER: undefined,
        DREAMGRAPH_JAN_ENABLED: undefined,
        DREAMGRAPH_JAN_URL: undefined,
        DREAMGRAPH_JAN_MODEL: undefined,
        DREAMGRAPH_LLM_MODEL: undefined,
      },
      () => {
        const config = parseLlmConfig();
        expect(config.provider).toBe("jan");
        expect(config.baseUrl).toBe("http://127.0.0.1:1338/v1");
        expect(config.model).toBe("Qwen3-Coder-30B-A3B-Instruct.gguf");
      },
    );
  });

  it("accepts Jan as an explicit Architect provider override", async () => {
    await withEnv(
      {
        ...baseEnv,
        DREAMGRAPH_LLM_PROVIDER: "ollama",
        DREAMGRAPH_LLM_ARCHITECT_PROVIDER: "jan",
        DREAMGRAPH_LLM_ARCHITECT_MODEL: "architect-jan-model",
        DREAMGRAPH_JAN_URL: "http://jan.override.test/v1",
      },
      () => {
        initLlmProvider();
        expect(getArchitectLlmConfig()).toMatchObject({
          provider: "jan",
          model: "architect-jan-model",
          baseUrl: "http://jan.override.test/v1",
        });
      },
    );
  });

  it("uses Jan first and does not probe SailResearch when Jan is available", async () => {
    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      expect(String(input)).toBe("http://jan.test/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "qwen3-coder-local" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await withEnv(baseEnv, async () => {
      initLlmProvider();
      const route = await selectLlmRoute({ task: "dream_generation" });

      expect(route.layer).toBe("daemon");
      expect(route.provider).toBe(getLlmProvider());
      expect(route.provider?.name).toBe("jan");
      expect(route.model).toBe("qwen3-coder-local");
      expect(route.provenance.provider).toBe("jan");
      expect(route.provenance.model).toBe("qwen3-coder-local");
      expect(route.provenance.fallback_reason).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it("falls directly from unavailable Jan to SailResearch", async () => {
    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      const url = String(input);
      if (url === "http://jan.test/v1/models") return new Response("offline", { status: 503 });
      expect(url).toBe("http://sail.test/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "sail-fallback-model" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await withEnv(baseEnv, async () => {
      initLlmProvider();
      const route = await selectLlmRoute({ task: "dream_generation" });

      expect(route.provider?.name).toBe("sailresearch");
      expect(route.model).toBe("sail-fallback-model");
      expect(route.provenance.provider).toBe("sailresearch");
      expect(route.provenance.fallback_reason).toBe("jan_unavailable");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it("skips Jan entirely when manually disabled and uses SailResearch", async () => {
    const fetchMock = vi.fn(async (input: Request | string | URL) => {
      expect(String(input)).toBe("http://sail.test/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "sail-fallback-model" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await withEnv({ ...baseEnv, DREAMGRAPH_JAN_ENABLED: "false" }, async () => {
      initLlmProvider();
      const route = await selectLlmRoute({ task: "dream_generation" });

      expect(route.provider?.name).toBe("sailresearch");
      expect(route.provenance.fallback_reason).toBe("jan_disabled");
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it("fails closed when neither Jan nor SailResearch is available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));

    await withEnv(baseEnv, async () => {
      initLlmProvider();
      const route = await selectLlmRoute({ task: "dream_generation" });

      expect(route.layer).toBe("deterministic_fallback");
      expect(route.provider).toBeNull();
      expect(route.provenance.fallback_reason).toBe("sailresearch_unavailable");
    });
  });
});
