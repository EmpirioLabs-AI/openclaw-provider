/**
 * Image generation through `POST /v1/images/generations` with `sync: true`.
 * A generation that outlasts the API's wait window comes back as a job, which
 * is polled at `GET /v1/jobs/{job_id}`.
 */
import { requireApiKey, type ApiKeyResolver, type AvailabilityCheck } from "../auth.js";
import {
  findParameter,
  findRow,
  idsDefaultFirst,
  loadCatalog,
  parameterOptions,
  peekCatalog,
  pickDefault,
  selectMediaModels,
  type CatalogRow,
} from "../catalog.js";
import { resolveBaseUrl } from "../config.js";
import { PROVIDER_ID, PROVIDER_LABEL } from "../constants.js";
import {
  downloadFile,
  extractInlineBase64,
  extractOutputUrls,
  isJobEnvelope,
  pollJob,
  postJson,
  type FetchFn,
  type PollJobOptions,
} from "../http.js";
import type {
  EmpirioImageProvider,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from "../types.js";
import { extensionForMime, matchOption, normalizeModelId, sniffImageMime } from "./shared.js";

export const DEFAULT_IMAGE_TIMEOUT_MS = 300_000;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGES = 4;
const LABEL = `${PROVIDER_LABEL} image generation failed`;

export type MediaProviderDeps = {
  resolveApiKey: ApiKeyResolver;
  /** Awaited readiness check behind the providers' isConfiguredAsync hooks. */
  isAvailable: AvailabilityCheck;
  fetchFn?: FetchFn;
  sleep?: PollJobOptions["sleep"];
  now?: PollJobOptions["now"];
};

type ImageCapabilities = ImageGenerationProvider["capabilities"];

const RESOLUTIONS = new Set(["1K", "2K", "4K"]);

function aspectRatioOptions(row: CatalogRow): string[] {
  return parameterOptions(findParameter(row, "aspect_ratio")).filter(
    (option) => !["auto", "adaptive"].includes(option.toLowerCase()),
  );
}

/** Capability declaration derived from the catalog's per-model parameters. */
export function buildImageCapabilities(rows: readonly CatalogRow[]): ImageCapabilities {
  const aspectRatiosByModel: Record<string, string[]> = {};
  const resolutionsByModel: Record<string, Array<"1K" | "2K" | "4K">> = {};
  const sizesByModel: Record<string, string[]> = {};
  for (const row of rows) {
    const ratios = aspectRatioOptions(row);
    if (ratios.length > 0) {
      aspectRatiosByModel[row.id] = ratios;
    }
    const resolutions = parameterOptions(findParameter(row, "resolution"))
      .map((option) => option.toUpperCase())
      .filter((option): option is "1K" | "2K" | "4K" => RESOLUTIONS.has(option));
    if (resolutions.length > 0) {
      resolutionsByModel[row.id] = resolutions;
    }
    const sizes = parameterOptions(findParameter(row, "size"));
    if (sizes.length > 0) {
      sizesByModel[row.id] = sizes;
    }
  }
  return {
    generate: {
      maxCount: MAX_IMAGES,
      supportsSize: true,
      supportsAspectRatio: true,
      supportsResolution: true,
    },
    edit: {
      enabled: false,
    },
    geometry: {
      aspectRatiosByModel,
      resolutionsByModel,
      sizesByModel,
    },
  };
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/** "1536x1024" -> "3:2", matched against the model's aspect ratio options. */
function aspectRatioFromSize(size: string | undefined, options: readonly string[]): string | undefined {
  const match = /^(\d+)\s*[x*]\s*(\d+)$/iu.exec(size?.trim() ?? "");
  if (!match) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) {
    return undefined;
  }
  const divisor = greatestCommonDivisor(width, height);
  return matchOption(options, `${width / divisor}:${height / divisor}`);
}

function maxImagesPerRequest(row: CatalogRow | undefined): number {
  const parameter = row ? findParameter(row, "num_images") : undefined;
  if (row && !parameter) {
    return 1;
  }
  const max = typeof parameter?.max === "number" ? parameter.max : MAX_IMAGES;
  return Math.max(1, Math.min(MAX_IMAGES, Math.floor(max)));
}

/** Builds the request body for one call. Exported for tests. */
export function buildImageBody(
  req: ImageGenerationRequest,
  model: string,
  row: CatalogRow | undefined,
  count: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    sync: true,
    response_format: "url",
  };
  if (count > 1) {
    body.num_images = count;
  }
  const ratioParameter = row ? findParameter(row, "aspect_ratio") : undefined;
  const ratioOptions = row ? aspectRatioOptions(row) : [];
  if (req.aspectRatio && (!row || ratioParameter)) {
    const value = ratioOptions.length > 0 ? matchOption(ratioOptions, req.aspectRatio) : req.aspectRatio;
    if (value) {
      body.aspect_ratio = value;
    }
  }
  const sizeParameter = row ? findParameter(row, "size") : undefined;
  if (req.size) {
    if (!row || sizeParameter) {
      const sizeOptions = parameterOptions(sizeParameter);
      const value = sizeOptions.length > 0 ? matchOption(sizeOptions, req.size) : req.size;
      if (value) {
        body.size = value;
      }
    } else if (!body.aspect_ratio && ratioParameter) {
      const ratio = aspectRatioFromSize(req.size, ratioOptions);
      if (ratio) {
        body.aspect_ratio = ratio;
      }
    }
  }
  const resolutionParameter = row ? findParameter(row, "resolution") : undefined;
  if (req.resolution && (!row || resolutionParameter)) {
    const options = parameterOptions(resolutionParameter);
    const value = options.length > 0 ? matchOption(options, req.resolution) : req.resolution;
    if (value) {
      body.resolution = value;
    }
  }
  return body;
}

