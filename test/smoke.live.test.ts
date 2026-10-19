/**
 * Live smoke test against https://api.empiriolabs.ai. It uses a small amount of
 * credit (one short streaming chat, one tool call, one image). Skipped unless
 * EMPIRIOLABS_LIVE_TEST=1 and EMPIRIOLABS_API_KEY are set.
 *
 *   EMPIRIOLABS_LIVE_TEST=1 EMPIRIOLABS_API_KEY=sk-empiriolabs-... npm run test:live
 *
 * Chat and tool calls run through OpenClaw's own completions transport with the
 * model definitions this plugin publishes. EMPIRIOLABS_LIVE_MODEL picks the chat
 * model; the default is the plugin's default chat model from the live catalog.
 */
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { clearCatalogCacheForTests, loadCatalog, pickDefaultChatModel, pickDefault, selectMediaModels } from "../src/catalog.js";
import { DEFAULT_BASE_URL } from "../src/constants.js";
import { buildImageProvider } from "../src/media/image.js";
import { buildTextProvider } from "../src/provider.js";
import type { ImageGenerationRequest } from "../src/types.js";

const isAvailable = async () => true;

const KEY = process.env.EMPIRIOLABS_API_KEY?.trim() ?? "";
const LIVE = process.env.EMPIRIOLABS_LIVE_TEST === "1" && KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

type LiveModel = { id: string; compat?: unknown; [key: string]: unknown };

async function liveChatModel(): Promise<LiveModel> {
  clearCatalogCacheForTests();
  const provider = buildTextProvider();
  const result = await provider.catalog!.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: KEY }),
    resolveProviderAuth: () => ({ apiKey: KEY, mode: "api_key", source: "env" }),
  } as ProviderCatalogContext);
  const models = (result as { provider: { models: LiveModel[] } }).provider.models;
  const snapshot = await loadCatalog();
  const wanted = process.env.EMPIRIOLABS_LIVE_MODEL?.trim() || pickDefaultChatModel(snapshot.rows)?.id;
  const model = models.find((candidate) => candidate.id === wanted);
  if (!model) {
    throw new Error(`Chat model ${wanted} is not in the live catalog`);
  }
  return model;
}

function runtimeModel(model: LiveModel) {
  return { ...model, provider: "empiriolabs", api: "openai-completions", baseUrl: DEFAULT_BASE_URL };
}

const spend: Array<{ step: string; usd: number }> = [];

// Vitest captures console output; stderr writes stay visible in CI logs.
function log(message: string): void {
  process.stderr.write(`[live] ${message}\n`);
}

describeLive("EmpirioLabs AI live smoke", () => {
  it("lists live chat models, and only chat models", async () => {
    clearCatalogCacheForTests();
    const snapshot = await loadCatalog();
    expect(snapshot.live).toBe(true);
    const provider = buildTextProvider();
    const result = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: KEY }),
      resolveProviderAuth: () => ({ apiKey: KEY, mode: "api_key", source: "env" }),
    } as ProviderCatalogContext);
    const models = (result as { provider: { models: Array<{ id: string }> } }).provider.models;
    const videoIds = new Set(selectMediaModels(snapshot.rows).video.map((row) => row.id));
    log(`${snapshot.rows.length} catalog models, ${models.length} chat models`);
    expect(models.length).toBeGreaterThan(10);
    expect(models.some((model) => videoIds.has(model.id))).toBe(false);
  }, 60_000);

  it("streams a short chat completion through OpenClaw's transport", async () => {
    const model = await liveChatModel();
    const stream = streamSimple(
      runtimeModel(model) as never,
      { messages: [{ role: "user", content: "Count from one to five in words, separated by spaces.", timestamp: Date.now() }] } as never,
      { apiKey: KEY, maxTokens: 512, reasoning: "low" } as never,
    );
    let deltas = 0;
    let events = 0;
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      events += 1;
      if (event.type === "text_delta") {
        deltas += 1;
      }
    }
    const response = (await (stream as { result(): Promise<unknown> }).result()) as {
      stopReason: string;
      errorMessage?: string;
      content: Array<{ type: string; text?: string }>;
      usage?: { cost?: { total?: number } };
    };
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "live chat failed");
    }
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    log(`${model.id} streamed ${events} events, ${deltas} text deltas: ${JSON.stringify(text.slice(0, 80))}`);
    spend.push({ step: `chat ${model.id}`, usd: response.usage?.cost?.total ?? 0 });
    expect(deltas).toBeGreaterThanOrEqual(1);
    expect(events).toBeGreaterThan(deltas);
    expect(text.toLowerCase()).toContain("five");
  }, 180_000);

  it("calls a tool through OpenClaw's transport", async () => {
    const model = await liveChatModel();
    const stream = streamSimple(
      runtimeModel(model) as never,
      {
        systemPrompt: "Call the requested function exactly once.",
        messages: [{ role: "user", content: "Call live_probe with value exactly empiriolabs.", timestamp: Date.now() }],
        tools: [
          {
            name: "live_probe",
            description: "Return the supplied value.",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        ],
      } as never,
      { apiKey: KEY, maxTokens: 1024, reasoning: "low" } as never,
    );
    const response = (await (stream as { result(): Promise<unknown> }).result()) as {
      stopReason: string;
      errorMessage?: string;
      content: Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>;
      usage?: { cost?: { total?: number } };
    };
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage || "live tool call failed");
    }
    const call = response.content.find((block) => block.type === "toolCall");
    log(`${model.id} tool call: ${JSON.stringify(call)}`);
    spend.push({ step: `tool call ${model.id}`, usd: response.usage?.cost?.total ?? 0 });
    expect(call?.name).toBe("live_probe");
    expect(call?.arguments).toMatchObject({ value: "empiriolabs" });
  }, 180_000);

  it("generates one image with the default image model", async () => {
    clearCatalogCacheForTests();
    const snapshot = await loadCatalog();
    const model = pickDefault(selectMediaModels(snapshot.rows).image)?.id;
    expect(model).toBeTruthy();
    const provider = buildImageProvider({ isAvailable, resolveApiKey: async () => KEY });
    const result = await provider.generateImage({
      provider: "empiriolabs",
      model: model!,
      prompt: "Minimal flat test image: one blue square centered on a white background, no text.",
      cfg: {},
    } as ImageGenerationRequest);
    const image = result.images[0]!;
    log(`${result.model} image: ${image.mimeType}, ${image.buffer.byteLength} bytes`);
    const row = snapshot.rows.find((candidate) => candidate.id === result.model);
    const price = (row?.pricing as { image?: string; request?: string } | undefined) ?? {};
    spend.push({ step: `image ${result.model}`, usd: Number(price.image ?? price.request ?? 0) });
    expect(image.mimeType).toMatch(/^image\//);
    expect(image.buffer.byteLength).toBeGreaterThan(500);
    log(`estimated spend: ${JSON.stringify(spend)}`);
  }, 300_000);
});
