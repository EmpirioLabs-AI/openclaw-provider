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
