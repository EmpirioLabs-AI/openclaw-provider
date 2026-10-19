/** Test helpers: a scripted fetch, a catalog fixture, and a fake plugin API. */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { CatalogRow } from "../src/catalog.js";

export const API = "https://api.empiriolabs.ai/v1";
export const CDN = "https://media.example.com";
export const TEST_KEY = "sk-empiriolabs-test-key";

export type RecordedCall = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  form?: FormData;
};

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** A fetch double that answers from a route table and records every call. */
export function createFetch(routes: Array<[method: string, match: string | RegExp, respond: Responder | Response | (() => Response)]>) {
  const calls: RecordedCall[] = [];
  const counts = new Map<number, number>();
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    let form: FormData | undefined;
    if (init?.body instanceof FormData) {
      form = init.body;
    } else if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = { url, method, headers: new Headers(init?.headers), body, ...(form ? { form } : {}) };
    calls.push(call);
    const index = routes.findIndex(
      ([routeMethod, match]) =>
        routeMethod.toUpperCase() === method && (typeof match === "string" ? url === match : match.test(url)),
    );
    if (index < 0) {
      throw new Error(`Unexpected request: ${method} ${url}`);
    }
    counts.set(index, (counts.get(index) ?? 0) + 1);
    const respond = routes[index]![2];
    if (respond instanceof Response) {
      return respond.clone();
    }
    return (respond as Responder)(call);
  }) as typeof fetch;
  return { fetchFn, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function bytes(data: Buffer | string, contentType: string): Response {
  const buffer = typeof data === "string" ? Buffer.from(data) : data;
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: { "Content-Type": contentType, "Content-Length": String(buffer.byteLength) },
  });
}

/** Responds with each item in turn, repeating the last one. */
export function sequence(...responses: Array<() => Response>): Responder {
  let index = 0;
  return () => {
    const factory = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return factory();
  };
}

export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

export const noSleep = async () => {};

/** Readiness check stub for provider tests. */
export const isAvailable = async () => true;

const chatEndpoints = ["POST /v1/chat/completions", "POST /v1/responses", "POST /v1/messages"];

