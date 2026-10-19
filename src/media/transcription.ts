/**
 * Audio transcription through `POST /v1/audio/transcriptions` (multipart
 * upload). Every transcription request returns a job; the provider polls
 * `GET /v1/jobs/{job_id}` and returns the transcript text.
 */
import { pickDefault, selectMediaModels, peekCatalog, type CatalogRow } from "../catalog.js";
import { resolveBaseUrl } from "../config.js";
import { PROVIDER_ID, PROVIDER_LABEL } from "../constants.js";
import { isJobEnvelope, pollJob, postForm, type FetchFn } from "../http.js";
import type { AudioTranscriptionRequest, MediaUnderstandingProvider } from "../types.js";
import type { MediaProviderDeps } from "./image.js";
import { normalizeModelId } from "./shared.js";

export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 300_000;
const LABEL = `${PROVIDER_LABEL} transcription failed`;

function readTranscript(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.transcript === "string") {
    return record.transcript;
  }
  const nested = record.result;
  return nested && nested !== result ? readTranscript(nested) : undefined;
}

export function defaultTranscriptionModel(rows: readonly CatalogRow[]): string | undefined {
  return pickDefault(selectMediaModels(rows).transcription)?.id;
}

/** Transcribes one audio file. Exported for tests. */
export async function transcribe(
  req: AudioTranscriptionRequest,
  deps: Pick<MediaProviderDeps, "sleep" | "now"> & { fetchFn?: FetchFn },
): Promise<{ text: string; model: string }> {
  const apiKey = req.auth?.kind === "api-key" ? req.auth.apiKey : req.apiKey;
  if (!apiKey) {
    throw new Error(`${PROVIDER_LABEL} API key missing for transcription.`);
  }
  const model = normalizeModelId(req.model, defaultTranscriptionModel(peekCatalog().rows));
  if (!model) {
    throw new Error(`No ${PROVIDER_LABEL} transcription model is available. Set one in the audio settings.`);
  }
  const baseUrl = resolveBaseUrl(undefined, req.baseUrl);
  const fetchFn = deps.fetchFn ?? req.fetchFn;
  const now = deps.now ?? Date.now;
  const timeoutMs = req.timeoutMs || DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const form = new FormData();
  form.set("model", model);
  form.set("file", new Blob([new Uint8Array(req.buffer)], { type: req.mime || "application/octet-stream" }), req.fileName || "audio");
  form.set("response_format", "json");
  if (req.language?.trim()) {
    form.set("language", req.language.trim());
  }
  if (req.prompt?.trim()) {
    form.set("prompt", req.prompt.trim());
  }
  const submitted = await postForm<unknown>({
    url: `${baseUrl}/audio/transcriptions`,
    apiKey,
    form,
    label: LABEL,
    timeoutMs,
    ...(fetchFn ? { fetchFn } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  let result: unknown = submitted;
  let text = isJobEnvelope(submitted) ? undefined : readTranscript(submitted);
  if (text === undefined) {
    if (!isJobEnvelope(submitted)) {
      throw new Error(`${LABEL}: the response did not include a transcript or a job`);
    }
    ({ result } = await pollJob({
      baseUrl,
      apiKey,
      jobId: submitted.job_id,
      label: `${PROVIDER_LABEL} transcription`,
      deadlineMs: Math.max(1_000, deadline - now()),
      ...(fetchFn ? { fetchFn } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }));
    text = readTranscript(result);
  }
  if (typeof text !== "string") {
    throw new Error(`${LABEL}: the finished job did not include a transcript`);
  }
  return { text: text.trim(), model };
}

export function buildTranscriptionProvider(deps: MediaProviderDeps): MediaUnderstandingProvider {
  const provider: MediaUnderstandingProvider = {
    id: PROVIDER_ID,
    capabilities: ["audio"],
    get defaultModels() {
      const model = defaultTranscriptionModel(peekCatalog().rows);
      return model ? { audio: model } : {};
    },
    autoPriority: { audio: 50 },
    transcribeAudio: (req) =>
      transcribe(req, {
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      }),
  };
  return provider;
}
