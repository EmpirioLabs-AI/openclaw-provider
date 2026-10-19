// GENERATED FILE. Do not edit by hand.
// Source: GET https://api.empiriolabs.ai/v1/models (catalog_version 2.10.66, fetched 2026-10-19T18:18:14.331Z).
// Regenerate with `npm run build && npm run generate:fallback`.
// Offline fallback only: the plugin reads the live catalog at runtime and uses these
// rows only when the catalog cannot be reached. One default model per capability:
// chat glm-5-3, image flux-2-klein-4b, video kling-3-0-turbo, speech tts-2, transcription whisper-large-v3-turbo, embeddings text-embedding-v4.
import type { CatalogRow } from "../catalog.js";

export type FallbackCatalog = {
  source: string;
  catalogVersion: string | null;
  generatedAt: string | null;
  rows: readonly CatalogRow[];
};

export const FALLBACK_CATALOG: FallbackCatalog = {
  "source": "https://api.empiriolabs.ai/v1/models",
  "catalogVersion": "2.10.66",
  "generatedAt": "2026-10-19T18:18:14.331Z",
  "rows": [
    {
      "id": "glm-5-3",
      "display_name": "GLM 5.3",
      "category": "text",
      "status": "available",
      "is_featured": true,
      "supported_endpoints": [
        "POST /v1/chat/completions",
        "POST /v1/responses",
        "POST /v1/messages",
        "POST /v1beta/models/glm-5-3:generateContent"
      ],
      "input_modalities": [
        "text"
      ],
      "output_modalities": [
        "text"
      ],
      "features": [
        "reasoning",
        "function_calling",
        "web_search"
      ],
      "context_length": 1000000,
      "max_output_tokens": 131072,
      "structured_output": "json_object",
      "pricing": {
        "prompt": "0.0000014",
        "completion": "0.0000044",
        "image": "0",
        "request": "0",
        "input_cache_read": "0.0000014"
      },
      "supported_parameters": [
        {
          "name": "reasoning_effort",
          "type": "enum",
          "required": false,
          "options": [
            "low",
            "high",
            "max"
          ],
          "default": "max"
        }
      ]
    },
    {
      "id": "flux-2-klein-4b",
      "display_name": "FLUX.2 Klein 4B",
      "category": "image",
      "status": "available",
      "is_featured": true,
      "supported_endpoints": [
        "POST /v1/images/generations"
      ],
      "input_modalities": [
        "text",
        "image"
      ],
      "output_modalities": [
        "image"
      ],
      "features": [
        "image_generation",
        "image_editing",
        "reference_images",
        "seed_control"
      ],
      "pricing": {
        "prompt": "0",
        "completion": "0",
        "image": "0.0085",
        "request": "0",
        "input_cache_read": "0"
      },
      "supported_parameters": [
        {
          "name": "prompt",
          "type": "string",
          "required": true
        },
        {
          "name": "aspect_ratio",
          "type": "enum",
          "required": false,
          "options": [
            "1:1",
            "16:9",
            "9:16",
            "4:3",
            "3:4",
            "3:2",
            "2:3"
          ],
          "default": "1:1"
        },
        {
          "name": "size",
          "type": "string",
          "required": false
        },
        {
          "name": "num_images",
          "type": "number",
          "required": false,
          "default": 1,
          "min": 1,
          "max": 4
        }
      ]
    },
    {
      "id": "kling-3-0-turbo",
      "display_name": "Kling 3.0 Turbo",
      "category": "video",
      "status": "available",
      "is_featured": true,
      "supported_endpoints": [
        "POST /v1/videos/generations"
      ],
      "input_modalities": [
        "text",
        "image"
      ],
      "output_modalities": [
        "video"
      ],
      "features": [
        "text_to_video",
        "image_to_video",
        "audio",
        "video_generation"
      ],
      "pricing": {
        "prompt": "0",
        "completion": "0",
        "image": "0",
        "request": "0",
        "input_cache_read": "0"
      },
      "supported_parameters": [
        {
          "name": "prompt",
          "type": "string",
          "required": true
        },
        {
          "name": "image",
          "type": "string",
          "required": false
        },
        {
          "name": "resolution",
          "type": "enum",
          "required": false,
          "options": [
            "720p",
            "1080p"
          ],
          "default": "720p"
        },
        {
          "name": "aspect_ratio",
          "type": "enum",
          "required": false,
          "options": [
            "16:9",
            "9:16",
            "1:1"
          ],
          "default": "16:9"
        },
        {
          "name": "duration",
          "type": "number",
          "required": false,
          "default": 5,
          "min": 3,
          "max": 15
        }
      ]
    },
    {
      "id": "tts-2",
      "display_name": "TTS 2",
      "category": "audio",
      "status": "available",
      "is_featured": true,
      "supported_endpoints": [
        "POST /v1/audio/speech",
        "POST /v1/audio/speech:stream",
        "GET /v1/voices"
      ],
      "input_modalities": [
        "text"
      ],
      "output_modalities": [
        "audio"
      ],
      "features": [
        "multi_speaker",
        "real_time",
        "low_latency",
        "streaming",
        "word_timestamps",
        "character_timestamps",
        "multilingual",
        "expressive_prosody",
        "voice_direction"
      ],
      "pricing": {
        "prompt": "0",
        "completion": "0",
        "image": "0",
        "request": "0",
        "input_cache_read": "0"
      },
      "supported_parameters": [
        {
          "name": "voice",
          "type": "enum",
          "required": false,
          "options": [
            "Sarah",
            "Olivia",
            "Elizabeth",
            "Ashley",
            "Wendy",
            "Julia",
            "Priya",
            "Pixie",
            "Deborah",
            "Alex",
            "Mark",
            "Edward",
            "Theodore",
            "Ronald",
            "Dennis",
            "Timothy",
            "Shaun",
            "Craig",
            "Hades",
            "Heitor"
          ],
          "default": "Sarah"
        },
        {
          "name": "output_format",
          "type": "enum",
          "required": false,
          "options": [
            "MP3",
            "WAV",
            "OGG",
            "FLAC",
            "PCM",
            "ALAW",
            "MULAW"
          ],
          "default": "WAV"
        }
      ]
    },
    {
      "id": "whisper-large-v3-turbo",
      "display_name": "Whisper Large v3 Turbo",
      "category": "transcription",
      "status": "available",
      "is_featured": true,
      "supported_endpoints": [
        "POST /v1/audio/transcriptions"
      ],
      "input_modalities": [
        "audio"
      ],
      "output_modalities": [
        "text"
      ],
      "features": [
        "transcription",
        "translation",
        "multilingual",
        "word_timestamps",
        "hotwords",
        "srt_vtt"
      ],
      "pricing": {
        "prompt": "0",
        "completion": "0",
        "image": "0",
        "request": "0",
        "input_cache_read": "0"
      }
    },
    {
      "id": "text-embedding-v4",
      "display_name": "Text Embedding v4",
      "category": "embedding",
      "status": "available",
      "supported_endpoints": [
        "POST /v1/embeddings"
      ],
      "input_modalities": [
        "text"
      ],
      "output_modalities": [
        "embedding"
      ],
      "features": [
        "custom dimensions",
        "sparse vectors",
        "task instructions",
        "batch"
      ],
      "context_length": 8192,
      "pricing": {
        "prompt": "0.00000007",
        "completion": "0",
        "image": "0",
        "request": "0",
        "input_cache_read": "0.00000007"
      },
      "is_featured": true
    }
  ]
};