export const CATALOG_ROWS: CatalogRow[] = [
  {
    id: "chat-pro",
    display_name: "Chat Pro",
    category: "text",
    status: "available",
    is_featured: true,
    supported_endpoints: chatEndpoints,
    input_modalities: ["text", "image", "video"],
    features: ["reasoning", "function_calling"],
    context_length: 1_000_000,
    max_output_tokens: 131_072,
    structured_output: "json_schema",
    pricing: [
      { prompt: "0.000005", completion: "0.00003", input_cache_read: "0.0000005" },
      { prompt: "0.00001", completion: "0.000045", input_cache_read: "0.000001", min_context: 272000 },
    ],
    supported_parameters: [
      { name: "max_tokens", type: "number" },
      { name: "reasoning_effort", type: "enum", options: ["none", "low", "medium", "high", "max"] },
    ],
    aliases: ["chat-pro-latest", "vendor/chat-pro"],
  },
  {
    id: "chat-lite",
    display_name: "Chat Lite",
    category: "text",
    status: "available",
    is_featured: false,
    supported_endpoints: chatEndpoints,
    input_modalities: ["text"],
    features: [],
    context_length: null,
    max_output_tokens: null,
    pricing: { prompt: "0.0000014", completion: "0.0000044" },
  },
  {
    id: "search-answer",
    display_name: "Search Answer",
    category: "research",
    status: "available",
    supported_endpoints: ["POST /v1/search", ...chatEndpoints],
    input_modalities: ["text"],
    features: ["web_search"],
  },
  {
    id: "retired-chat",
    category: "text",
    status: "unavailable",
    supported_endpoints: chatEndpoints,
  },
  {
    id: "image-fast",
    display_name: "Image Fast",
    category: "image",
    status: "available",
    is_featured: true,
    supported_endpoints: ["POST /v1/images/generations"],
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
    supported_parameters: [
      { name: "prompt", type: "string", required: true },
      { name: "aspect_ratio", type: "enum", options: ["auto", "1:1", "16:9", "3:2"] },
      { name: "resolution", type: "enum", options: ["1k", "2k"] },
      { name: "num_images", type: "number", min: 1, max: 2 },
    ],
  },
  {
    id: "image-sized",
    category: "image",
    status: "available",
    supported_endpoints: ["POST /v1/images/generations"],
    input_modalities: ["text"],
    supported_parameters: [{ name: "size", type: "enum", options: ["1024x1024", "1536x1024"] }],
  },
  {
    id: "video-turbo",
    display_name: "Video Turbo",
    category: "video",
    status: "available",
    is_featured: true,
    supported_endpoints: ["POST /v1/videos/generations"],
    input_modalities: ["text", "image"],
    output_modalities: ["video"],
    supported_parameters: [
      { name: "prompt", type: "string", required: true },
      { name: "image", type: "string" },
      { name: "resolution", type: "enum", options: ["720p", "1080p"] },
      { name: "aspect_ratio", type: "enum", options: ["16:9", "9:16", "1:1"] },
      { name: "duration", type: "number", min: 3, max: 15 },
      { name: "generate_audio", type: "boolean" },
    ],
  },
  {
    id: "video-steps",
    category: "video",
    status: "available",
    supported_endpoints: ["POST /v1/videos/generations"],
    input_modalities: ["text", "image"],
    supported_parameters: [{ name: "duration", type: "enum", options: ["5s", "8s"] }],
  },
  {
    id: "video-to-video",
    category: "video",
    status: "available",
    supported_endpoints: ["POST /v1/videos/generations"],
    input_modalities: ["text", "video"],
  },
  {
    id: "motion-transfer",
    category: "video",
    status: "available",
    supported_endpoints: ["POST /v1/videos/generations"],
    input_modalities: ["text", "image", "video"],
    supported_parameters: [
      { name: "prompt", required: true },
      { name: "reference_video", required: true },
    ],
  },
  {
    id: "voice-one",
    display_name: "Voice One",
    category: "audio",
    status: "available",
    is_featured: true,
    supported_endpoints: ["POST /v1/audio/speech", "GET /v1/voices"],
    input_modalities: ["text"],
    supported_parameters: [{ name: "output_format", type: "enum", options: ["MP3", "WAV"] }],
  },
  {
    id: "music-gen",
    category: "audio",
    status: "available",
    supported_endpoints: ["POST /v1/audio/generations"],
  },
  {
    id: "stt-turbo",
    category: "transcription",
    status: "available",
    is_featured: true,
    supported_endpoints: ["POST /v1/audio/transcriptions"],
    input_modalities: ["audio"],
  },
  {
    id: "proofread-video",
    category: "transcription",
    status: "available",
    supported_endpoints: ["POST /v1/audio/transcriptions"],
    input_modalities: ["video"],
  },
  {
    id: "embed-v4",
    category: "embedding",
    status: "available",
    supported_endpoints: ["POST /v1/embeddings"],
    input_modalities: ["text"],
  },
];

export function catalogResponse(rows: CatalogRow[] = CATALOG_ROWS): () => Response {
  return () => json({ object: "list", data: rows, catalog_version: "test" });
}

export type Registered = {
  providers: unknown[];
  image: unknown[];
  video: unknown[];
  speech: unknown[];
  media: unknown[];
  embeddings: unknown[];
  catalogs: unknown[];
};

/** A minimal plugin API that records registrations. */
export function createFakeApi(overrides: Partial<OpenClawPluginApi> = {}): { api: OpenClawPluginApi; registered: Registered } {
  const registered: Registered = { providers: [], image: [], video: [], speech: [], media: [], embeddings: [], catalogs: [] };
  const api = {
    id: "empiriolabs",
    name: "EmpirioLabs AI",
    source: "test",
    registrationMode: "full",
    config: {},
    runtime: {
      modelAuth: {
        resolveApiKeyForProvider: async () => ({ apiKey: TEST_KEY, source: "test", mode: "api-key" }),
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerProvider: (provider: unknown) => registered.providers.push(provider),
    registerImageGenerationProvider: (provider: unknown) => registered.image.push(provider),
    registerVideoGenerationProvider: (provider: unknown) => registered.video.push(provider),
    registerSpeechProvider: (provider: unknown) => registered.speech.push(provider),
    registerMediaUnderstandingProvider: (provider: unknown) => registered.media.push(provider),
    registerEmbeddingProvider: (provider: unknown) => registered.embeddings.push(provider),
    registerModelCatalogProvider: (provider: unknown) => registered.catalogs.push(provider),
    ...overrides,
  } as unknown as OpenClawPluginApi;
  return { api, registered };
}