async function runImageRequest(params: {
  deps: MediaProviderDeps;
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  deadline: number;
  signal?: AbortSignal;
}): Promise<{ result: unknown; jobId?: string }> {
  const now = params.deps.now ?? Date.now;
  const remaining = () => Math.max(1_000, params.deadline - now());
  const first = await postJson<unknown>({
    url: `${params.baseUrl}/images/generations`,
    apiKey: params.apiKey,
    body: params.body,
    label: LABEL,
    timeoutMs: remaining(),
    ...(params.deps.fetchFn ? { fetchFn: params.deps.fetchFn } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const hasOutput = extractOutputUrls(first).length > 0 || extractInlineBase64(first).length > 0;
  if (hasOutput || !isJobEnvelope(first)) {
    return { result: first };
  }
  const { result } = await pollJob({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    jobId: first.job_id,
    label: `${PROVIDER_LABEL} image generation`,
    deadlineMs: remaining(),
    ...(params.deps.fetchFn ? { fetchFn: params.deps.fetchFn } : {}),
    ...(params.deps.sleep ? { sleep: params.deps.sleep } : {}),
    ...(params.deps.now ? { now: params.deps.now } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return { result, jobId: first.job_id };
}

export function buildImageProvider(deps: MediaProviderDeps): EmpirioImageProvider {
  const currentRows = () => selectMediaModels(peekCatalog().rows).image;
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    defaultTimeoutMs: DEFAULT_IMAGE_TIMEOUT_MS,
    get defaultModel() {
      return pickDefault(currentRows())?.id;
    },
    get models() {
      return idsDefaultFirst(currentRows());
    },
    get capabilities() {
      return buildImageCapabilities(currentRows());
    },
    // OpenClaw 2026.10.10 and newer call this; older hosts check the provider's
    // saved auth themselves when no readiness hook is present.
    isConfiguredAsync: (ctx) =>
      deps.isAvailable({
        ...(ctx.cfg ? { cfg: ctx.cfg } : {}),
        ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
      }),
    async generateImage(req): Promise<ImageGenerationResult> {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error(`${PROVIDER_LABEL} image generation in OpenClaw supports text-to-image only.`);
      }
      const apiKey = await requireApiKey(deps.resolveApiKey, {
        cfg: req.cfg,
        ...(req.agentDir ? { agentDir: req.agentDir } : {}),
      });
      const baseUrl = resolveBaseUrl(req.cfg);
      const snapshot = await loadCatalog({ baseUrl, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) });
      const imageRows = selectMediaModels(snapshot.rows).image;
      const model = normalizeModelId(req.model, pickDefault(imageRows)?.id);
      if (!model) {
        throw new Error(`No ${PROVIDER_LABEL} image model is available. Set one with the model option.`);
      }
      const row = findRow(snapshot.rows, model);
      const wanted = Math.max(1, Math.min(MAX_IMAGES, Math.floor(req.count ?? 1)));
      const perRequest = maxImagesPerRequest(row);
      const now = deps.now ?? Date.now;
      const deadline = now() + (req.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS);
      const images: ImageGenerationResult["images"] = [];
      const urls: string[] = [];
      const jobIds: string[] = [];
      while (images.length < wanted) {
        const count = Math.min(perRequest, wanted - images.length);
        const { result, jobId } = await runImageRequest({
          deps,
          baseUrl,
          apiKey,
          body: buildImageBody(req, row?.id ?? model, row, count),
          deadline,
        });
        if (jobId) {
          jobIds.push(jobId);
        }
        const before = images.length;
        for (const b64 of extractInlineBase64(result)) {
          const buffer = Buffer.from(b64, "base64");
          if (buffer.byteLength > 0) {
            const mimeType = sniffImageMime(buffer) ?? "image/png";
            images.push({
              buffer,
              mimeType,
              fileName: `image-${images.length + 1}.${extensionForMime(mimeType, "png")}`,
            });
          }
        }
        for (const url of extractOutputUrls(result)) {
          const file = await downloadFile({
            url,
            maxBytes: MAX_IMAGE_BYTES,
            defaultMimeType: "image/png",
            label: LABEL,
            timeoutMs: Math.max(1_000, deadline - now()),
            ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
          });
          urls.push(url);
          images.push({
            buffer: file.buffer,
            mimeType: file.mimeType,
            fileName: `image-${images.length + 1}.${extensionForMime(file.mimeType, "png")}`,
          });
        }
        if (images.length === before) {
          throw new Error(`${LABEL}: the response did not include an image`);
        }
      }
      return {
        images: images.slice(0, wanted),
        model: row?.id ?? model,
        metadata: {
          ...(urls.length > 0 ? { urls } : {}),
          ...(jobIds.length > 0 ? { jobIds } : {}),
        },
      };
    },
  };
}
