/**
 * Live model catalog: reads the public `GET /v1/models` listing, keeps it in a
 * short in-memory cache, and projects it into OpenClaw model rows. Chat models
 * are the rows in the `text` category that serve `POST /v1/chat/completions`;
 * image, video, speech, transcription, and embedding lists come from each
 * row's `supported_endpoints`. Nothing here is a hand-kept model list: when the
 * catalog cannot be reached, the generated offline fallback is used instead.
 */
import { DEFAULT_BASE_URL, ENDPOINTS, PROVIDER_LABEL } from "./constants.js";
import { FALLBACK_CATALOG } from "./generated/fallback-catalog.js";
import { getJson, trimTrailingSlash, type FetchFn } from "./http.js";
import type { ModelCompat, ModelCost, ModelDefinitionConfig } from "./types.js";

export type CatalogPricing = {
  prompt?: string | number | null;
  completion?: string | number | null;
  input_cache_read?: string | number | null;
  input_cache_write?: string | number | null;
  min_context?: number | null;
  [key: string]: unknown;
};

export type CatalogParameter = {
  name?: string;
  type?: string;
  required?: boolean;
  options?: unknown;
  default?: unknown;
  [key: string]: unknown;
};

/** The subset of a `GET /v1/models` row this plugin reads. */
export type CatalogRow = {
  id: string;
  display_name?: string | null;
  category?: string | null;
  status?: string | null;
  deprecated?: boolean | null;
  is_featured?: boolean | null;
  supported_endpoints?: readonly string[] | null;
  input_modalities?: readonly string[] | null;
  output_modalities?: readonly string[] | null;
  features?: readonly string[] | null;
  capabilities?: Record<string, unknown> | null;
  context_length?: number | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
  structured_output?: string | null;
  pricing?: CatalogPricing | readonly CatalogPricing[] | null;
  supported_parameters?: readonly CatalogParameter[] | null;
  aliases?: readonly string[] | null;
};

export type CatalogSnapshot = {
  rows: readonly CatalogRow[];
  /** `true` when the rows came from the live catalog, `false` for the generated fallback. */
  live: boolean;
  fetchedAt: number;
};

/** Live catalog cache lifetime. New models appear within this window. */
export const CATALOG_TTL_MS = 5 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

type CacheEntry = {
  snapshot?: CatalogSnapshot;
  expiresAt: number;
  pending?: Promise<CatalogSnapshot>;
};

const cache = new Map<string, CacheEntry>();

