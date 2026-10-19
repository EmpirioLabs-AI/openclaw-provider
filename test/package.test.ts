/** Keeps package.json, the manifest, the runtime constants, and published files consistent. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  API_KEY_ENV_VAR,
  AUTH_CHOICE_ID,
  AUTH_CLI_FLAG,
  AUTH_OPTION_KEY,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROVIDER_ID,
  PROVIDER_LABEL,
} from "../src/constants.js";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const pkg = JSON.parse(read("package.json").toString("utf8"));
const manifest = JSON.parse(read("openclaw.plugin.json").toString("utf8"));

describe("package metadata", () => {
  it("matches the runtime constants", () => {
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(pkg.version).toBe(PACKAGE_VERSION);
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository.url).toBe("git+https://github.com/EmpirioLabs-AI/openclaw-provider.git");
    expect(pkg.homepage).toBe("https://empiriolabs.ai");
    expect(pkg.publishConfig.access).toBe("public");
  });

  it("declares the OpenClaw compatibility fields ClawHub requires", () => {
    expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.openclaw.compat.pluginApi).toMatch(/^>=\d{4}\.\d+\.\d+/);
    expect(pkg.openclaw.build.openclawVersion).toBe(pkg.devDependencies.openclaw);
    expect(pkg.openclaw.install.npmSpec).toBe(PACKAGE_NAME);
    expect(pkg.openclaw.install.clawhubSpec).toBe(`clawhub:${PACKAGE_NAME}`);
    expect(pkg.peerDependencies.openclaw).toBe(pkg.openclaw.compat.pluginApi);
    expect(pkg.files).toEqual(expect.arrayContaining(["assets/icon.png", "openclaw.plugin.json", "README.md", "LICENSE"]));
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe("manifest", () => {
  it("matches the provider registration", () => {
    expect(manifest.id).toBe(PROVIDER_ID);
    expect(manifest.name).toBe(PROVIDER_LABEL);
    expect(manifest.providers).toEqual([PROVIDER_ID]);
    expect(manifest.categories).toEqual(["models"]);
    expect(manifest.setup.providers[0]).toMatchObject({ id: PROVIDER_ID, envVars: [API_KEY_ENV_VAR] });
    expect(manifest.providerAuthChoices[0]).toMatchObject({
      provider: PROVIDER_ID,
      method: "api-key",
      choiceId: AUTH_CHOICE_ID,
      optionKey: AUTH_OPTION_KEY,
      cliFlag: AUTH_CLI_FLAG,
      groupLabel: PROVIDER_LABEL,
    });
    for (const contract of [
      "imageGenerationProviders",
      "videoGenerationProviders",
      "speechProviders",
      "mediaUnderstandingProviders",
      "embeddingProviders",
    ]) {
      expect(manifest.contracts[contract]).toEqual([PROVIDER_ID]);
    }
  });

  it("does not carry a hand-kept model list", () => {
    expect(JSON.stringify(manifest)).not.toMatch(/"models"\s*:\s*\[/);
    expect(manifest.modelCatalog.discovery[PROVIDER_ID]).toBe("runtime");
  });
});

describe("published files", () => {
  it("ships a square PNG icon of at most 512 KiB", () => {
    const icon = read("assets/icon.png");
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(icon.byteLength).toBeLessThanOrEqual(512 * 1024);
    const width = icon.readUInt32BE(16);
    const height = icon.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeLessThanOrEqual(1024);
  });

  it("uses no em dash in user-facing text", () => {
    for (const file of ["README.md", "CHANGELOG.md", "package.json", "openclaw.plugin.json", "LICENSE"]) {
      expect(read(file).toString("utf8"), file).not.toContain("\u2014");
    }
  });

  it("names the legal entity in the license", () => {
    expect(read("LICENSE").toString("utf8")).toContain("Copyright (c) 2026 EmpirioLabs.ai LLC");
  });
});
