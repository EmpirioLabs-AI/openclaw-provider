/** Helpers shared by the media providers. */
import { PROVIDER_ID } from "../constants.js";

/** Strips an optional `empiriolabs/` prefix from a model ref. */
export function normalizeModelId(model: string | undefined, fallback: string | undefined): string | undefined {
  const value = typeof model === "string" ? model.trim() : "";
  const id = value.toLowerCase().startsWith(`${PROVIDER_ID}/`) ? value.slice(PROVIDER_ID.length + 1) : value;
  return id || fallback;
}

/** Finds the option that matches a value case-insensitively and returns the option's own spelling. */
export function matchOption(options: readonly string[], value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const wanted = value.trim().toLowerCase();
  return options.find((option) => option.toLowerCase() === wanted);
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
};

export function extensionForMime(mimeType: string, fallback: string): string {
  return EXTENSIONS[mimeType.toLowerCase()] ?? fallback;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
};

/** Guesses a MIME type from a URL's file extension. */
export function mimeFromUrl(url: string, fallback: string): string {
  const path = URL.parse(url)?.pathname ?? "";
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? fallback;
}

/** Detects PNG, JPEG, WebP, and GIF bytes. */
export function sniffImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/u.test(buffer.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  return undefined;
}

export function clampInteger(value: number, min: number | undefined, max: number | undefined): number {
  let result = Math.round(value);
  if (typeof min === "number" && Number.isFinite(min)) {
    result = Math.max(Math.ceil(min), result);
  }
  if (typeof max === "number" && Number.isFinite(max)) {
    result = Math.min(Math.floor(max), result);
  }
  return result;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
