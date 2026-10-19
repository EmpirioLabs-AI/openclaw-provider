/**
 * OpenClaw types used by this plugin, derived only from the typed public
 * `openclaw/plugin-sdk/plugin-entry` surface so the plugin does not depend on
 * private SDK subpaths.
 */
import type {
  OpenClawPluginApi,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/plugin-entry";

export type ModelProviderConfig = Extract<
  NonNullable<ProviderCatalogResult>,
  { provider: unknown }
>["provider"];

export type ModelDefinitionConfig = ModelProviderConfig["models"][number];
export type ModelCost = ModelDefinitionConfig["cost"];
export type ModelCompat = NonNullable<ModelDefinitionConfig["compat"]>;

export type ImageGenerationProvider = Parameters<
  OpenClawPluginApi["registerImageGenerationProvider"]
>[0];
export type ImageGenerationRequest = Parameters<ImageGenerationProvider["generateImage"]>[0];
export type ImageGenerationResult = Awaited<ReturnType<ImageGenerationProvider["generateImage"]>>;

export type VideoGenerationProvider = Parameters<
  OpenClawPluginApi["registerVideoGenerationProvider"]
>[0];
export type VideoGenerationRequest = Parameters<VideoGenerationProvider["generateVideo"]>[0];
export type VideoGenerationResult = Awaited<ReturnType<VideoGenerationProvider["generateVideo"]>>;
export type VideoGenerationCapabilities = VideoGenerationProvider["capabilities"];

export type SpeechProvider = Exclude<
  Parameters<OpenClawPluginApi["registerSpeechProvider"]>[0],
  (...args: never[]) => unknown
>;
export type SpeechSynthesisRequest = Parameters<SpeechProvider["synthesize"]>[0];
export type SpeechSynthesisResult = Awaited<ReturnType<SpeechProvider["synthesize"]>>;

export type MediaUnderstandingProvider = Parameters<
  OpenClawPluginApi["registerMediaUnderstandingProvider"]
>[0];
export type AudioTranscriptionRequest = Parameters<
  NonNullable<MediaUnderstandingProvider["transcribeAudio"]>
>[0];

export type EmbeddingProviderAdapter = Parameters<OpenClawPluginApi["registerEmbeddingProvider"]>[0];
export type EmbeddingProviderCreateOptions = Parameters<EmbeddingProviderAdapter["create"]>[0];

export type ModelCatalogProvider = Parameters<OpenClawPluginApi["registerModelCatalogProvider"]>[0];

export type OpenClawConfig = OpenClawPluginApi["config"];

/** Context OpenClaw passes to image and video readiness hooks. */
export type MediaReadinessContext = { cfg?: OpenClawConfig; agentDir?: string };
export type SpeechReadinessContext = Parameters<SpeechProvider["isConfigured"]>[0];

/**
 * The awaited readiness hook. OpenClaw 2026.10.10 and newer call
 * `isConfiguredAsync` in place of the retired synchronous `isConfigured`; it is
 * declared here because the oldest supported host's types predate it.
 */
export type AsyncReadiness<Context> = { isConfiguredAsync?: (ctx: Context) => Promise<boolean> };

export type EmpirioImageProvider = ImageGenerationProvider & AsyncReadiness<MediaReadinessContext>;
export type EmpirioVideoProvider = VideoGenerationProvider & AsyncReadiness<MediaReadinessContext>;
export type EmpirioSpeechProvider = SpeechProvider & AsyncReadiness<SpeechReadinessContext>;
