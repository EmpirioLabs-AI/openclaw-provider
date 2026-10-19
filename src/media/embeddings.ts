/** Embeddings through the OpenAI-compatible `POST /v1/embeddings`. */
import { requireApiKey } from "../auth.js";
import { peekCatalog, pickDefault, selectMediaModels } from "../catalog.js";
import { resolveBaseUrl } from "../config.js";
import { PROVIDER_ID, PROVIDER_LABEL } from "../constants.js";
import { postJson } from "../http.js";
import type { EmbeddingProviderAdapter, EmbeddingProviderCreateOptions } from "../types.js";
import type { MediaProviderDeps } from "./image.js";
import { normalizeModelId } from "./shared.js";

const LABEL = `${PROVIDER_LABEL} embeddings request failed`;
const EMBEDDING_TIMEOUT_MS = 60_000;

type EmbeddingInput = string | { text: string };

type EmbeddingsResponse = {
  data?: Array<{ index?: number; embedding?: unknown }>;
};

function defaultEmbeddingModel(): string | undefined {
  return pickDefault(selectMediaModels(peekCatalog().rows).embeddings)?.id;
}

function toText(input: EmbeddingInput): string {
  return typeof input === "string" ? input : input.text;
}

function readVectors(body: EmbeddingsResponse, expected: number): number[][] {
  const rows = Array.isArray(body.data) ? body.data : [];
  if (rows.length !== expected) {
    throw new Error(`${LABEL}: expected ${expected} embeddings, received ${rows.length}`);
  }
  const ordered = rows
    .map((row, position) => ({ index: typeof row.index === "number" ? row.index : position, embedding: row.embedding }))
    .sort((a, b) => a.index - b.index);
  return ordered.map(({ embedding }) => {
    if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
      throw new Error(`${LABEL}: the response included an invalid embedding`);
    }
    return embedding as number[];
  });
}

function remoteApiKey(options: EmbeddingProviderCreateOptions): string | undefined {
  const value = options.remote?.apiKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function buildEmbeddingAdapter(deps: MediaProviderDeps): EmbeddingProviderAdapter {
  const normalize = (model: string | undefined) => normalizeModelId(model, defaultEmbeddingModel()) ?? "";
  return {
    id: PROVIDER_ID,
    get defaultModel() {
      return defaultEmbeddingModel();
    },
    transport: "remote",
    authProviderId: PROVIDER_ID,
    normalizeModel: (options) => normalize(options.model),
    create: async (options) => {
      const model = normalize(options.model);
      if (!model) {
        throw new Error(`No ${PROVIDER_LABEL} embedding model is available. Set one in the memory settings.`);
      }
      const apiKey =
        remoteApiKey(options) ??
        (await requireApiKey(deps.resolveApiKey, {
          cfg: options.config,
          ...(options.agentDir ? { agentDir: options.agentDir } : {}),
        }));
      const baseUrl = resolveBaseUrl(options.config, options.remote?.baseUrl);
      const embedBatch = async (inputs: EmbeddingInput[], callOptions?: { signal?: AbortSignal }) => {
        if (inputs.length === 0) {
          return [];
        }
        const body = await postJson<EmbeddingsResponse>({
          url: `${baseUrl}/embeddings`,
          apiKey,
          body: { model, input: inputs.map(toText), encoding_format: "float" },
          label: LABEL,
          timeoutMs: EMBEDDING_TIMEOUT_MS,
          ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        });
        return readVectors(body, inputs.length);
      };
      return {
        provider: {
          id: PROVIDER_ID,
          model,
          embed: async (input, callOptions) => {
            const [vector] = await embedBatch([input], callOptions);
            if (!vector) {
              throw new Error(`${LABEL}: the response did not include an embedding`);
            }
            return vector;
          },
          embedBatch: (inputs, callOptions) => embedBatch(inputs, callOptions),
        },
        runtime: {
          id: PROVIDER_ID,
          cacheKeyData: { provider: PROVIDER_ID, model, baseUrl },
        },
      };
    },
  };
}
