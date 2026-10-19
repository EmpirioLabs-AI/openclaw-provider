/**
 * Guards against retired OpenClaw Plugin SDK APIs coming back into the source.
 * OpenClaw removes these after 2026-12-31; see
 * https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate#await-auth-profile-and-provider-availability-operations
 * `npm run inspect` runs the ClawHub Plugin Inspector on the packed package as well.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

const read = (path: string) => readFileSync(path, "utf8");

/** Synchronous auth-store and provider-availability APIs and their awaited replacements. */
const RETIRED_SYMBOLS: Array<[pattern: RegExp, replacement: string]> = [
  [/\bisProviderApiKeyConfigured(?!Async)\b/u, "isProviderApiKeyConfiguredAsync"],
  [/\bisProviderAuthProfileConfigured(?!Async)\b/u, "isProviderAuthProfileConfiguredAsync"],
  [/\blistUsableProviderAuthProfileIds(?!Async)\b/u, "listUsableProviderAuthProfileIdsAsync"],
  [/\bensureAuthProfileStore(?!Async|ForLocalUpdate)\b/u, "ensureAuthProfileStoreAsync"],
  [/\bensureAuthProfileStoreForLocalUpdate(?!Async)\b/u, "ensureAuthProfileStoreForLocalUpdateAsync"],
  [/\bupsertAuthProfile(?!Async)\b/u, "upsertAuthProfileAsync"],
  [/\bupsertApiKeyProfile(?!Async)\b/u, "upsertApiKeyProfileAsync"],
  [/\bresolveProviderAuthProfileMetadata(?!Async)\b/u, "resolveProviderAuthProfileMetadataAsync"],
  [/\bloadAuthProfileStoreForRuntime(?!Async)\b/u, "loadAuthProfileStoreForRuntimeAsync"],
];

describe("retired Plugin SDK APIs", () => {
  it("are not used anywhere in the plugin source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      read(file)
        .split("\n")
        .forEach((line, index) => {
          for (const [pattern, replacement] of RETIRED_SYMBOLS) {
            if (pattern.test(line)) {
              offenders.push(`${file}:${index + 1} uses ${pattern.source}; use ${replacement}`);
            }
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it("image and video providers implement only the awaited readiness hook", () => {
    for (const file of ["media/image.ts", "media/video.ts"]) {
      expect(read(join(srcDir, file)), file).not.toMatch(/^\s*isConfigured\s*:/mu);
      expect(read(join(srcDir, file)), file).toMatch(/^\s*isConfiguredAsync\s*:/mu);
    }
  });

  it("the text provider registers static rows through registerModelCatalogProvider", () => {
    expect(read(join(srcDir, "provider.ts"))).not.toMatch(/\bstaticCatalog\b/u);
  });
});
