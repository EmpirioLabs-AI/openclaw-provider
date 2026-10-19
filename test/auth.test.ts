import { describe, expect, it } from "vitest";
import { createApiKeyResolver, createAvailabilityCheck, hasConfiguredApiKey, readEnvApiKey } from "../src/auth.js";
import { readConfiguredBaseUrl, resolveBaseUrl } from "../src/config.js";
import { API } from "./helpers.js";

describe("API key resolution", () => {
  it("uses the host's provider auth first", async () => {
    const resolver = createApiKeyResolver(
      {
        config: {},
        runtime: { modelAuth: { resolveApiKeyForProvider: async () => ({ apiKey: " sk-host ", source: "profile", mode: "api-key" }) } } as never,
      },
      { EMPIRIOLABS_API_KEY: "sk-env" },
    );
    expect(await resolver({})).toBe("sk-host");
  });

  it("falls back to EMPIRIOLABS_API_KEY when the host has no credential", async () => {
    const resolver = createApiKeyResolver(
      {
        config: {},
        runtime: {
          modelAuth: {
            resolveApiKeyForProvider: async () => {
              throw new Error("No API key found");
            },
          },
        } as never,
      },
      { EMPIRIOLABS_API_KEY: "sk-env" },
    );
    expect(await resolver({})).toBe("sk-env");
  });

  it("works without a host runtime", async () => {
    const resolver = createApiKeyResolver({ config: {} }, {});
    expect(await resolver({})).toBeUndefined();
    expect(readEnvApiKey({ EMPIRIOLABS_API_KEY: "  " })).toBeUndefined();
  });
});

describe("readiness", () => {
  const profileConfig = { auth: { profiles: { "empiriolabs:default": { provider: "empiriolabs", mode: "api_key" } } } } as never;

  it("reads configuration only for the synchronous check", () => {
    expect(hasConfiguredApiKey({}, { EMPIRIOLABS_API_KEY: "sk-env" })).toBe(true);
    expect(hasConfiguredApiKey(profileConfig, {})).toBe(true);
    expect(hasConfiguredApiKey({ models: { providers: { EmpirioLabs: { baseUrl: API, models: [], apiKey: "sk-config" } } } } as never, {})).toBe(true);
    expect(
      hasConfiguredApiKey(
        { models: { providers: { empiriolabs: { baseUrl: API, models: [], apiKey: { source: "env", provider: "default", id: "EMPIRIOLABS_API_KEY" } } } } } as never,
        {},
      ),
    ).toBe(true);
    expect(hasConfiguredApiKey({ auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } } } as never, {})).toBe(false);
    expect(hasConfiguredApiKey(undefined, {})).toBe(false);
  });

  it("uses the host's awaited availability check when the host has one", async () => {
    const calls: unknown[] = [];
    const check = createAvailabilityCheck(
      {
        config: {},
        runtime: {
          modelAuth: {
            isProviderApiKeyConfiguredAsync: async (params: unknown) => {
              calls.push(params);
              return true;
            },
          },
        } as never,
      },
      {},
    );
    expect(await check({ agentDir: "/agents/main" })).toBe(true);
    expect(calls).toEqual([{ provider: "empiriolabs", cfg: {}, agentDir: "/agents/main" }]);
  });

  it("trusts a negative host answer unless the env var is set", async () => {
    const host = {
      config: profileConfig,
      runtime: { modelAuth: { isProviderApiKeyConfiguredAsync: async () => false } } as never,
    };
    expect(await createAvailabilityCheck(host, {})({})).toBe(false);
    expect(await createAvailabilityCheck(host, { EMPIRIOLABS_API_KEY: "sk-env" })({})).toBe(true);
  });

  it("falls back to configuration on hosts without the awaited check or when it fails", async () => {
    expect(await createAvailabilityCheck({ config: profileConfig }, {})({})).toBe(true);
    expect(await createAvailabilityCheck({ config: {} }, {})({})).toBe(false);
    const failing = {
      config: profileConfig,
      runtime: {
        modelAuth: {
          isProviderApiKeyConfiguredAsync: async () => {
            throw new Error("store unavailable");
          },
        },
      } as never,
    };
    expect(await createAvailabilityCheck(failing, {})({})).toBe(true);
  });
});

describe("base URL", () => {
  it("defaults to the public API and honors a configured override", () => {
    expect(resolveBaseUrl({})).toBe(API);
    const cfg = { models: { providers: { EmpirioLabs: { baseUrl: "https://proxy.example.com/v1/", models: [] } } } } as never;
    expect(readConfiguredBaseUrl(cfg)).toBe("https://proxy.example.com/v1");
    expect(resolveBaseUrl(cfg, "https://other.example.com/v1")).toBe("https://other.example.com/v1");
    expect(readConfiguredBaseUrl({ models: { providers: { empiriolabs: { baseUrl: "not a url", models: [] } } } } as never)).toBeUndefined();
  });
});
