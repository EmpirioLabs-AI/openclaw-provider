import { beforeEach, describe, expect, it } from "vitest";
import { clearCatalogCacheForTests, loadCatalog } from "../src/catalog.js";
import { buildImageBody, buildImageCapabilities, buildImageProvider } from "../src/media/image.js";
import type { ImageGenerationRequest } from "../src/types.js";
import {
  API,
  CATALOG_ROWS,
  CDN,
  PNG_BYTES,
  TEST_KEY,
  bytes,
  catalogResponse,
  createFetch,
  json,
  noSleep,
  sequence,
} from "./helpers.js";

beforeEach(() => clearCatalogCacheForTests());

const resolveApiKey = async () => TEST_KEY;
const request = (overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest =>
  ({ provider: "empiriolabs", model: "", prompt: "a lighthouse at dusk", cfg: {}, ...overrides }) as ImageGenerationRequest;
const row = (id: string) => CATALOG_ROWS.find((r) => r.id === id)!;

describe("image generation", () => {
  it("generates with sync mode and downloads the image", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/images/generations`, () => json({ created: 1, data: [{ url: `${CDN}/out.png` }] })],
      ["GET", `${CDN}/out.png`, () => bytes(PNG_BYTES, "image/png")],
    ]);
    const provider = buildImageProvider({ resolveApiKey, fetchFn, sleep: noSleep });
    const result = await provider.generateImage(request({ aspectRatio: "16:9" }));
    expect(result.model).toBe("image-fast");
    expect(result.images).toEqual([{ buffer: PNG_BYTES, mimeType: "image/png", fileName: "image-1.png" }]);
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(post.body).toEqual({ model: "image-fast", prompt: "a lighthouse at dusk", sync: true, response_format: "url", aspect_ratio: "16:9" });
    const download = calls.find((call) => call.url.startsWith(CDN))!;
    expect(download.headers.get("authorization")).toBeNull();
  });

  it("polls the job when the generation outlasts the wait window", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/images/generations`, () => json({ job_id: "job_img", status: "processing", poll_url: "/v1/jobs/job_img" })],
      [
        "GET",
        `${API}/jobs/job_img`,
        sequence(
          () => json({ job_id: "job_img", status: "processing" }),
          () => json({ job_id: "job_img", status: "completed", result: { data: [{ url: `${CDN}/late.png` }] } }),
        ),
      ],
      ["GET", `${CDN}/late.png`, () => bytes(PNG_BYTES, "image/png")],
    ]);
    const provider = buildImageProvider({ resolveApiKey, fetchFn, sleep: noSleep });
    const result = await provider.generateImage(request({ model: "empiriolabs/image-fast" }));
    expect(result.images).toHaveLength(1);
    expect(result.metadata).toEqual({ urls: [`${CDN}/late.png`], jobIds: ["job_img"] });
    expect(calls.filter((call) => call.url.endsWith("/jobs/job_img"))).toHaveLength(2);
  });

  it("decodes inline base64 images", async () => {
    const { fetchFn } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/images/generations`, () => json({ data: [{ b64_json: PNG_BYTES.toString("base64") }] })],
    ]);
    const provider = buildImageProvider({ resolveApiKey, fetchFn });
    const result = await provider.generateImage(request());
    expect(result.images[0]).toEqual({ buffer: PNG_BYTES, mimeType: "image/png", fileName: "image-1.png" });
  });

  it("splits a request for more images than the model returns per call", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      [
        "POST",
        `${API}/images/generations`,
        (call) => {
          const count = (call.body as { num_images?: number }).num_images ?? 1;
          return json({ data: Array.from({ length: count }, (_, i) => ({ url: `${CDN}/${calls.length}-${i}.png` })) });
        },
      ],
      ["GET", /^https:\/\/media\.example\.com\//, () => bytes(PNG_BYTES, "image/png")],
    ]);
    const provider = buildImageProvider({ resolveApiKey, fetchFn });
    const result = await provider.generateImage(request({ count: 3 }));
    expect(result.images).toHaveLength(3);
    const posts = calls.filter((call) => call.method === "POST").map((call) => (call.body as { num_images?: number }).num_images);
    expect(posts).toEqual([2, undefined]);
  });

  it("fails clearly without an API key, before any request", async () => {
    const { fetchFn, calls } = createFetch([]);
    const provider = buildImageProvider({ resolveApiKey: async () => undefined, fetchFn });
    await expect(provider.generateImage(request())).rejects.toThrow("EmpirioLabs AI API key missing");
    expect(calls).toHaveLength(0);
  });

  it("surfaces API errors", async () => {
    const { fetchFn } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/images/generations`, () => json({ error: { message: "Prompt was rejected by moderation" } }, 400)],
    ]);
    const provider = buildImageProvider({ resolveApiKey, fetchFn });
    await expect(provider.generateImage(request())).rejects.toThrow("(HTTP 400): Prompt was rejected by moderation");
  });

  it("does not accept reference images", async () => {
    const provider = buildImageProvider({ resolveApiKey });
    await expect(
      provider.generateImage(request({ inputImages: [{ buffer: PNG_BYTES, mimeType: "image/png" }] })),
    ).rejects.toThrow("text-to-image only");
  });
});

describe("image request mapping", () => {
  it("maps geometry to the model's own parameter values", () => {
    expect(buildImageBody(request({ resolution: "2K", aspectRatio: "3:2" }), "image-fast", row("image-fast"), 1)).toMatchObject({
      resolution: "2k",
      aspect_ratio: "3:2",
    });
    expect(buildImageBody(request({ size: "1536x1024" }), "image-fast", row("image-fast"), 1)).toMatchObject({ aspect_ratio: "3:2" });
    expect(buildImageBody(request({ size: "1536x1024" }), "image-sized", row("image-sized"), 1)).toMatchObject({ size: "1536x1024" });
    expect(buildImageBody(request({ aspectRatio: "4:3" }), "image-fast", row("image-fast"), 1)).not.toHaveProperty("aspect_ratio");
    expect(buildImageBody(request({ aspectRatio: "4:3" }), "unlisted", undefined, 1)).toMatchObject({ aspect_ratio: "4:3" });
  });

  it("derives per-model geometry capabilities from the catalog", () => {
    const capabilities = buildImageCapabilities(CATALOG_ROWS.filter((r) => r.category === "image"));
    expect(capabilities.edit.enabled).toBe(false);
    expect(capabilities.geometry?.aspectRatiosByModel).toEqual({ "image-fast": ["1:1", "16:9", "3:2"] });
    expect(capabilities.geometry?.resolutionsByModel).toEqual({ "image-fast": ["1K", "2K"] });
    expect(capabilities.geometry?.sizesByModel).toEqual({ "image-sized": ["1024x1024", "1536x1024"] });
  });

  it("lists live image models once the catalog is cached", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, catalogResponse()]]);
    const provider = buildImageProvider({ resolveApiKey });
    await loadCatalog({ fetchFn });
    expect(provider.models).toEqual(["image-fast", "image-sized"]);
    expect(provider.defaultModel).toBe("image-fast");
  });
});