/** Test-only: forget every cached catalog. */
export function clearCatalogCacheForTests(): void {
  cache.clear();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readRows(body: unknown): CatalogRow[] {
  const data =
    body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : Array.isArray(body)
        ? body
        : undefined;
  if (!data) {
    throw new Error(`${PROVIDER_LABEL} model catalog response has no data array`);
  }
  const rows: CatalogRow[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const id = asString((item as { id?: unknown }).id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    rows.push({ ...(item as CatalogRow), id });
  }
  return rows;
}

/** Reads the public model catalog. The listing needs no API key, so none is sent. */
export async function fetchCatalogRows(params: {
  baseUrl?: string;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<CatalogRow[]> {
  const baseUrl = trimTrailingSlash(params.baseUrl ?? DEFAULT_BASE_URL);
  const body = await getJson<unknown>({
    url: `${baseUrl}/models`,
    label: `${PROVIDER_LABEL} model catalog request failed`,
    timeoutMs: params.timeoutMs ?? CATALOG_TIMEOUT_MS,
    ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const rows = readRows(body);
  if (rows.length === 0) {
    throw new Error(`${PROVIDER_LABEL} model catalog is empty`);
  }
  return rows;
}

/** The generated offline fallback as a catalog snapshot. */
export function fallbackSnapshot(): CatalogSnapshot {
  return { rows: FALLBACK_CATALOG.rows as readonly CatalogRow[], live: false, fetchedAt: 0 };
}

/**
 * Returns the cached live catalog, refreshing it when stale. On any failure the
 * last good snapshot is kept, or the generated fallback is returned.
 */
export async function loadCatalog(params: {
  baseUrl?: string;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  now?: () => number;
  forceRefresh?: boolean;
} = {}): Promise<CatalogSnapshot> {
  const baseUrl = trimTrailingSlash(params.baseUrl ?? DEFAULT_BASE_URL);
  const now = params.now ?? Date.now;
  const entry = cache.get(baseUrl) ?? { expiresAt: 0 };
  cache.set(baseUrl, entry);
  if (!params.forceRefresh && entry.snapshot && entry.expiresAt > now()) {
    return entry.snapshot;
  }
  if (entry.pending) {
    return entry.pending;
  }
  const pending = (async () => {
    try {
      const rows = await fetchCatalogRows({
        baseUrl,
        ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const snapshot: CatalogSnapshot = { rows, live: true, fetchedAt: now() };
      entry.snapshot = snapshot;
      entry.expiresAt = now() + CATALOG_TTL_MS;
      return snapshot;
    } catch {
      return entry.snapshot ?? fallbackSnapshot();
    } finally {
      entry.pending = undefined;
    }
  })();
  entry.pending = pending;
  return pending;
}

/** The most recent snapshot without any network access (live if cached, else the fallback). */
export function peekCatalog(baseUrl: string = DEFAULT_BASE_URL): CatalogSnapshot {
  return cache.get(trimTrailingSlash(baseUrl))?.snapshot ?? fallbackSnapshot();
}

// ---------------------------------------------------------------------------
// Row classification
// ---------------------------------------------------------------------------

export function isAvailable(row: CatalogRow): boolean {
  const status = asString(row.status)?.toLowerCase();
  return !status || status === "available";
}

function endpoints(row: CatalogRow): string[] {
  return asStringList(row.supported_endpoints);
}

function inputs(row: CatalogRow): string[] {
  return asStringList(row.input_modalities).map((value) => value.toLowerCase());
}

function features(row: CatalogRow): string[] {
  return asStringList(row.features).map((value) => value.toLowerCase());
}

function parameters(row: CatalogRow): CatalogParameter[] {
  return Array.isArray(row.supported_parameters)
    ? row.supported_parameters.filter((p): p is CatalogParameter => !!p && typeof p === "object")
    : [];
}

export function findParameter(row: CatalogRow, name: string): CatalogParameter | undefined {
  return parameters(row).find((parameter) => parameter.name === name);
}

export function parameterOptions(parameter: CatalogParameter | undefined): string[] {
  const options = parameter?.options;
  if (!Array.isArray(options)) {
    return [];
  }
  const values: string[] = [];
  for (const option of options) {
    if (typeof option === "string" || typeof option === "number") {
      values.push(String(option));
    } else if (option && typeof option === "object") {
      const value = (option as { value?: unknown }).value;
      if (typeof value === "string" || typeof value === "number") {
        values.push(String(value));
      }
    }
  }
  return values;
}

function category(row: CatalogRow): string {
  return asString(row.category)?.toLowerCase() ?? "";
}

/** Chat models: the `text` category rows that serve chat completions. */
export function isChatModel(row: CatalogRow): boolean {
  return isAvailable(row) && category(row) === "text" && endpoints(row).includes(ENDPOINTS.chat);
}

export function supportsTools(row: CatalogRow): boolean {
  return features(row).includes("function_calling");
}

export function isImageModel(row: CatalogRow): boolean {
  return isAvailable(row) && category(row) === "image" && endpoints(row).includes(ENDPOINTS.image);
}

/**
 * Video models offered for text-to-video and image-to-video: rows that serve
 * video generation, take a text prompt and an image, and require no input
 * beyond the prompt and image (so video-to-video, lip-sync, and
 * motion-transfer models are left out).
 */
export function isVideoModel(row: CatalogRow): boolean {
  if (!isAvailable(row) || !endpoints(row).includes(ENDPOINTS.video)) {
    return false;
  }
  const modalities = inputs(row);
  if (!modalities.includes("text") || !modalities.includes("image")) {
    return false;
  }
  const required = parameters(row)
    .filter((parameter) => parameter.required === true && typeof parameter.name === "string")
    .map((parameter) => parameter.name as string);
  return required.every((name) => name === "prompt" || name === "image");
}

export function isSpeechModel(row: CatalogRow): boolean {
  return isAvailable(row) && category(row) === "audio" && endpoints(row).includes(ENDPOINTS.speech);
}

export function isTranscriptionModel(row: CatalogRow): boolean {
  return (
    isAvailable(row) &&
    endpoints(row).includes(ENDPOINTS.transcription) &&
    inputs(row).includes("audio")
  );
}

export function isEmbeddingModel(row: CatalogRow): boolean {
  return isAvailable(row) && endpoints(row).includes(ENDPOINTS.embeddings);
}

/** The catalog's first featured row, or its first row. Catalog order is the default order. */
export function pickDefault(rows: readonly CatalogRow[]): CatalogRow | undefined {
  return rows.find((row) => row.is_featured === true) ?? rows[0];
}

/** Default chat model: the first featured chat model that supports tool calling. */
export function pickDefaultChatModel(rows: readonly CatalogRow[]): CatalogRow | undefined {
  const chat = rows.filter(isChatModel);
  return pickDefault(chat.filter(supportsTools)) ?? pickDefault(chat);
}

export type MediaCatalog = {
  image: CatalogRow[];
  video: CatalogRow[];
  speech: CatalogRow[];
  transcription: CatalogRow[];
  embeddings: CatalogRow[];
};

export function selectMediaModels(rows: readonly CatalogRow[]): MediaCatalog {
  return {
    image: rows.filter(isImageModel),
    video: rows.filter(isVideoModel),
    speech: rows.filter(isSpeechModel),
    transcription: rows.filter(isTranscriptionModel),
    embeddings: rows.filter(isEmbeddingModel),
  };
}

/** Orders rows with the default (first featured) row first, keeping catalog order otherwise. */
export function idsDefaultFirst(rows: readonly CatalogRow[]): string[] {
  const preferred = pickDefault(rows);
  const ids = rows.map((row) => row.id);
  if (!preferred) {
    return ids;
  }
  return [preferred.id, ...ids.filter((id) => id !== preferred.id)];
}

// ---------------------------------------------------------------------------
// Chat model projection
// ---------------------------------------------------------------------------

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** Converts a per-token USD price string to USD per million tokens. */
export function perMillion(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Number((number * 1_000_000).toPrecision(12));
}

function pricingTiers(row: CatalogRow): CatalogPricing[] {
  const pricing = row.pricing;
  if (Array.isArray(pricing)) {
    return pricing.filter((tier): tier is CatalogPricing => !!tier && typeof tier === "object");
  }
  if (pricing && typeof pricing === "object") {
    return [pricing as CatalogPricing];
  }
  return [];
}

function tierCost(tier: CatalogPricing): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const input = perMillion(tier.prompt);
  return {
    input,
    output: perMillion(tier.completion),
    cacheRead: tier.input_cache_read === undefined || tier.input_cache_read === null ? input : perMillion(tier.input_cache_read),
    cacheWrite: perMillion(tier.input_cache_write),
  };
}

/** Builds USD-per-million-token costs, including prompt-length tiers when the catalog lists them. */
export function buildCost(row: CatalogRow): ModelCost {
  const tiers = pricingTiers(row);
  const first = tiers[0];
  if (!first) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const base = tierCost(first);
  if (tiers.length < 2) {
    return base;
  }
  const starts = tiers.map((tier, index) =>
    index === 0 ? 0 : (positiveInteger(tier.min_context) ?? Number.NaN),
  );
  const ordered = starts.every((start, index) => index === 0 || (Number.isFinite(start) && start > (starts[index - 1] ?? 0)));
  if (!ordered) {
    return base;
  }
  const tieredPricing = tiers.map((tier, index) => {
    const start = starts[index] ?? 0;
    const next = starts[index + 1];
    return {
      ...tierCost(tier),
      range: (next === undefined ? [start] : [start, next]) as [number] | [number, number],
    };
  });
  return { ...base, tieredPricing } as ModelCost;
}

function buildCompat(row: CatalogRow): ModelCompat {
  const reasoningEffort = findParameter(row, "reasoning_effort");
  const efforts = parameterOptions(reasoningEffort);
  const compat: Record<string, unknown> = {
    supportsTools: supportsTools(row),
    supportsUsageInStreaming: true,
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: false,
    supportsPromptCacheKey: false,
    maxTokensField: "max_tokens",
    supportsReasoningEffort: Boolean(reasoningEffort),
    supportsJsonSchemaResponseFormat: asString(row.structured_output) === "json_schema",
  };
  if (efforts.length > 0) {
    compat.supportedReasoningEfforts = efforts;
  }
  return compat as ModelCompat;
}

/** Projects one chat catalog row into an OpenClaw model definition. */
export function toModelDefinition(row: CatalogRow): ModelDefinitionConfig {
  const capabilities = row.capabilities ?? {};
  const reasoning = features(row).includes("reasoning") || capabilities.reasoning === true;
  const vision = inputs(row).includes("image");
  const contextWindow = positiveInteger(row.context_length) ?? positiveInteger(row.context_window);
  const definition: Record<string, unknown> = {
    id: row.id,
    name: asString(row.display_name) ?? row.id,
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    cost: buildCost(row),
    maxTokens: positiveInteger(row.max_output_tokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
    compat: buildCompat(row),
  };
  if (contextWindow !== undefined) {
    definition.contextWindow = contextWindow;
  }
  return definition as ModelDefinitionConfig;
}

/** Chat model rows for OpenClaw, in catalog order. */
export function projectChatModels(rows: readonly CatalogRow[]): ModelDefinitionConfig[] {
  return rows.filter(isChatModel).map(toModelDefinition);
}

/** Finds a catalog row by id or by one of its aliases (case-insensitive). */
export function findRow(rows: readonly CatalogRow[], modelId: string): CatalogRow | undefined {
  const wanted = modelId.trim().toLowerCase();
  if (!wanted) {
    return undefined;
  }
  return (
    rows.find((row) => row.id.toLowerCase() === wanted) ??
    rows.find((row) => asStringList(row.aliases).some((alias) => alias.toLowerCase() === wanted))
  );
}
