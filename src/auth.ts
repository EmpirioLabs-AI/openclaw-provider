/**
 * API key resolution for the image, video, speech, and embedding providers.
 * Chat requests get their key from OpenClaw's normal provider auth; these
 * capability providers resolve the same credential through the host.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  isProviderApiKeyConfigured,
  resolveProviderAuthProfileApiKey,
} from "openclaw/plugin-sdk/provider-auth";
import { API_KEY_ENV_VAR, API_KEYS_URL, PROVIDER_ID, PROVIDER_LABEL } from "./constants.js";
import type { OpenClawConfig } from "./types.js";

export type ApiKeyRequest = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

export type ApiKeyResolver = (request: ApiKeyRequest) => Promise<string | undefined>;

export const MISSING_API_KEY_MESSAGE =
  `${PROVIDER_LABEL} API key missing. Run \`openclaw onboard --auth-choice empiriolabs-api-key\` ` +
  `or set ${API_KEY_ENV_VAR}. Create a key at ${API_KEYS_URL}.`;

function cleanKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reads the key from the environment. */
export function readEnvApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return cleanKey(env[API_KEY_ENV_VAR]);
}

/**
 * Builds a resolver that tries, in order: the agent's saved auth profile, the
 * host's provider auth (profiles, config, and environment), then
 * `EMPIRIOLABS_API_KEY`.
 */
export function createApiKeyResolver(
  api: Pick<OpenClawPluginApi, "config"> & { runtime?: Partial<OpenClawPluginApi["runtime"]> },
  env: NodeJS.ProcessEnv = process.env,
): ApiKeyResolver {
  return async ({ cfg, agentDir }) => {
    const config = cfg ?? api.config;
    if (agentDir) {
      try {
        const fromProfile = cleanKey(
          await resolveProviderAuthProfileApiKey({ provider: PROVIDER_ID, cfg: config, agentDir }),
        );
        if (fromProfile) {
          return fromProfile;
        }
      } catch {
        // Fall through to the host's provider auth.
      }
    }
    const resolveForProvider = api.runtime?.modelAuth?.resolveApiKeyForProvider;
    if (resolveForProvider) {
      try {
        const auth = await resolveForProvider({ provider: PROVIDER_ID, cfg: config });
        const key = cleanKey(auth?.apiKey);
        if (key) {
          return key;
        }
      } catch {
        // No credential configured through the host; try the environment.
      }
    }
    return readEnvApiKey(env);
  };
}

/** Synchronous readiness check: a saved auth profile or `EMPIRIOLABS_API_KEY`. */
export function isApiKeyConfigured(
  params: { cfg?: OpenClawConfig; agentDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (readEnvApiKey(env)) {
    return true;
  }
  try {
    return isProviderApiKeyConfigured({
      provider: PROVIDER_ID,
      ...(params.cfg ? { cfg: params.cfg } : {}),
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    });
  } catch {
    return false;
  }
}

export async function requireApiKey(resolver: ApiKeyResolver, request: ApiKeyRequest): Promise<string> {
  const key = await resolver(request);
  if (!key) {
    throw new Error(MISSING_API_KEY_MESSAGE);
  }
  return key;
}
