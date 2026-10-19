/**
 * Video generation through `POST /v1/videos/generations`. Video is always a
 * job; the provider polls `GET /v1/jobs/{job_id}` until the video is ready and
 * returns its link.
 */
import { isApiKeyConfigured, requireApiKey } from "../auth.js";
import {
  findParameter,
  findRow,
  idsDefaultFirst,
  isVideoModel,
  loadCatalog,
  parameterOptions,
  peekCatalog,
  pickDefault,
  selectMediaModels,
  type CatalogRow,
} from "../catalog.js";
import { resolveBaseUrl } from "../config.js";
import { PROVIDER_ID, PROVIDER_LABEL } from "../constants.js";
import { extractOutputUrls, isJobEnvelope, pollJob, postJson } from "../http.js";
import type {
  VideoGenerationCapabilities,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "../types.js";
import type { MediaProviderDeps } from "./image.js";
import { clampInteger, extensionForMime, matchOption, mimeFromUrl, normalizeModelId, numberOrUndefined } from "./shared.js";

/** Video jobs usually take 1 to 15 minutes. */
export const DEFAULT_VIDEO_TIMEOUT_MS = 20 * 60_000;
const LABEL = `${PROVIDER_LABEL} video generation failed`;

type ModeCapabilities = NonNullable<VideoGenerationCapabilities["generate"]>;

function aspectRatios(row: CatalogRow): string[] {
  return parameterOptions(findParameter(row, "aspect_ratio")).filter(
    (option) => !["auto", "adaptive"].includes(option.toLowerCase()),
  );
}

/** "720p" -> "720P" and "2k" -> "2K"; other spellings such as "832x480" are kept. */
function displayResolution(option: string): string {
  return /^\d+[pk]$/iu.test(option) ? option.toUpperCase() : option;
}

type DurationSpec =
  | { kind: "range"; min?: number; max?: number }
  | { kind: "options"; options: Array<{ value: string; seconds: number }> };

function durationSpec(row: CatalogRow): DurationSpec | undefined {
  const parameter = findParameter(row, "duration");
  if (!parameter) {
    return undefined;
  }
  const options = parameterOptions(parameter)
    .map((value) => ({ value, seconds: Number.parseFloat(value) }))
    .filter((option) => Number.isFinite(option.seconds) && option.seconds > 0);
  if (options.length > 0) {
    return { kind: "options", options };
  }
  return {
    kind: "range",
    ...(numberOrUndefined(parameter.min) !== undefined ? { min: numberOrUndefined(parameter.min) } : {}),
    ...(numberOrUndefined(parameter.max) !== undefined ? { max: numberOrUndefined(parameter.max) } : {}),
  };
}

/** Capabilities of one video model, derived from its catalog parameters. */
export function videoModelCapabilities(row: CatalogRow): VideoGenerationCapabilities {
  const ratios = aspectRatios(row);
  const resolutions = parameterOptions(findParameter(row, "resolution")).map(displayResolution);
  const duration = durationSpec(row);
  const mode: ModeCapabilities = {
    maxVideos: 1,
    supportsAspectRatio: ratios.length > 0,
    supportsResolution: resolutions.length > 0,
    supportsAudio: Boolean(findParameter(row, "generate_audio")),
    ...(ratios.length > 0 ? { aspectRatios: ratios } : {}),
    ...(resolutions.length > 0 ? { resolutions } : {}),
  };
  if (duration?.kind === "options") {
    mode.supportedDurationSeconds = duration.options.map((option) => option.seconds);
    mode.maxDurationSeconds = Math.max(...duration.options.map((option) => option.seconds));
  } else if (duration?.max !== undefined) {
    mode.maxDurationSeconds = duration.max;
  }
  const acceptsImage = Boolean(findParameter(row, "image"));
  return {
    generate: mode,
    imageToVideo: acceptsImage
      ? { ...mode, enabled: true, maxInputImages: 1 }
      : { enabled: false },
    videoToVideo: { enabled: false },
  };
}

function buildCatalogByModel(rows: readonly CatalogRow[]): NonNullable<VideoGenerationProvider["catalogByModel"]> {
  const entries: Record<string, { capabilities: VideoGenerationCapabilities; modes: Array<"generate" | "imageToVideo"> }> = {};
  for (const row of rows) {
    const capabilities = videoModelCapabilities(row);
    entries[row.id] = {
      capabilities,
      modes: capabilities.imageToVideo?.enabled ? ["generate", "imageToVideo"] : ["generate"],
    };
  }
  return entries;
}

const PROVIDER_CAPABILITIES: VideoGenerationCapabilities = {
  generate: {
    maxVideos: 1,
    supportsAspectRatio: true,
    supportsResolution: true,
    supportsAudio: true,
  },
  imageToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputImages: 1,
    supportsAspectRatio: true,
    supportsResolution: true,
  },
  videoToVideo: {
    enabled: false,
  },
};

