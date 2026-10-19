import { beforeEach, describe, expect, it } from "vitest";
import { clearCatalogCacheForTests, loadCatalog } from "../src/catalog.js";
import { buildSpeechProvider } from "../src/media/speech.js";
import { buildTranscriptionProvider, transcribe } from "../src/media/transcription.js";
import type { AudioTranscriptionRequest, SpeechSynthesisRequest } from "../src/types.js";
import { API, CDN, TEST_KEY, bytes, catalogResponse, createFetch, json, noSleep, sequence, isAvailable } from "./helpers.js";

beforeEach(() => clearCatalogCacheForTests());

const resolveApiKey = async () => TEST_KEY;

describe("text to speech", () => {
  const speechRequest = (overrides: Partial<SpeechSynthesisRequest> = {}): SpeechSynthesisRequest =>
    ({ text: "Hello there.", cfg: {}, providerConfig: {}, target: "audio-file", timeoutMs: 30_000, ...overrides }) as SpeechSynthesisRequest;

  it("synthesizes with the default model and downloads the audio", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/audio/speech`, () => json({ data: [{ url: `${CDN}/speech.mp3`, duration: 1.2, format: "mp3" }] })],
      ["GET", `${CDN}/speech.mp3`, () => bytes("ID3audio", "audio/mpeg")],
    ]);
    const provider = buildSpeechProvider({ resolveApiKey, isAvailable, fetchFn });
    const result = await provider.synthesize(speechRequest());
    expect(result).toEqual({
      audioBuffer: Buffer.from("ID3audio"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.body).toEqual({ model: "voice-one", input: "Hello there.", output_format: "MP3" });
    expect(post.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  it("uses configured and per-message model and voice", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/audio/speech`, () => json({ data: [{ b64_json: Buffer.from("WAVE").toString("base64") }] })],
    ]);
    const provider = buildSpeechProvider({ resolveApiKey, isAvailable, fetchFn });
    const config = provider.resolveConfig!({ cfg: {}, rawConfig: { providers: { empiriolabs: { voice: "Sarah", outputFormat: "wav" } } }, timeoutMs: 1 } as never);
    const result = await provider.synthesize(speechRequest({ providerConfig: config, providerOverrides: { voice: "Charon" } }));
    expect(result.audioBuffer.toString()).toBe("WAVE");
    expect(result.outputFormat).toBe("wav");
    expect(calls.find((call) => call.method === "POST")!.body).toEqual({
      model: "voice-one",
      input: "Hello there.",
      voice: "Charon",
      output_format: "WAV",
    });
  });

  it("polls a speech job", async () => {
    const { fetchFn } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["POST", `${API}/audio/speech`, () => json({ job_id: "job_tts", status: "processing" })],
      ["GET", `${API}/jobs/job_tts`, () => json({ job_id: "job_tts", status: "completed", result: { data: [{ url: `${CDN}/long.mp3` }] } })],
      ["GET", `${CDN}/long.mp3`, () => bytes("ID3long", "audio/mpeg")],
    ]);
    const provider = buildSpeechProvider({ resolveApiKey, isAvailable, fetchFn, sleep: noSleep });
    expect((await provider.synthesize(speechRequest())).audioBuffer.toString()).toBe("ID3long");
  });

  it("lists voices for the selected model", async () => {
    const { fetchFn, calls } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      ["GET", `${API}/voices?model=voice-one`, () => json({ data: [{ id: "Sarah", name: "Sarah", gender: "female", language: "en-US" }, { nope: 1 }] })],
    ]);
    const provider = buildSpeechProvider({ resolveApiKey, isAvailable, fetchFn });
    expect(await provider.listVoices!({ cfg: {} })).toEqual([{ id: "Sarah", name: "Sarah", gender: "female", locale: "en-US" }]);
    expect(calls.find((call) => call.url.includes("/voices"))!.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  it("reads voice lists in each model's own response shape", async () => {
    const { fetchFn } = createFetch([
      ["GET", `${API}/models`, catalogResponse()],
      [
        "GET",
        `${API}/voices?model=voice-one`,
        () =>
          json({
            voices: [
              { voiceId: "Celeste", displayName: "Celeste", languages: ["en"], description: "Soft voice", isCustom: false },
              { voice_id: "Yash" },
            ],
          }),
      ],
    ]);
    const provider = buildSpeechProvider({ resolveApiKey, isAvailable, fetchFn });
    expect(await provider.listVoices!({ cfg: {} })).toEqual([
      { id: "Celeste", name: "Celeste", locale: "en", description: "Soft voice" },
      { id: "Yash" },
    ]);
  });

  it("answers readiness from speech settings, the awaited check, or configuration", async () => {
    let available = false;
    const provider = buildSpeechProvider({ resolveApiKey, isAvailable: async () => available });
    const context = (providerConfig: Record<string, unknown>, cfg: unknown = {}) => ({ cfg, providerConfig, timeoutMs: 1 }) as never;
    expect(await provider.isConfiguredAsync!(context({}))).toBe(false);
    expect(await provider.isConfiguredAsync!(context({ apiKey: "sk-speech" }))).toBe(true);
    available = true;
    expect(await provider.isConfiguredAsync!(context({}))).toBe(true);
    // The synchronous hook that hosts before 2026.10.10 require reads configuration only.
    const profileConfig = { auth: { profiles: { "empiriolabs:default": { provider: "empiriolabs", mode: "api_key" } } } };
    const savedEnv = process.env.EMPIRIOLABS_API_KEY;
    delete process.env.EMPIRIOLABS_API_KEY;
    try {
      expect(provider.isConfigured(context({}, {}))).toBe(false);
      expect(provider.isConfigured(context({}, profileConfig))).toBe(true);
      expect(provider.isConfigured(context({ apiKey: "sk-speech" }, {}))).toBe(true);
    } finally {
      if (savedEnv !== undefined) process.env.EMPIRIOLABS_API_KEY = savedEnv;
    }
  });

  it("lists live speech models once the catalog is cached", async () => {
    await loadCatalog({ fetchFn: createFetch([["GET", `${API}/models`, catalogResponse()]]).fetchFn });
    const provider = buildSpeechProvider({ resolveApiKey, isAvailable });
    expect(provider.models).toEqual(["voice-one"]);
    expect(provider.defaultModel).toBe("voice-one");
  });
});

