/** Reads the operator's optional `models.providers.empiriolabs` overrides. */
import { DEFAULT_BASE_URL, PROVIDER_ID } from "./constants.js";
import { trimTrailingSlash } from "./http.js";
import type { OpenClawConfig } from "./types.js";

function providerEntry(cfg: OpenClawConfig | undefined): Record<string, unknown> | undefined {
  const providers = cfg?.models?.providers as Record<string, unknown> | undefined;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  const key = Object.keys(providers).find((name) => name.trim().toLowerCase() === PROVIDER_ID);
  const entry = key ? providers[key] : undefined;
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
}

/** The configured base URL override, if any. */
export function readConfiguredBaseUrl(cfg: OpenClawConfig | undefined): string | undefined {
  const value = providerEntry(cfg)?.baseUrl;
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = URL.parse(value.trim());
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return undefined;
  }
  return trimTrailingSlash(parsed.toString());
}

/** The base URL requests go to: the configured override or the public API. */
export function resolveBaseUrl(cfg: OpenClawConfig | undefined, override?: string): string {
  const explicit = typeof override === "string" && override.trim() ? override.trim() : undefined;
  if (explicit) {
    const parsed = URL.parse(explicit);
    if (parsed && (parsed.protocol === "https:" || parsed.protocol === "http:")) {
      return trimTrailingSlash(parsed.toString());
    }
  }
  return readConfiguredBaseUrl(cfg) ?? DEFAULT_BASE_URL;
}
