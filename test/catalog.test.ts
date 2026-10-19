import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCost,
  clearCatalogCacheForTests,
  fallbackSnapshot,
  findRow,
  isChatModel,
  loadCatalog,
  peekCatalog,
  perMillion,
  pickDefaultChatModel,
  projectChatModels,
  selectMediaModels,
  toModelDefinition,
} from "../src/catalog.js";
import { FALLBACK_CATALOG } from "../src/generated/fallback-catalog.js";
import { API, CATALOG_ROWS, catalogResponse, createFetch, json } from "./helpers.js";

beforeEach(() => clearCatalogCacheForTests());

const byId = (id: string) => CATALOG_ROWS.find((row) => row.id === id)!;

describe("catalog classification", () => {
  it("offers only available text-category chat models as chat models", () => {
    const chat = CATALOG_ROWS.filter(isChatModel).map((row) => row.id);
    expect(chat).toEqual(["chat-pro", "chat-lite"]);
    expect(isChatModel(byId("search-answer"))).toBe(false);
    expect(isChatModel(byId("retired-chat"))).toBe(false);
    expect(isChatModel(byId("video-turbo"))).toBe(false);
  });

  it("selects media models from supported endpoints and inputs", () => {
    const media = selectMediaModels(CATALOG_ROWS);
    expect(media.image.map((row) => row.id)).toEqual(["image-fast", "image-sized"]);
    expect(media.video.map((row) => row.id)).toEqual(["video-turbo", "video-steps"]);
    expect(media.speech.map((row) => row.id)).toEqual(["voice-one"]);
    expect(media.transcription.map((row) => row.id)).toEqual(["stt-turbo"]);
    expect(media.embeddings.map((row) => row.id)).toEqual(["embed-v4"]);
  });

  it("picks the first featured chat model with tool calling as the default", () => {
    expect(pickDefaultChatModel(CATALOG_ROWS)?.id).toBe("chat-pro");
    const noFeatured = CATALOG_ROWS.map((row) => ({ ...row, is_featured: false }));
    expect(pickDefaultChatModel(noFeatured)?.id).toBe("chat-pro");
    const noTools = CATALOG_ROWS.filter((row) => row.id !== "chat-pro");
    expect(pickDefaultChatModel(noTools)?.id).toBe("chat-lite");
  });

  it("finds rows by id or alias, case-insensitively", () => {
    expect(findRow(CATALOG_ROWS, "CHAT-PRO")?.id).toBe("chat-pro");
    expect(findRow(CATALOG_ROWS, "vendor/chat-pro")?.id).toBe("chat-pro");
    expect(findRow(CATALOG_ROWS, "missing")).toBeUndefined();
  });
});

describe("chat model projection", () => {
  it("maps catalog fields to an OpenClaw model definition", () => {
    const model = toModelDefinition(byId("chat-pro"));
    expect(model).toMatchObject({
      id: "chat-pro",
      name: "Chat Pro",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      compat: {
        supportsTools: true,
        supportsUsageInStreaming: true,
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "low", "medium", "high", "max"],
        supportsJsonSchemaResponseFormat: true,
      },
    });
  });

  it("omits an unknown context window and uses a conservative output cap", () => {
    const model = toModelDefinition(byId("chat-lite"));
    expect(model).not.toHaveProperty("contextWindow");
    expect(model.maxTokens).toBe(8192);
    expect(model.input).toEqual(["text"]);
    expect(model.reasoning).toBe(false);
    expect(model.compat).toMatchObject({ supportsTools: false, supportsReasoningEffort: false });
  });

  it("converts per-token prices to USD per million tokens, with prompt-length tiers", () => {
    expect(perMillion("0.0000014")).toBe(1.4);
    expect(perMillion("bad")).toBe(0);
    expect(buildCost(byId("chat-lite"))).toEqual({ input: 1.4, output: 4.4, cacheRead: 1.4, cacheWrite: 0 });
    expect(buildCost(byId("chat-pro"))).toEqual({
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 0,
      tieredPricing: [
        { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0, range: [0, 272000] },
        { input: 10, output: 45, cacheRead: 1, cacheWrite: 0, range: [272000] },
      ],
    });
  });

  it("projects only chat models, in catalog order", () => {
    expect(projectChatModels(CATALOG_ROWS).map((model) => model.id)).toEqual(["chat-pro", "chat-lite"]);
  });
});

describe("live catalog loading", () => {
  it("reads the public listing without sending a credential and caches it", async () => {
    const { fetchFn, calls } = createFetch([["GET", `${API}/models`, catalogResponse()]]);
    const first = await loadCatalog({ fetchFn });
    const second = await loadCatalog({ fetchFn });
    expect(first.live).toBe(true);
    expect(first.rows).toHaveLength(CATALOG_ROWS.length);
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    expect(peekCatalog().live).toBe(true);
  });

  it("refreshes after the cache lifetime and shares one request between callers", async () => {
    let now = 1_000;
    const { fetchFn, calls } = createFetch([["GET", `${API}/models`, catalogResponse()]]);
    await Promise.all([loadCatalog({ fetchFn, now: () => now }), loadCatalog({ fetchFn, now: () => now })]);
    expect(calls).toHaveLength(1);
    now += 5 * 60 * 1000 + 1;
    await loadCatalog({ fetchFn, now: () => now });
    expect(calls).toHaveLength(2);
  });

  it("falls back to the generated catalog when the listing fails", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, () => json({ error: { message: "down" } }, 503)]]);
    const snapshot = await loadCatalog({ fetchFn });
    expect(snapshot.live).toBe(false);
    expect(snapshot.rows).toBe(FALLBACK_CATALOG.rows);
  });

  it("keeps the last good catalog when a refresh fails", async () => {
    let now = 0;
    let fail = false;
    const { fetchFn } = createFetch([
      ["GET", `${API}/models`, () => (fail ? json({}, 500) : catalogResponse()())],
    ]);
    const good = await loadCatalog({ fetchFn, now: () => now });
    fail = true;
    now += 10 * 60 * 1000;
    const after = await loadCatalog({ fetchFn, now: () => now });
    expect(after).toBe(good);
  });

  it("treats an empty listing as a failure", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, () => json({ data: [] })]]);
    expect((await loadCatalog({ fetchFn })).live).toBe(false);
  });
});

describe("generated offline fallback", () => {
  it("is generated, small, and covers every capability", () => {
    const snapshot = fallbackSnapshot();
    expect(FALLBACK_CATALOG.source).toMatch(/^https:\/\/api\.empiriolabs\.ai\/v1\/models$/);
    expect(FALLBACK_CATALOG.generatedAt).toBeTruthy();
    expect(snapshot.rows.length).toBeLessThanOrEqual(6);
    const media = selectMediaModels(snapshot.rows);
    expect(pickDefaultChatModel(snapshot.rows)).toBeDefined();
    expect(media.image.length).toBeGreaterThan(0);
    expect(media.video.length).toBeGreaterThan(0);
    expect(media.speech.length).toBeGreaterThan(0);
    expect(media.transcription.length).toBeGreaterThan(0);
    expect(media.embeddings.length).toBeGreaterThan(0);
  });
});