describe("transcription", () => {
  const audio = Buffer.from("RIFFfakeWAVE");
  const transcriptionRequest = (overrides: Partial<AudioTranscriptionRequest> = {}): AudioTranscriptionRequest =>
    ({ buffer: audio, fileName: "note.wav", mime: "audio/wav", apiKey: TEST_KEY, timeoutMs: 60_000, model: "stt-turbo", ...overrides }) as AudioTranscriptionRequest;

  it("uploads the file, polls the job, and returns the transcript", async () => {
    const { fetchFn, calls } = createFetch([
      ["POST", `${API}/audio/transcriptions`, () => json({ job_id: "job_stt", status: "processing" }, 202)],
      [
        "GET",
        `${API}/jobs/job_stt`,
        sequence(
          () => json({ job_id: "job_stt", status: "processing" }),
          () => json({ job_id: "job_stt", status: "completed", result: { text: " Hello world. ", language: "en", duration: 1.1 } }),
        ),
      ],
    ]);
    const result = await transcribe(transcriptionRequest({ language: "en" }), { fetchFn, sleep: noSleep });
    expect(result).toEqual({ text: "Hello world.", model: "stt-turbo" });
    const upload = calls[0]!;
    expect(upload.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(upload.form?.get("model")).toBe("stt-turbo");
    expect(upload.form?.get("language")).toBe("en");
    expect(upload.form?.get("response_format")).toBe("json");
    const file = upload.form?.get("file") as File;
    expect(file.name).toBe("note.wav");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
  });

  it("accepts an immediate transcript", async () => {
    const { fetchFn } = createFetch([["POST", `${API}/audio/transcriptions`, () => json({ text: "Quick." })]]);
    expect(await transcribe(transcriptionRequest(), { fetchFn })).toEqual({ text: "Quick.", model: "stt-turbo" });
  });

  it("prefers the host-resolved auth object", async () => {
    const { fetchFn, calls } = createFetch([["POST", `${API}/audio/transcriptions`, () => json({ text: "ok" })]]);
    await transcribe(transcriptionRequest({ apiKey: "", auth: { kind: "api-key", apiKey: "sk-other" } }), { fetchFn });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-other");
  });

  it("reports a failed transcription job", async () => {
    const { fetchFn } = createFetch([
      ["POST", `${API}/audio/transcriptions`, () => json({ job_id: "job_stt", status: "processing" }, 202)],
      ["GET", `${API}/jobs/job_stt`, () => json({ job_id: "job_stt", status: "failed", error: { message: "Unsupported audio format" } })],
    ]);
    await expect(transcribe(transcriptionRequest(), { fetchFn, sleep: noSleep })).rejects.toThrow("Unsupported audio format");
  });

  it("registers audio transcription with a catalog default model", async () => {
    await loadCatalog({ fetchFn: createFetch([["GET", `${API}/models`, catalogResponse()]]).fetchFn });
    const provider = buildTranscriptionProvider({ resolveApiKey, isAvailable });
    expect(provider.capabilities).toEqual(["audio"]);
    expect(provider.defaultModels).toEqual({ audio: "stt-turbo" });
  });
});
