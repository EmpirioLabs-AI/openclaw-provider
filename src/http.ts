/**
 * HTTP helpers for the EmpirioLabs AI API: authenticated JSON and multipart
 * requests, bounded downloads of generated files, and async job polling.
 */
import { PROVIDER_LABEL, USER_AGENT } from "./constants.js";

export type FetchFn = typeof fetch;

export type RequestOptions = {
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

/** An API error with the HTTP status and the message the API returned. */
export class EmpirioLabsApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "EmpirioLabsApiError";
    this.status = status;
    this.code = code;
  }
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Reads the error message from an API error envelope or plain-text body. */
export function readApiErrorMessage(body: unknown): { message?: string; code?: string } {
  if (typeof body === "string") {
    const text = body.trim();
    return text ? { message: text.slice(0, 500) } : {};
  }
  if (!body || typeof body !== "object") {
    return {};
  }
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === "string" && nested.trim()) {
    return { message: nested.trim() };
  }
  if (nested && typeof nested === "object") {
    const error = nested as Record<string, unknown>;
    const message = typeof error.message === "string" ? error.message.trim() : undefined;
    const code = typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : undefined;
    return { ...(message ? { message } : {}), ...(code ? { code } : {}) };
  }
  if (typeof record.message === "string" && record.message.trim()) {
    return { message: record.message.trim() };
  }
  if (typeof record.detail === "string" && record.detail.trim()) {
    return { message: record.detail.trim() };
  }
  return {};
}

