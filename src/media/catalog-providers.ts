/** Image and video model lists for OpenClaw's model pickers, read from the live catalog. */
import {
  fallbackSnapshot,
  isImageModel,
  isVideoModel,
  loadCatalog,
  pickDefault,
  type CatalogRow,
} from "../catalog.js";
import { resolveBaseUrl } from "../config.js";
import { PROVIDER_ID } from "../constants.js";
import type { FetchFn } from "../http.js";
import type { ModelCatalogProvider } from "../types.js";
import { videoModelCapabilities } from "./video.js";

type MediaKind = "image_generation" | "video_generation";
type CatalogEntries = Awaited<ReturnType<NonNullable<ModelCatalogProvider["liveCatalog"]>>>;
type CatalogEntry = NonNullable<CatalogEntries>[number];

function toEntries(rows: readonly CatalogRow[], kind: MediaKind, source: "live" | "static"): CatalogEntry[] {
  const selected = rows.filter(kind === "image_generation" ? isImageModel : isVideoModel);
  const preferred = pickDefault(selected)?.id;
  return selected.map((row) => {
    const entry: Record<string, unknown> = {
      kind,
      provider: PROVIDER_ID,
      model: row.id,
      label: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : row.id,
      source,
    };
    if (row.id === preferred) {
      entry.default = true;
    }
    if (kind === "video_generation") {
      const capabilities = videoModelCapabilities(row);
      entry.capabilities = capabilities;
      entry.modes = capabilities.imageToVideo?.enabled ? ["generate", "imageToVideo"] : ["generate"];
    }
    return entry as CatalogEntry;
  });
}

export function buildMediaCatalogProvider(kind: MediaKind, deps: { fetchFn?: FetchFn } = {}): ModelCatalogProvider {
  return {
    provider: PROVIDER_ID,
    kinds: [kind],
    staticCatalog: () => toEntries(fallbackSnapshot().rows, kind, "static"),
    liveCatalog: async (ctx) => {
      if (!ctx.resolveProviderApiKey(PROVIDER_ID).apiKey) {
        return null;
      }
      const snapshot = await loadCatalog({
        baseUrl: resolveBaseUrl(ctx.config),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
      });
      return snapshot.live ? toEntries(snapshot.rows, kind, "live") : null;
    },
  };
}
