import { describe, expect, it } from "vitest";
import {
  EmpirioLabsApiError,
  downloadFile,
  extractInlineBase64,
  extractOutputUrls,
  pollJob,
  postJson,
  readApiErrorMessage,
} from "../src/http.js";
import { API, CDN, TEST_KEY, bytes, createFetch, json, noSleep, sequence } from "./helpers.js";

describe("API errors", () => {
  it("reads the message from the error envelope", () => {
    expect(readApiErrorMessage({ error: { message: "Unknown model", type: "invalid_request_error", code: "model_not_found" } })).toEqual({
      message: "Unknown model",
      code: "model_not_found",
    });
    expect(readApiErrorMessage({ detail: "Not found" })).toEqual({ message: "Not found" });
    expect(readApiErrorMessage("plain text")).toEqual({ message: "plain text" });
    expect(readApiErrorMessage(undefined)).toEqual({});
  });

  it("throws an EmpirioLabsApiError with the status and message", async () => {
    const { fetchFn } = createFetch([
      ["POST", `${API}/images/generations`, () => json({ error: { message: "Insufficient credits", code: "insufficient_quota" } }, 402)],
    ]);
    const error = (await postJson({ url: `${API}/images/generations`, apiKey: TEST_KEY, body: {}, label: "Request failed", fetchFn }).catch(
      (e: unknown) => e,
    )) as EmpirioLabsApiError;
    expect(error).toBeInstanceOf(EmpirioLabsApiError);
    expect(error.status).toBe(402);
    expect(error.code).toBe("insufficient_quota");
    expect(error.message).toBe("Request failed (HTTP 402): Insufficient credits");
    expect(error.message).not.toContain(TEST_KEY);
  });

  it("sends the bearer key, JSON body, and user agent", async () => {
    const { fetchFn, calls } = createFetch([["POST", `${API}/embeddings`, () => json({ ok: true })]]);
    await postJson({ url: `${API}/embeddings`, apiKey: TEST_KEY, body: { a: 1 }, label: "x", fetchFn });
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.headers.get("user-agent")).toMatch(/^@empiriolabs\/openclaw-provider\/\d+\.\d+\.\d+$/);
    expect(calls[0]!.body).toEqual({ a: 1 });
  });
});

describe("job polling", () => {
  const poll = (fetchFn: typeof fetch, deadlineMs = 60_000) =>
    pollJob({ baseUrl: API, apiKey: TEST_KEY, jobId: "job_1", label: "Video", deadlineMs, fetchFn, sleep: noSleep });

  it("waits through processing states and returns the result", async () => {
    const { fetchFn, calls } = createFetch([
      [
        "GET",
        `${API}/jobs/job_1`,
        sequence(
          () => json({ job_id: "job_1", status: "queued" }),
          () => json({ job_id: "job_1", status: "processing", partial: true, result: { data: [] } }),
          () => json({ job_id: "job_1", status: "completed", result: { data: [{ url: `${CDN}/v.mp4` }] } }),
        ),
      ],
    ]);
    const { result } = await poll(fetchFn);
    expect(result).toEqual({ data: [{ url: `${CDN}/v.mp4` }] });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.headers.get("authorization") === `Bearer ${TEST_KEY}`)).toBe(true);
  });

  it("reports a failed job with its message", async () => {
    const { fetchFn } = createFetch([
      ["GET", `${API}/jobs/job_1`, () => json({ job_id: "job_1", status: "failed", error: { message: "Prompt was rejected", code: 400 } })],
    ]);
    await expect(poll(fetchFn)).rejects.toThrow("Video: job job_1 failed: Prompt was rejected");
  });

  it("reports a cancelled job", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/jobs/job_1`, () => json({ job_id: "job_1", status: "cancelled" })]]);
    await expect(poll(fetchFn)).rejects.toThrow("job job_1 cancelled");
  });

  it("treats an unknown status as an error", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/jobs/job_1`, () => json({ job_id: "job_1", status: "mystery" })]]);
    await expect(poll(fetchFn)).rejects.toThrow('unexpected status "mystery"');
  });

  it("treats a completed job without a result as an error", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/jobs/job_1`, () => json({ job_id: "job_1", status: "completed" })]]);
    await expect(poll(fetchFn)).rejects.toThrow("completed without a result");
  });

  it("stops at the deadline", async () => {
    let now = 0;
    const { fetchFn } = createFetch([["GET", `${API}/jobs/job_1`, () => json({ job_id: "job_1", status: "processing" })]]);
    const promise = pollJob({
      baseUrl: API,
      apiKey: TEST_KEY,
      jobId: "job_1",
      label: "Video",
      deadlineMs: 10_000,
      fetchFn,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    await expect(promise).rejects.toThrow("did not finish within 10 s");
  });

  it("surfaces HTTP errors from the status endpoint", async () => {
    const { fetchFn } = createFetch([["GET", `${API}/jobs/job_1`, () => json({ detail: "Job 'job_1' not found" }, 404)]]);
    await expect(poll(fetchFn)).rejects.toThrow("job status request failed (HTTP 404): Job 'job_1' not found");
  });
});

describe("downloads", () => {
  it("downloads generated files without the API key", async () => {
    const { fetchFn, calls } = createFetch([["GET", `${CDN}/a.png`, () => bytes("png", "image/png")]]);
    const file = await downloadFile({ url: `${CDN}/a.png`, maxBytes: 100, defaultMimeType: "image/jpeg", label: "x", fetchFn });
    expect(file.buffer.toString()).toBe("png");
    expect(file.mimeType).toBe("image/png");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("refuses files over the size limit and invalid links", async () => {
    const { fetchFn } = createFetch([["GET", `${CDN}/big.mp4`, () => bytes(Buffer.alloc(200), "video/mp4")]]);
    await expect(downloadFile({ url: `${CDN}/big.mp4`, maxBytes: 100, defaultMimeType: "video/mp4", label: "x", fetchFn })).rejects.toThrow(
      "exceeds 100 bytes",
    );
    await expect(downloadFile({ url: "file:///etc/passwd", maxBytes: 100, defaultMimeType: "x", label: "x", fetchFn })).rejects.toThrow(
      "invalid file link",
    );
  });

  it("uses the default MIME type for generic binary responses", async () => {
    const { fetchFn } = createFetch([["GET", `${CDN}/a.bin`, () => bytes("x", "application/octet-stream")]]);
    const file = await downloadFile({ url: `${CDN}/a.bin`, maxBytes: 100, defaultMimeType: "audio/mpeg", label: "x", fetchFn });
    expect(file.mimeType).toBe("audio/mpeg");
  });
});

describe("result parsing", () => {
  it("collects output links and inline base64", () => {
    expect(extractOutputUrls({ data: [{ url: `${CDN}/1.png` }, { url: `${CDN}/1.png` }, { url: "ftp://x" }], url: `${CDN}/2.png` })).toEqual([
      `${CDN}/1.png`,
      `${CDN}/2.png`,
    ]);
    expect(extractInlineBase64({ data: [{ b64_json: "aGk=" }, {}] })).toEqual(["aGk="]);
    expect(extractOutputUrls(null)).toEqual([]);
  });
});
