import { beforeEach, describe, expect, it } from "vitest";
import { clearCatalogCacheForTests, loadCatalog } from "../src/catalog.js";
import { buildEmbeddingAdapter } from "../src/media/embeddings.js";
import { API, TEST_KEY, catalogResponse, createFetch, json, isAvailable } from "./helpers.js";

beforeEach(() => clearCatalogCacheForTests());

describe("embeddings", () => {
  it("embeds a batch and returns vectors in input order", async () => {
    await loadCatalog({ fetchFn: createFetch([["GET", `${API}/models`, catalogResponse()]]).fetchFn });
    const { fetchFn, calls } = createFetch([
      [
        "POST",
        `${API}/embeddings`,
        () =>
          json({
            object: "list",
            data: [
              { object: "embedding", index: 1, embedding: [0, 1] },
              { object: "embedding", index: 0, embedding: [1, 0] },
            ],
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
      ],
    ]);
    const adapter = buildEmbeddingAdapter({ isAvailable, resolveApiKey: async () => TEST_KEY, fetchFn });
    expect(adapter.defaultModel).toBe("embed-v4");
    const { provider, runtime } = await adapter.create({ config: {}, model: "" });
    expect(provider?.model).toBe("embed-v4");
    expect(await provider!.embedBatch(["first", { text: "second" }])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0]!.body).toEqual({ model: "embed-v4", input: ["first", "second"], encoding_format: "float" });
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(runtime).toMatchObject({ id: "empiriolabs", cacheKeyData: { provider: "empiriolabs", model: "embed-v4" } });
  });

  it("embeds a single input and honors a remote key and model prefix", async () => {
    const { fetchFn, calls } = createFetch([["POST", `${API}/embeddings`, () => json({ data: [{ index: 0, embedding: [0.5] }] })]]);
    const adapter = buildEmbeddingAdapter({ isAvailable, resolveApiKey: async () => undefined, fetchFn });
    expect(adapter.normalizeModel!({ config: {}, model: "empiriolabs/embed-v4" })).toBe("embed-v4");
    const { provider } = await adapter.create({ config: {}, model: "empiriolabs/embed-v4", remote: { apiKey: "sk-remote" } });
    expect(await provider!.embed("hello")).toEqual([0.5]);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-remote");
  });

  it("rejects a response with the wrong number of vectors", async () => {
    const { fetchFn } = createFetch([["POST", `${API}/embeddings`, () => json({ data: [{ index: 0, embedding: [1] }] })]]);
    const adapter = buildEmbeddingAdapter({ isAvailable, resolveApiKey: async () => TEST_KEY, fetchFn });
    const { provider } = await adapter.create({ config: {}, model: "embed-v4" });
    await expect(provider!.embedBatch(["a", "b"])).rejects.toThrow("expected 2 embeddings, received 1");
  });

  it("requires an API key", async () => {
    const adapter = buildEmbeddingAdapter({ isAvailable, resolveApiKey: async () => undefined });
    await expect(adapter.create({ config: {}, model: "embed-v4" })).rejects.toThrow("EmpirioLabs AI API key missing");
  });
});
