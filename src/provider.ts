/**
 * The EmpirioLabs AI text provider: API-key auth, the live chat model catalog,
 * and resolution of model ids that are not in the cached list yet.
 */
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPlugin,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import {
  findRow,
  isChatModel,
  loadCatalog,
  peekCatalog,
  pickDefaultChatModel,
  projectChatModels,
  toModelDefinition,
  fallbackSnapshot,
  type CatalogSnapshot,
} from "./catalog.js";
import { readConfiguredBaseUrl, resolveBaseUrl } from "./config.js";
import {
  API_KEY_ENV_VAR,
  API_KEYS_URL,
  AUTH_CHOICE_ID,
  AUTH_CLI_FLAG,
  AUTH_METHOD_ID,
  AUTH_OPTION_KEY,
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  PROVIDER_LABEL,
} from "./constants.js";
import type { FetchFn } from "./http.js";
import type { ModelProviderConfig } from "./types.js";

export const CHAT_API = "openai-completions" as const;

export type TextProviderDeps = {
  fetchFn?: FetchFn;
};

function modelRef(modelId: string): string {
  return `${PROVIDER_ID}/${modelId}`;
}

/** The default chat model ref from the generated offline fallback. */
export function fallbackDefaultModelRef(): string | undefined {
  const row = pickDefaultChatModel(fallbackSnapshot().rows);
  return row ? modelRef(row.id) : undefined;
}

function buildProviderConfig(snapshot: CatalogSnapshot, baseUrl: string): ModelProviderConfig {
  return {
    baseUrl,
    api: CHAT_API,
    models: projectChatModels(snapshot.rows),
  } as ModelProviderConfig;
}

/** Network-free provider config built from the generated fallback. */
export function buildStaticProviderConfig(): ModelProviderConfig {
  return buildProviderConfig(fallbackSnapshot(), DEFAULT_BASE_URL);
}

function servesProvider(ctx: ProviderCatalogContext): boolean {
  const ids = ctx.providerIds;
  return !ids || ids.some((id) => id.trim().toLowerCase() === PROVIDER_ID);
}

export function buildAuthMethod(deps: TextProviderDeps = {}) {
  const defaultModel = fallbackDefaultModelRef();
  return createProviderApiKeyAuthMethod({
    providerId: PROVIDER_ID,
    methodId: AUTH_METHOD_ID,
    label: `${PROVIDER_LABEL} API key`,
    hint: "Chat, image, video, speech, transcription, and embedding models",
    optionKey: AUTH_OPTION_KEY,
    flagName: AUTH_CLI_FLAG,
    envVar: API_KEY_ENV_VAR,
    promptMessage: `Enter your ${PROVIDER_LABEL} API key`,
    ...(defaultModel ? { defaultModel } : {}),
    resolveDefaultModel: async ({ signal }) => {
      const snapshot = await loadCatalog({
        ...(signal ? { signal } : {}),
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      const row = pickDefaultChatModel(snapshot.rows);
      return row ? modelRef(row.id) : undefined;
    },
    expectedProviders: [PROVIDER_ID],
    noteTitle: PROVIDER_LABEL,
    noteMessage: `Create an API key at ${API_KEYS_URL}`,
    wizard: {
      choiceId: AUTH_CHOICE_ID,
      choiceLabel: `${PROVIDER_LABEL} API key`,
      choiceHint: "Chat, image, video, speech, transcription, and embedding models",
      groupId: PROVIDER_ID,
      groupLabel: PROVIDER_LABEL,
      groupHint: "Chat, image, video, speech, transcription, and embedding models",
    },
  });
}

function toRuntimeModel(
  definition: ReturnType<typeof toModelDefinition>,
  baseUrl: string,
): ProviderRuntimeModel {
  return {
    ...definition,
    provider: PROVIDER_ID,
    api: CHAT_API,
    baseUrl,
  } as ProviderRuntimeModel;
}

/** A conservative chat model for an id the catalog could not confirm (catalog unreachable). */
function unconfirmedRuntimeModel(modelId: string, baseUrl: string): ProviderRuntimeModel {
  return {
    id: modelId,
    name: modelId,
    provider: PROVIDER_ID,
    api: CHAT_API,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 8_192,
    compat: {
      supportsTools: true,
      supportsUsageInStreaming: true,
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  } as ProviderRuntimeModel;
}

/**
 * Resolves a model id against a catalog snapshot. Chat models (by id or alias)
 * resolve; models from other categories (video, image, speech, ...) do not, so
 * they are never offered as chat models. An id missing from the live catalog
 * does not resolve; when only the offline fallback is available, unknown ids
 * pass through so the API can answer for them.
 */
export function resolveFromSnapshot(
  snapshot: CatalogSnapshot,
  modelId: string,
  baseUrl: string,
): ProviderRuntimeModel | undefined {
  const id = modelId.trim();
  if (!id) {
    return undefined;
  }
  const row = findRow(snapshot.rows, id);
  if (row) {
    return isChatModel(row) ? toRuntimeModel(toModelDefinition(row), baseUrl) : undefined;
  }
  return snapshot.live ? undefined : unconfirmedRuntimeModel(id, baseUrl);
}

function dynamicBaseUrl(ctx: ProviderResolveDynamicModelContext): string {
  const configured = (ctx.providerConfig as { baseUrl?: unknown } | undefined)?.baseUrl;
  return resolveBaseUrl(ctx.config, typeof configured === "string" ? configured : undefined);
}

export function buildTextProvider(deps: TextProviderDeps = {}): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    envVars: [API_KEY_ENV_VAR],
    auth: [buildAuthMethod(deps)],
    catalog: {
      order: "simple",
      run: async (ctx): Promise<ProviderCatalogResult> => {
        if (!servesProvider(ctx)) {
          return null;
        }
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
        if (!apiKey) {
          return null;
        }
        const baseUrl = readConfiguredBaseUrl(ctx.config) ?? DEFAULT_BASE_URL;
        const snapshot = await loadCatalog({
          baseUrl,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
        });
        return { provider: { ...buildProviderConfig(snapshot, baseUrl), apiKey } };
      },
    },
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildStaticProviderConfig() }),
    },
    resolveDynamicModel: (ctx) => {
      const baseUrl = dynamicBaseUrl(ctx);
      return resolveFromSnapshot(peekCatalog(baseUrl), ctx.modelId, baseUrl);
    },
    prepareDynamicModel: async (ctx) => {
      const baseUrl = dynamicBaseUrl(ctx);
      const cached = peekCatalog(baseUrl);
      const known = cached.live && findRow(cached.rows, ctx.modelId);
      const snapshot = await loadCatalog({
        baseUrl,
        forceRefresh: !known,
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      return resolveFromSnapshot(snapshot, ctx.modelId, baseUrl);
    },
  };
}
