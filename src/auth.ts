/**
 * API key resolution and readiness checks for the image, video, speech, and
 * embedding providers. Chat requests get their key from OpenClaw's normal
 * provider auth; these capability providers resolve the same credential
 * through the host.
 *
 * Readiness uses the host's awaited provider-availability check
 * (`api.runtime.modelAuth.isProviderApiKeyConfiguredAsync`, OpenClaw
 * 2026.10.10 and newer). Older hosts do not call the async hooks; the one
 * synchronous hook OpenClaw still requires (speech) reads configuration only.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderAuthProfileApiKey } from "openclaw/plugin-sdk/provider-auth";
import { API_KEY_ENV_VAR, API_KEYS_URL, PROVIDER_ID, PROVIDER_LABEL } from "./constants.js";
import type { OpenClawConfig } from "./types.js";

export type ApiKeyRequest = {
  cfg?: OpenClawConfig;
  agentDir?: string;
};

export type ApiKeyResolver = (request: ApiKeyRequest) => Promise<string | undefined>;

/** Awaited readiness check shared by the capability providers. */
export type AvailabilityCheck = (request: ApiKeyRequest) => Promise<boolean>;

type HostApi = Pick<OpenClawPluginApi, "config"> & { runtime?: Partial<OpenClawPluginApi["runtime"]> };

/** The awaited availability method of newer hosts, absent before OpenClaw 2026.10.10. */
type AsyncAvailabilityMethod = (params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}) => Promise<boolean>;

export const MISSING_API_KEY_MESSAGE =
  `${PROVIDER_LABEL} API key missing. Run \`openclaw onboard --auth-choice empiriolabs-api-key\` ` +
  `or set ${API_KEY_ENV_VAR}. Create a key at ${API_KEYS_URL}.`;

function cleanKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Reads the key from the environment. */
export function readEnvApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return cleanKey(env[API_KEY_ENV_VAR]);
}

/**
 * Configuration-only readiness: `EMPIRIOLABS_API_KEY`, a key (or secret
 * reference) under `models.providers.empiriolabs.apiKey`, or an auth profile
 * for the provider declared in `auth.profiles`. Reads no credential store.
 */
export function hasConfiguredApiKey(cfg: OpenClawConfig | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (readEnvApiKey(env)) {
    return true;
  }
  const providers = asRecord(asRecord(cfg?.models)?.providers);
  if (providers) {
    for (const [name, entry] of Object.entries(providers)) {
      if (name.trim().toLowerCase() !== PROVIDER_ID) {
        continue;
      }
      const apiKey = asRecord(entry)?.apiKey;
      if (cleanKey(apiKey) || asRecord(apiKey)) {
        return true;
      }
    }
  }
  const profiles = asRecord(asRecord(cfg?.auth)?.profiles);
  if (profiles) {
    for (const profile of Object.values(profiles)) {
      const provider = asRecord(profile)?.provider;
      if (typeof provider === "string" && provider.trim().toLowerCase() === PROVIDER_ID) {
        return true;
      }
    }
  }
  return false;
}

function hostAvailabilityMethod(api: HostApi): AsyncAvailabilityMethod | undefined {
  const modelAuth = api.runtime?.modelAuth as { isProviderApiKeyConfiguredAsync?: unknown } | undefined;
  const method = modelAuth?.isProviderApiKeyConfiguredAsync;
  return typeof method === "function"
    ? (params) => (method as AsyncAvailabilityMethod).call(modelAuth, params)
    : undefined;
}

/**
 * Builds the awaited readiness check: the host's provider availability (saved
 * auth profiles, configuration, and environment) when the host provides it,
 * otherwise the configuration-only check.
 */
export function createAvailabilityCheck(api: HostApi, env: NodeJS.ProcessEnv = process.env): AvailabilityCheck {
  return async ({ cfg, agentDir }) => {
    const config = cfg ?? api.config;
    const hostCheck = hostAvailabilityMethod(api);
    if (hostCheck) {
      try {
        const configured = await hostCheck({
          provider: PROVIDER_ID,
          ...(config ? { cfg: config } : {}),
          ...(agentDir ? { agentDir } : {}),
        });
        return configured || Boolean(readEnvApiKey(env));
      } catch {
        // Fall back to configuration when the host cannot answer.
      }
    }
    return hasConfiguredApiKey(config, env);
  };
}

/**
 * Builds a resolver that tries, in order: the agent's saved auth profile, the
 * host's provider auth (profiles, config, and environment), then
 * `EMPIRIOLABS_API_KEY`.
 */
export function createApiKeyResolver(api: HostApi, env: NodeJS.ProcessEnv = process.env): ApiKeyResolver {
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

export async function requireApiKey(resolver: ApiKeyResolver, request: ApiKeyRequest): Promise<string> {
  const key = await resolver(request);
  if (!key) {
    throw new Error(MISSING_API_KEY_MESSAGE);
  }
  return key;
}
