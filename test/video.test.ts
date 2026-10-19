import { beforeEach, describe, expect, it } from "vitest";
import { clearCatalogCacheForTests, loadCatalog } from "../src/catalog.js";
import { buildMediaCatalogProvider } from "../src/media/catalog-providers.js";
import { buildVideoBody, buildVideoProvider, videoModelCapabilities } from "../src/media/video.js";
import type { VideoGenerationRequest } from "../src/types.js";
import { API, CATALOG_ROWS, CDN, TEST_KEY, catalogResponse, createFetch, json, noSleep, sequence } from "./helpers.js";

beforeEach(() => clearCatalogCacheForTests());

const resolveApiKey = async () => TEST_KEY;
const request = (overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest =>
  ({ provider: "empiriolabs", model: "", prompt: "a paper boat in the rain", cfg: {}, ...overrides }) as VideoGenerationRequest;
const row = (id: string) => CATALOG_ROWS.find((r) => r.id === id)!;

describe("video generation", () => {
  it("submits the job, polls it, and returns the video link", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/videos/generations`, () => json({ job_id: "job_vid", status: "processing", poll_url: "/v1/jobs/job_vid" })],
      [
        "GET",
        `${API}/jobs/job_vid`,
        sequence(
          () => json({ job_id: "job_vid", status: "processing" }),
          () => json({ job_id: "job_vid", status: "completed", result: { data: [{ url: `${CDN}/clip.mp4` }] } }),
        ),
      ],
    ]);
    const provider = buildVideoProvider({ resolveApiKey, fetchFn, sleep: noSleep });
    const result = await provider.generateVideo(
      request({ resolution: "1080P", aspectRatio: "9:16", durationSeconds: 20, audio: true }),
    );
    expect(result).toEqual({
      videos: [{ url: `${CDN}/clip.mp4`, mimeType: "video/mp4", fileName: "video-1.mp4" }],
      model: "video-turbo",
      metadata: { jobId: "job_vid", url: `${CDN}/clip.mp4` },
    });
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({
      model: "video-turbo",
      prompt: "a paper boat in the rain",
      aspect_ratio: "9:16",
      resolution: "1080p",
      duration: 15,
      generate_audio: true,
    });
  });

  it("reports a failed job", async () => {
    const { fetchFn } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/videos/generations`, () => json({ job_id: "job_vid", status: "processing" })],
      ["GET", `${API}/jobs/job_vid`, () => json({ job_id: "job_vid", status: "failed", error: { message: "Content policy" } })],
    ]);
    const provider = buildVideoProvider({ resolveApiKey, fetchFn, sleep: noSleep });
    await expect(provider.generateVideo(request())).rejects.toThrow("job job_vid failed: Content policy");
  });

  it("sends an image link for image-to-video and refuses inline-only images", () => {
    expect(buildVideoBody(request({ inputImages: [{ url: "https://example.com/frame.png" }] }), "video-turbo", row("video-turbo"))).toMatchObject({
      image: "https://example.com/frame.png",
    });
    expect(() => buildVideoBody(request({ inputImages: [{ buffer: Buffer.from("x") }] }), "video-turbo", row("video-turbo"))).toThrow(
      "public https URL",
    );
  });

  it("maps durations to the model's own options", () => {
    expect(buildVideoBody(request({ durationSeconds: 7 }), "video-steps", row("video-steps"))).toMatchObject({ duration: "8s" });
    expect(buildVideoBody(request({ durationSeconds: 1 }), "video-turbo", row("video-turbo"))).toMatchObject({ duration: 3 });
    expect(buildVideoBody(request({ durationSeconds: 6 }), "unlisted", undefined)).toMatchObject({ duration: 6 });
  });

  it("derives per-model capabilities from catalog parameters", () => {
    expect(videoModelCapabilities(row("video-turbo"))).toMatchObject({
      generate: {
        maxVideos: 1,
        aspectRatios: ["16:9", "9:16", "1:1"],
        resolutions: ["720P", "1080P"],
        supportsAudio: true,
        maxDurationSeconds: 15,
      },
      imageToVideo: { enabled: true, maxInputImages: 1 },
      videoToVideo: { enabled: false },
    });
    expect(videoModelCapabilities(row("video-steps"))).toMatchObject({
      generate: { supportedDurationSeconds: [5, 8], maxDurationSeconds: 8 },
      imageToVideo: { enabled: false },
    });
  });

  it("does not take video or audio inputs", async () => {
    const provider = buildVideoProvider({ resolveApiKey });
    await expect(provider.generateVideo(request({ inputVideos: [{ url: "https://example.com/v.mp4" }] }))).rejects.toThrow(
      "takes a prompt and an optional image",
    );
  });

  it("resolves model capabilities only for video models", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, catalogResponse()]]);
    const provider = buildVideoProvider({ resolveApiKey, fetchFn });
    expect(await provider.resolveModelCapabilities!({ provider: "empiriolabs", model: "empiriolabs/video-turbo", cfg: {} } as never)).toBeDefined();
    expect(await provider.resolveModelCapabilities!({ provider: "empiriolabs", model: "chat-pro", cfg: {} } as never)).toBeUndefined();
  });
});

describe("media model catalogs", () => {
  it("lists live image and video models once a key is configured", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/models`, catalogResponse()]]);
    const ctx = { config: {}, env: {}, resolveProviderApiKey: () => ({ apiKey: TEST_KEY }) } as never;
    const images = await buildMediaCatalogProvider("image_generation", { fetchFn }).liveCatalog!(ctx);
    const videos = await buildMediaCatalogProvider("video_generation", { fetchFn }).liveCatalog!(ctx);
    expect(images?.map((entry) => [entry.model, entry.default ?? false])).toEqual([
      ["image-fast", true],
      ["image-sized", false],
    ]);
    expect(videos?.map((entry) => entry.model)).toEqual(["video-turbo", "video-steps"]);
    expect(videos?.[0]).toMatchObject({ kind: "video_generation", source: "live", modes: ["generate", "imageToVideo"] });
  });

  it("returns nothing without a key", async () => {
    const { fetchFn, calls } = createFetch([]);
    const ctx = { config: {}, env: {}, resolveProviderApiKey: () => ({ apiKey: undefined }) } as never;
    expect(await buildMediaCatalogProvider("image_generation", { fetchFn }).liveCatalog!(ctx)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("has a static catalog from the generated fallback", async () => {
    await loadCatalog({ fetchFn: createFetch([["GET", `${API}/models`, () => json({}, 500)]]).fetchFn });
    const entries = await buildMediaCatalogProvider("video_generation").staticCatalog!({} as never);
    expect(entries?.length).toBe(1);
    expect(entries?.[0]).toMatchObject({ source: "static", default: true });
  });
});
