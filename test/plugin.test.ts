import type { ProviderCatalogContext, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it } from "vitest";
import { clearCatalogCacheForTests, loadCatalog } from "../src/catalog.js";
import { FALLBACK_CATALOG } from "../src/generated/fallback-catalog.js";
import plugin from "../src/index.js";
import { buildTextProvider, resolveFromSnapshot } from "../src/provider.js";
import { API, CATALOG_ROWS, TEST_KEY, catalogResponse, createFakeApi, createFetch, json } from "./helpers.js";

beforeEach(() => clearCatalogCacheForTests());

function catalogContext(overrides: Partial<ProviderCatalogContext> = {}): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: TEST_KEY }),
    resolveProviderAuth: () => ({ apiKey: TEST_KEY, mode: "api_key", source: "env" }),
    ...overrides,
  } as ProviderCatalogContext;
}

describe("plugin entry", () => {
  it("registers the text provider and every capability under the empiriolabs id", () => {
    const { api, registered } = createFakeApi();
    plugin.register(api);
    expect(plugin.id).toBe("empiriolabs");
    expect(plugin.name).toBe("EmpirioLabs AI");
    const provider = registered.providers[0] as ProviderPlugin;
    expect(provider).toMatchObject({ id: "empiriolabs", label: "EmpirioLabs AI", envVars: ["EMPIRIOLABS_API_KEY"] });
    for (const list of [registered.image, registered.video, registered.speech, registered.media, registered.embeddings]) {
      expect(list).toHaveLength(1);
      expect((list[0] as { id: string }).id).toBe("empiriolabs");
    }
    const kinds = registered.catalogs.map((catalog) => (catalog as { kinds: string[] }).kinds[0]);
    expect(kinds).toEqual(["image_generation", "video_generation"]);
  });

  it("offers an API key auth choice with the documented flag and env var", () => {
    const provider = buildTextProvider();
    expect(provider.auth).toHaveLength(1);
    const method = provider.auth[0]!;
    expect(method.id).toBe("api-key");
    expect(method.kind).toBe("api_key");
    expect(method.wizard).toMatchObject({
      choiceId: "empiriolabs-api-key",
      groupId: "empiriolabs",
      groupLabel: "EmpirioLabs AI",
    });
  });
});

describe("text provider catalog", () => {
  it("returns live chat models with the resolved key", async () => {
    const { fetchFn, calls } = createFetch([["GET", `${API}/models`, catalogResponse()]]);
    const provider = buildTextProvider({ fetchFn });
    const result = await provider.catalog!.run(catalogContext());
    expect(result && "provider" in result).toBe(true);
    const config = (result as { provider: { baseUrl: string; api: string; apiKey: string; models: Array<{ id: string }> } }).provider;
    expect(config.baseUrl).toBe(API);
    expect(config.api).toBe("openai-completions");
    expect(config.apiKey).toBe(TEST_KEY);
    expect(config.models.map((model) => model.id)).toEqual(["chat-pro", "chat-lite"]);
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("returns nothing without a credential and does not call the API", async () => {
    const { fetchFn, calls } = createFetch([]);
    const provider = buildTextProvider({ fetchFn });
    const result = await provider.catalog!.run(catalogContext({ resolveProviderApiKey: () => ({ apiKey: undefined }) }));
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("skips catalog work for other providers", async () => {
    const { fetchFn, calls } = createFetch([]);
    const provider = buildTextProvider({ fetchFn });
    expect(await provider.catalog!.run(catalogContext({ providerIds: ["openai"] }))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("honors a configured base URL", async () => {
    const proxy = "https://proxy.example.com/v1";
    const { fetchFn } = createFetch([["GET", `${proxy}/models`, catalogResponse()]]);
    const provider = buildTextProvider({ fetchFn });
    const result = await provider.catalog!.run(
      catalogContext({ config: { models: { providers: { empiriolabs: { baseUrl: `${proxy}/`, models: [] } } } } as never }),
    );
    expect((result as { provider: { baseUrl: string } }).provider.baseUrl).toBe(proxy);
  });

  it("uses the generated fallback when the catalog is unreachable", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, () => json({}, 503)]]);
    const provider = buildTextProvider({ fetchFn });
    const result = await provider.catalog!.run(catalogContext());
    const ids = (result as { provider: { models: Array<{ id: string }> } }).provider.models.map((model) => model.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => FALLBACK_CATALOG.rows.some((row) => row.id === id))).toBe(true);
  });

  it("has a network-free static catalog built from the generated fallback", async () => {
    const { fetchFn, calls } = createFetch([]);
    const provider = buildTextProvider({ fetchFn });
    const result = await provider.staticCatalog!.run(catalogContext());
    const config = (result as { provider: { models: Array<{ id: string }>; apiKey?: string } }).provider;
    expect(config.models.length).toBe(1);
    expect(config.apiKey).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("model id resolution", () => {
  it("resolves chat models and aliases, never other categories", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, catalogResponse()]]);
    const snapshot = await loadCatalog({ fetchFn });
    expect(resolveFromSnapshot(snapshot, "vendor/chat-pro", API)).toMatchObject({
      id: "chat-pro",
      provider: "empiriolabs",
      api: "openai-completions",
      baseUrl: API,
    });
    expect(resolveFromSnapshot(snapshot, "video-turbo", API)).toBeUndefined();
    expect(resolveFromSnapshot(snapshot, "search-answer", API)).toBeUndefined();
    expect(resolveFromSnapshot(snapshot, "not-a-model", API)).toBeUndefined();
  });

  it("passes unknown ids through only when the live catalog is unavailable", () => {
    const fallback = { rows: FALLBACK_CATALOG.rows, live: false, fetchedAt: 0 };
    expect(resolveFromSnapshot(fallback, "brand-new-model", API)).toMatchObject({ id: "brand-new-model", provider: "empiriolabs" });
  });

  it("refreshes the catalog once for an id it has not seen", async () => {
    let rows = CATALOG_ROWS.filter((row) => row.id !== "chat-lite");
    const { fetchFn, calls } = createFetch([["GET", `${API}/models`, () => json({ data: rows })]]);
    await loadCatalog({ fetchFn });
    rows = CATALOG_ROWS;
    const provider = buildTextProvider({ fetchFn });
    const model = await provider.prepareDynamicModel!({ provider: "empiriolabs", modelId: "chat-lite", modelRegistry: {} } as never);
    expect(model).toMatchObject({ id: "chat-lite" });
    expect(calls).toHaveLength(2);
    expect(provider.resolveDynamicModel!({ provider: "empiriolabs", modelId: "video-turbo", modelRegistry: {} } as never)).toBeUndefined();
  });
});
