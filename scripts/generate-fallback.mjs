#!/usr/bin/env node
// Regenerates src/generated/fallback-catalog.ts from the live public catalog
// (GET https://api.empiriolabs.ai/v1/models, no API key needed).
//
// The fallback is used only when the catalog cannot be reached. It holds one
// default model per capability (chat, image, video, speech, transcription,
// embeddings), picked by the same rules the plugin applies at runtime, so the
// selection logic lives in one place: dist/catalog.js. Run `npm run build`
// first. The publish workflow regenerates this file before every release.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const baseUrl = (process.env.EMPIRIOLABS_BASE_URL ?? "https://api.empiriolabs.ai/v1").replace(/\/+$/u, "");
const outFile = fileURLToPath(new URL("../src/generated/fallback-catalog.ts", import.meta.url));

const catalog = await import("../dist/catalog.js").catch(() => {
  console.error("dist/catalog.js not found. Run `npm run build` first.");
  process.exit(2);
});

const response = await fetch(`${baseUrl}/models`, {
  headers: { Accept: "application/json", "User-Agent": "@empiriolabs/openclaw-provider generate-fallback" },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  console.error(`GET ${baseUrl}/models answered HTTP ${response.status}`);
  process.exit(1);
}
const body = await response.json();
const rows = Array.isArray(body?.data) ? body.data : [];
if (rows.length === 0) {
  console.error("The model catalog is empty");
  process.exit(1);
}

const media = catalog.selectMediaModels(rows);
const picks = [
  ["chat", catalog.pickDefaultChatModel(rows)],
  ["image", catalog.pickDefault(media.image)],
  ["video", catalog.pickDefault(media.video)],
  ["speech", catalog.pickDefault(media.speech)],
  ["transcription", catalog.pickDefault(media.transcription)],
  ["embeddings", catalog.pickDefault(media.embeddings)],
];
const missing = picks.filter(([, row]) => !row).map(([name]) => name);
if (missing.length > 0) {
  console.error(`No catalog model found for: ${missing.join(", ")}`);
  process.exit(1);
}

// Keep only the fields the plugin reads.
const ROW_FIELDS = [
  "id",
  "display_name",
  "category",
  "status",
  "is_featured",
  "supported_endpoints",
  "input_modalities",
  "output_modalities",
  "features",
  "context_length",
  "max_output_tokens",
  "structured_output",
  "pricing",
];
const PARAMETERS = new Set([
  "prompt",
  "image",
  "aspect_ratio",
  "resolution",
  "size",
  "num_images",
  "duration",
  "generate_audio",
  "output_format",
  "voice",
  "reasoning_effort",
]);
const PARAMETER_FIELDS = ["name", "type", "required", "options", "default", "min", "max"];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null) {
      out[field] = source[field];
    }
  }
  return out;
}

const fallbackRows = [];
const seen = new Set();
for (const [, row] of picks) {
  if (seen.has(row.id)) {
    continue;
  }
  seen.add(row.id);
  const trimmed = pick(row, ROW_FIELDS);
  trimmed.is_featured = true;
  const parameters = (row.supported_parameters ?? [])
    .filter((parameter) => PARAMETERS.has(parameter?.name))
    .map((parameter) => pick(parameter, PARAMETER_FIELDS));
  if (parameters.length > 0) {
    trimmed.supported_parameters = parameters;
  }
  fallbackRows.push(trimmed);
}

const generatedAt = new Date().toISOString();
const header = [
  "// GENERATED FILE. Do not edit by hand.",
  `// Source: GET ${baseUrl}/models (catalog_version ${body.catalog_version ?? "unknown"}, fetched ${generatedAt}).`,
  "// Regenerate with `npm run build && npm run generate:fallback`.",
  "// Offline fallback only: the plugin reads the live catalog at runtime and uses these",
  "// rows only when the catalog cannot be reached. One default model per capability:",
  `// ${picks.map(([name, row]) => `${name} ${row.id}`).join(", ")}.`,
].join("\n");

const source = `${header}
import type { CatalogRow } from "../catalog.js";

export type FallbackCatalog = {
  source: string;
  catalogVersion: string | null;
  generatedAt: string | null;
  rows: readonly CatalogRow[];
};

export const FALLBACK_CATALOG: FallbackCatalog = ${JSON.stringify(
  {
    source: `${baseUrl}/models`,
    catalogVersion: body.catalog_version ?? null,
    generatedAt,
    rows: fallbackRows,
  },
  null,
  2,
)};
`;

await writeFile(outFile, source, "utf8");
console.log(`Wrote ${fallbackRows.length} fallback rows to src/generated/fallback-catalog.ts`);
for (const [name, row] of picks) {
  console.log(`  ${name.padEnd(13)} ${row.id}`);
}