function pickDuration(row: CatalogRow | undefined, seconds: number | undefined): number | string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  const spec = row ? durationSpec(row) : { kind: "range" as const };
  if (!spec) {
    return undefined;
  }
  if (spec.kind === "options") {
    let best = spec.options[0];
    for (const option of spec.options) {
      if (!best || Math.abs(option.seconds - seconds) < Math.abs(best.seconds - seconds)) {
        best = option;
      }
    }
    return best?.value;
  }
  return clampInteger(seconds, spec.min, spec.max);
}

/** Builds the request body. Exported for tests. */
export function buildVideoBody(
  req: VideoGenerationRequest,
  model: string,
  row: CatalogRow | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, prompt: req.prompt };
  const image = req.inputImages?.[0];
  if (image) {
    const url = typeof image.url === "string" ? image.url.trim() : "";
    if (!/^https:\/\//iu.test(url)) {
      throw new Error(
        `${PROVIDER_LABEL} image-to-video needs the reference image as a public https URL.`,
      );
    }
    body.image = url;
  }
  if (req.aspectRatio && (!row || findParameter(row, "aspect_ratio"))) {
    const options = row ? aspectRatios(row) : [];
    const value = options.length > 0 ? matchOption(options, req.aspectRatio) : req.aspectRatio;
    if (value) {
      body.aspect_ratio = value;
    }
  }
  if (req.resolution && (!row || findParameter(row, "resolution"))) {
    const options = row ? parameterOptions(findParameter(row, "resolution")) : [];
    const value = options.length > 0 ? matchOption(options, String(req.resolution)) : String(req.resolution).toLowerCase();
    if (value) {
      body.resolution = value;
    }
  }
  const duration = pickDuration(row, req.durationSeconds);
  if (duration !== undefined) {
    body.duration = duration;
  }
  if (typeof req.audio === "boolean" && (!row || findParameter(row, "generate_audio"))) {
    body.generate_audio = req.audio;
  }
  return body;
}

export function buildVideoProvider(deps: MediaProviderDeps): VideoGenerationProvider {
  const currentRows = () => selectMediaModels(peekCatalog().rows).video;
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    defaultTimeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
    get defaultModel() {
      return pickDefault(currentRows())?.id;
    },
    get models() {
      return idsDefaultFirst(currentRows());
    },
    capabilities: PROVIDER_CAPABILITIES,
    get catalogByModel() {
      return buildCatalogByModel(currentRows());
    },
    isConfigured: (ctx) =>
      isApiKeyConfigured({
        ...(ctx.cfg ? { cfg: ctx.cfg } : {}),
        ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
      }),
    resolveModelCapabilities: async (ctx) => {
      const snapshot = await loadCatalog({
        baseUrl: resolveBaseUrl(ctx.cfg),
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      const id = normalizeModelId(ctx.model, undefined);
      const row = id ? findRow(snapshot.rows, id) : undefined;
      return row && isVideoModel(row) ? videoModelCapabilities(row) : undefined;
    },
    async generateVideo(req): Promise<VideoGenerationResult> {
      if ((req.inputVideos?.length ?? 0) > 0 || (req.inputAudios?.length ?? 0) > 0) {
        throw new Error(`${PROVIDER_LABEL} video generation in OpenClaw takes a prompt and an optional image.`);
      }
      const apiKey = await requireApiKey(deps.resolveApiKey, {
        cfg: req.cfg,
        ...(req.agentDir ? { agentDir: req.agentDir } : {}),
      });
      const baseUrl = resolveBaseUrl(req.cfg);
      const snapshot = await loadCatalog({ baseUrl, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) });
      const model = normalizeModelId(req.model, pickDefault(selectMediaModels(snapshot.rows).video)?.id);
      if (!model) {
        throw new Error(`No ${PROVIDER_LABEL} video model is available. Set one with the model option.`);
      }
      const row = findRow(snapshot.rows, model);
      const now = deps.now ?? Date.now;
      const deadline = now() + (req.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS);
      const submitted = await postJson<unknown>({
        url: `${baseUrl}/videos/generations`,
        apiKey,
        body: buildVideoBody(req, row?.id ?? model, row),
        label: LABEL,
        timeoutMs: 120_000,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      let result: unknown = submitted;
      let jobId: string | undefined;
      if (extractOutputUrls(submitted).length === 0) {
        if (!isJobEnvelope(submitted)) {
          throw new Error(`${LABEL}: the response did not include a job or a video`);
        }
        jobId = submitted.job_id;
        ({ result } = await pollJob({
          baseUrl,
          apiKey,
          jobId,
          label: `${PROVIDER_LABEL} video generation`,
          deadlineMs: Math.max(1_000, deadline - now()),
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        }));
      }
      const urls = extractOutputUrls(result);
      if (urls.length === 0) {
        throw new Error(`${LABEL}: the finished job did not include a video link`);
      }
      return {
        videos: urls.slice(0, 1).map((url, index) => {
          const mimeType = mimeFromUrl(url, "video/mp4");
          return { url, mimeType, fileName: `video-${index + 1}.${extensionForMime(mimeType, "mp4")}` };
        }),
        model: row?.id ?? model,
        metadata: { ...(jobId ? { jobId } : {}), url: urls[0] },
      };
    },
  };
}
