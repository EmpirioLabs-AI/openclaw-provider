/**
 * Text to speech through `POST /v1/audio/speech`. The API answers with a link to
 * the audio file (or inline base64, or a job for long requests); the provider
 * returns the audio bytes.
 */
import { hasConfiguredApiKey, requireApiKey } from "../auth.js";
import {
  findParameter,
  findRow,
  idsDefaultFirst,
  loadCatalog,
  parameterOptions,
  peekCatalog,
  pickDefault,
  selectMediaModels,
} from "../catalog.js";
import { resolveBaseUrl } from "../config.js";
import { ENDPOINTS, PROVIDER_ID, PROVIDER_LABEL } from "../constants.js";
import {
  downloadFile,
  extractInlineBase64,
  extractOutputUrls,
  getJson,
  isJobEnvelope,
  pollJob,
  postJson,
} from "../http.js";
import type { EmpirioSpeechProvider, SpeechSynthesisResult } from "../types.js";
import type { MediaProviderDeps } from "./image.js";
import { matchOption, normalizeModelId } from "./shared.js";

export const DEFAULT_SPEECH_TIMEOUT_MS = 180_000;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const LABEL = `${PROVIDER_LABEL} speech synthesis failed`;
const PREFERRED_FORMAT = "mp3";

/** Normalized `tts.providers.empiriolabs` settings from openclaw.json. */
export type SpeechSettings = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  outputFormat?: string;
};

function readString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function readSpeechSettings(raw: Record<string, unknown> | undefined): SpeechSettings {
  const settings: SpeechSettings = {};
  const apiKey = readString(raw, "apiKey");
  const baseUrl = readString(raw, "baseUrl");
  const model = readString(raw, "model");
  const voice = readString(raw, "voice", "voiceId");
  const outputFormat = readString(raw, "outputFormat", "format");
  if (apiKey) settings.apiKey = apiKey;
  if (baseUrl) settings.baseUrl = baseUrl;
  if (model) settings.model = model;
  if (voice) settings.voice = voice;
  if (outputFormat) settings.outputFormat = outputFormat;
  return settings;
}

function voiceCompatible(format: string): boolean {
  return ["opus", "ogg"].includes(format.toLowerCase());
}

