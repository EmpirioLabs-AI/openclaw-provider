/** Identity and endpoints of the EmpirioLabs AI provider. */

export const PROVIDER_ID = "empiriolabs";
export const PROVIDER_LABEL = "EmpirioLabs AI";

/** OpenAI-compatible API root. */
export const DEFAULT_BASE_URL = "https://api.empiriolabs.ai/v1";

export const API_KEY_ENV_VAR = "EMPIRIOLABS_API_KEY";
export const AUTH_METHOD_ID = "api-key";
export const AUTH_CHOICE_ID = "empiriolabs-api-key";
export const AUTH_OPTION_KEY = "empiriolabsApiKey";
export const AUTH_CLI_FLAG = "--empiriolabs-api-key";

export const API_KEYS_URL = "https://platform.empiriolabs.ai/dashboard/api-keys";
export const DOCS_URL = "https://docs.empiriolabs.ai";
export const HOMEPAGE_URL = "https://empiriolabs.ai";

export const PACKAGE_NAME = "@empiriolabs/openclaw-provider";
/** Kept equal to package.json "version"; a unit test enforces it. */
export const PACKAGE_VERSION = "0.1.3";
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;

/** Catalog `supported_endpoints` values this plugin calls. */
export const ENDPOINTS = {
  chat: "POST /v1/chat/completions",
  image: "POST /v1/images/generations",
  video: "POST /v1/videos/generations",
  speech: "POST /v1/audio/speech",
  transcription: "POST /v1/audio/transcriptions",
  embeddings: "POST /v1/embeddings",
  voices: "GET /v1/voices",
} as const;