async function readBodyText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${PROVIDER_LABEL} response exceeds ${maxBytes} bytes`);
  }
  const buffer = await readBodyBytes(response, maxBytes);
  return buffer.toString("utf8");
}

async function readBodyBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${PROVIDER_LABEL} response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function parseJsonResponse<T>(response: Response, label: string): Promise<T> {
  const text = await readBodyText(response, MAX_JSON_BYTES);
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (response.ok) {
      throw new Error(`${label}: the API returned a response that is not JSON`);
    }
  }
  if (!response.ok) {
    const { message, code } = readApiErrorMessage(body);
    throw new EmpirioLabsApiError(
      `${label} (HTTP ${response.status})${message ? `: ${message}` : ""}`,
      response.status,
      code,
    );
  }
  return body as T;
}

/** Sends a JSON POST and returns the parsed JSON response. */
export async function postJson<T>(params: {
  url: string;
  apiKey: string;
  body: unknown;
  label: string;
} & RequestOptions): Promise<T> {
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(params.url, {
    method: "POST",
    headers: { ...authHeaders(params.apiKey), "Content-Type": "application/json" },
    body: JSON.stringify(params.body),
    signal: combineSignals(params.signal, params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  return parseJsonResponse<T>(response, params.label);
}

/** Sends a multipart POST and returns the parsed JSON response. */
export async function postForm<T>(params: {
  url: string;
  apiKey: string;
  form: FormData;
  label: string;
} & RequestOptions): Promise<T> {
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(params.url, {
    method: "POST",
    headers: authHeaders(params.apiKey),
    body: params.form,
    signal: combineSignals(params.signal, params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  return parseJsonResponse<T>(response, params.label);
}

/** Sends a GET and returns the parsed JSON response. `apiKey` is optional for public endpoints. */
export async function getJson<T>(params: {
  url: string;
  apiKey?: string;
  label: string;
} & RequestOptions): Promise<T> {
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(params.url, {
    method: "GET",
    headers: authHeaders(params.apiKey),
    signal: combineSignals(params.signal, params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  return parseJsonResponse<T>(response, params.label);
}

export type DownloadedFile = {
  buffer: Buffer;
  mimeType: string;
};

/**
 * Downloads a generated file from the link the API returned. No credentials are
 * sent: generated-file links are signed and need no API key.
 */
export async function downloadFile(params: {
  url: string;
  maxBytes: number;
  defaultMimeType: string;
  label: string;
} & RequestOptions): Promise<DownloadedFile> {
  const parsed = URL.parse(params.url);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new Error(`${params.label}: the API returned an invalid file link`);
  }
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(parsed.toString(), {
    method: "GET",
    headers: { "User-Agent": USER_AGENT },
    signal: combineSignals(params.signal, params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EmpirioLabsApiError(
      `${params.label}: downloading the generated file failed (HTTP ${response.status})`,
      response.status,
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > params.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${params.label}: the generated file exceeds ${params.maxBytes} bytes`);
  }
  const buffer = await readBodyBytes(response, params.maxBytes);
  if (buffer.byteLength === 0) {
    throw new Error(`${params.label}: the generated file is empty`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const mimeType =
    contentType && contentType !== "application/octet-stream" && contentType !== "binary/octet-stream"
      ? contentType
      : params.defaultMimeType;
  return { buffer, mimeType };
}

export type JobView = {
  job_id?: string;
  status?: string;
  result?: unknown;
  error?: unknown;
  model?: string | null;
};

const TRANSIENT_JOB_STATUSES = new Set(["queued", "processing", "running"]);
const COMPLETED_JOB_STATUSES = new Set(["completed", "succeeded"]);
const FAILED_JOB_STATUSES = new Set(["failed", "cancelled"]);

/** True when an API response is the async job envelope rather than a finished result. */
export function isJobEnvelope(body: unknown): body is JobView & { job_id: string } {
  if (!body || typeof body !== "object") {
    return false;
  }
  const record = body as Record<string, unknown>;
  return typeof record.job_id === "string" && record.job_id.length > 0;
}

export type PollJobOptions = RequestOptions & {
  baseUrl: string;
  apiKey: string;
  jobId: string;
  label: string;
  /** Total time allowed for the job, measured from the first poll. */
  deadlineMs: number;
  /** Delay before each poll. Defaults to 2 s for the first minute, then 5 s. */
  intervalMs?: (attempt: number, elapsedMs: number) => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

function defaultInterval(_attempt: number, elapsedMs: number): number {
  return elapsedMs < 60_000 ? 2_000 : 5_000;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Polls `GET /v1/jobs/{job_id}` until the job completes and returns its result.
 * Status and body are both checked: a failed or cancelled job, a completed job
 * without a result, and an unknown status all end the wait with an error.
 */
export async function pollJob(options: PollJobOptions): Promise<{ result: unknown; job: JobView }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.intervalMs ?? defaultInterval;
  const started = now();
  const url = `${trimTrailingSlash(options.baseUrl)}/jobs/${encodeURIComponent(options.jobId)}`;
  for (let attempt = 0; ; attempt += 1) {
    const elapsed = now() - started;
    const wait = interval(attempt, elapsed);
    if (elapsed + wait > options.deadlineMs) {
      throw new Error(
        `${options.label}: job ${options.jobId} did not finish within ${Math.round(options.deadlineMs / 1000)} s. ` +
          `It may still finish; check it with GET /v1/jobs/${options.jobId}.`,
      );
    }
    await sleep(wait, options.signal);
    const job = await getJson<JobView>({
      url,
      apiKey: options.apiKey,
      label: `${options.label}: job status request failed`,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: Math.min(60_000, Math.max(1_000, options.deadlineMs - (now() - started))),
    });
    const status = typeof job.status === "string" ? job.status.toLowerCase() : "";
    if (TRANSIENT_JOB_STATUSES.has(status)) {
      continue;
    }
    if (COMPLETED_JOB_STATUSES.has(status)) {
      if (job.result === undefined || job.result === null) {
        throw new Error(`${options.label}: job ${options.jobId} completed without a result`);
      }
      return { result: job.result, job };
    }
    if (FAILED_JOB_STATUSES.has(status)) {
      const { message } = readApiErrorMessage({ error: job.error });
      throw new Error(
        `${options.label}: job ${options.jobId} ${status}${message ? `: ${message}` : ""}`,
      );
    }
    throw new Error(
      `${options.label}: job ${options.jobId} returned an unexpected status${status ? ` "${status}"` : ""}`,
    );
  }
}

/** Collects http(s) file links from `data[].url` (and `url` / `urls`) in an API result. */
export function extractOutputUrls(result: unknown): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && /^https?:\/\//iu.test(value) && !urls.includes(value)) {
      urls.push(value);
    }
  };
  if (!result || typeof result !== "object") {
    return urls;
  }
  const record = result as Record<string, unknown>;
  const data = record.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object") {
        push((item as Record<string, unknown>).url);
      } else {
        push(item);
      }
    }
  }
  push(record.url);
  if (Array.isArray(record.urls)) {
    record.urls.forEach(push);
  }
  if (Array.isArray(record.output_urls)) {
    record.output_urls.forEach(push);
  }
  return urls;
}

/** Collects inline base64 payloads from `data[].b64_json` in an API result. */
export function extractInlineBase64(result: unknown): string[] {
  if (!result || typeof result !== "object") {
    return [];
  }
  const data = (result as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const out: string[] = [];
  for (const item of data) {
    if (item && typeof item === "object") {
      const b64 = (item as Record<string, unknown>).b64_json;
      if (typeof b64 === "string" && b64.length > 0) {
        out.push(b64);
      }
    }
  }
  return out;
}
