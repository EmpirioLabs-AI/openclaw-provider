/**
 * EmpirioLabs AI provider plugin for OpenClaw.
 *
 * Registers the `empiriolabs` text provider (OpenAI-compatible chat
 * completions with the live model catalog) plus image generation, video
 * generation, text to speech, audio transcription, and embeddings, and the
 * chat, image, and video model lists for OpenClaw's pickers.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createApiKeyResolver, createAvailabilityCheck } from "./auth.js";
import { PROVIDER_ID, PROVIDER_LABEL } from "./constants.js";
import { buildModelCatalogProvider } from "./media/catalog-providers.js";
import { buildEmbeddingAdapter } from "./media/embeddings.js";
import { buildImageProvider } from "./media/image.js";
import { buildSpeechProvider } from "./media/speech.js";
import { buildTranscriptionProvider } from "./media/transcription.js";
import { buildVideoProvider } from "./media/video.js";
import { buildTextProvider } from "./provider.js";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: PROVIDER_LABEL,
  description:
    "Chat, image, video, speech, transcription, and embedding models from the EmpirioLabs AI catalog.",
  register(api) {
    const deps = {
      resolveApiKey: createApiKeyResolver(api),
      isAvailable: createAvailabilityCheck(api),
    };
    api.registerProvider(buildTextProvider());
    api.registerImageGenerationProvider(buildImageProvider(deps));
    api.registerVideoGenerationProvider(buildVideoProvider(deps));
    api.registerSpeechProvider(buildSpeechProvider(deps));
    api.registerMediaUnderstandingProvider(buildTranscriptionProvider(deps));
    api.registerEmbeddingProvider(buildEmbeddingAdapter(deps));
    api.registerModelCatalogProvider(buildModelCatalogProvider("text"));
    api.registerModelCatalogProvider(buildModelCatalogProvider("image_generation"));
    api.registerModelCatalogProvider(buildModelCatalogProvider("video_generation"));
  },
});
