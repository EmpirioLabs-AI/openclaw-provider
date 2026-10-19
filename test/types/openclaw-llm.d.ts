// Test-only declaration for OpenClaw's completions transport. The subpath ships
// as JavaScript without public types; the live smoke test uses it to send
// requests exactly the way OpenClaw does. The plugin itself does not import it.
declare module "openclaw/plugin-sdk/llm" {
  export function streamSimple(model: unknown, context: unknown, options?: unknown): unknown;
}