export function buildSpeechProvider(deps: MediaProviderDeps): EmpirioSpeechProvider {
  const currentRows = () => selectMediaModels(peekCatalog().rows).speech;
  const provider: EmpirioSpeechProvider = {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    defaultTimeoutMs: DEFAULT_SPEECH_TIMEOUT_MS,
    get defaultModel() {
      return pickDefault(currentRows())?.id;
    },
    get models() {
      return idsDefaultFirst(currentRows());
    },
    resolveConfig: ({ rawConfig }) => {
      const providers = asRecord(rawConfig.providers);
      const raw = asRecord(providers?.[PROVIDER_ID]) ?? asRecord(rawConfig[PROVIDER_ID]);
      return readSpeechSettings(raw);
    },
    // OpenClaw 2026.10.10 and newer call this awaited check.
    isConfiguredAsync: async ({ cfg, providerConfig }) =>
      Boolean(readSpeechSettings(providerConfig).apiKey) ||
      (await deps.isAvailable({ ...(cfg ? { cfg } : {}) })),
    // Required by hosts before OpenClaw 2026.10.10, which call it synchronously.
    // It reads configuration only (no credential store).
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(readSpeechSettings(providerConfig).apiKey) || hasConfiguredApiKey(cfg),
    listVoices: async (req) => {
      const settings = readSpeechSettings(req.providerConfig);
      const apiKey =
        req.apiKey ?? settings.apiKey ?? (await deps.resolveApiKey({ ...(req.cfg ? { cfg: req.cfg } : {}) }));
      if (!apiKey) {
        return [];
      }
      const baseUrl = resolveBaseUrl(req.cfg, req.baseUrl ?? settings.baseUrl);
      const snapshot = await loadCatalog({ baseUrl, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) });
      const model = normalizeModelId(settings.model, pickDefault(selectMediaModels(snapshot.rows).speech)?.id);
      const row = model ? findRow(snapshot.rows, model) : undefined;
      if (!row || !(row.supported_endpoints ?? []).includes(ENDPOINTS.voices)) {
        return [];
      }
      const body = await getJson<{ data?: unknown; voices?: unknown }>({
        url: `${baseUrl}/voices?model=${encodeURIComponent(row.id)}`,
        apiKey,
        label: `${PROVIDER_LABEL} voice list request failed`,
        ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      const list = Array.isArray(body.data) ? body.data : Array.isArray(body.voices) ? body.voices : [];
      return list.flatMap((item) => {
        const voice = asRecord(item);
        const id = readString(voice, "id", "voice_id", "voiceId", "name");
        if (!id) {
          return [];
        }
        const name = readString(voice, "name", "displayName", "display_name");
        const gender = readString(voice, "gender");
        const languages = Array.isArray(voice?.languages) ? voice.languages : [];
        const locale =
          readString(voice, "language", "locale") ??
          (typeof languages[0] === "string" && languages[0].trim() ? languages[0].trim() : undefined);
        const description = readString(voice, "description", "trait", "persona");
        return [
          {
            id,
            ...(name ? { name } : {}),
            ...(gender ? { gender } : {}),
            ...(locale ? { locale } : {}),
            ...(description ? { description } : {}),
          },
        ];
      });
    },
    synthesize: async (req): Promise<SpeechSynthesisResult> => {
      const settings = readSpeechSettings(req.providerConfig);
      const overrides = asRecord(req.providerOverrides);
      const apiKey = settings.apiKey ?? (await requireApiKey(deps.resolveApiKey, { cfg: req.cfg }));
      const baseUrl = resolveBaseUrl(req.cfg, settings.baseUrl);
      const snapshot = await loadCatalog({ baseUrl, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) });
      const model = normalizeModelId(
        readString(overrides, "model") ?? settings.model,
        pickDefault(selectMediaModels(snapshot.rows).speech)?.id,
      );
      if (!model) {
        throw new Error(`No ${PROVIDER_LABEL} speech model is available. Set one in the speech settings.`);
      }
      const row = findRow(snapshot.rows, model);
      const formatParameter = row ? findParameter(row, "output_format") : undefined;
      const formatOptions = parameterOptions(formatParameter);
      const requestedFormat = settings.outputFormat ?? PREFERRED_FORMAT;
      const format =
        formatOptions.length > 0
          ? (matchOption(formatOptions, requestedFormat) ?? matchOption(formatOptions, PREFERRED_FORMAT))
          : row && !formatParameter
            ? undefined
            : requestedFormat;
      const voice = readString(overrides, "voice", "voiceId") ?? settings.voice;
      const body: Record<string, unknown> = { model: row?.id ?? model, input: req.text };
      if (voice) {
        body.voice = voice;
      }
      if (format) {
        body.output_format = format;
      }
      const now = deps.now ?? Date.now;
      const timeoutMs = req.timeoutMs || DEFAULT_SPEECH_TIMEOUT_MS;
      const deadline = now() + timeoutMs;
      const first = await postJson<unknown>({
        url: `${baseUrl}/audio/speech`,
        apiKey,
        body,
        label: LABEL,
        timeoutMs,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      let result: unknown = first;
      if (extractOutputUrls(first).length === 0 && extractInlineBase64(first).length === 0 && isJobEnvelope(first)) {
        ({ result } = await pollJob({
          baseUrl,
          apiKey,
          jobId: first.job_id,
          label: `${PROVIDER_LABEL} speech synthesis`,
          deadlineMs: Math.max(1_000, deadline - now()),
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        }));
      }
      const outputFormat = (format ?? PREFERRED_FORMAT).toLowerCase();
      const inline = extractInlineBase64(result)[0];
      let audioBuffer: Buffer | undefined = inline ? Buffer.from(inline, "base64") : undefined;
      let fileFormat = outputFormat;
      if (!audioBuffer || audioBuffer.byteLength === 0) {
        const url = extractOutputUrls(result)[0];
        if (!url) {
          throw new Error(`${LABEL}: the response did not include audio`);
        }
        const file = await downloadFile({
          url,
          maxBytes: MAX_AUDIO_BYTES,
          defaultMimeType: "audio/mpeg",
          label: LABEL,
          timeoutMs: Math.max(1_000, deadline - now()),
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        });
        audioBuffer = file.buffer;
        const extension = URL.parse(url)?.pathname.split(".").pop()?.toLowerCase();
        if (extension && /^[a-z0-9]{2,5}$/u.test(extension)) {
          fileFormat = extension;
        }
      }
      return {
        audioBuffer,
        outputFormat: fileFormat,
        fileExtension: `.${fileFormat}`,
        voiceCompatible: voiceCompatible(fileFormat),
      };
    },
  };
  return provider;
}
