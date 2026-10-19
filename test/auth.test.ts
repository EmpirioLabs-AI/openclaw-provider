import { describe, expect, it } from "vitest";
import { createApiKeyResolver, isApiKeyConfigured, readEnvApiKey } from "../src/auth.js";
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

  it("reports readiness from the environment", () => {
    expect(isApiKeyConfigured({}, { EMPIRIOLABS_API_KEY: "sk-env" })).toBe(true);
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
