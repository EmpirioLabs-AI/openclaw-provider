# Changelog

## 0.1.1

- Image, video, and speech providers answer OpenClaw's awaited readiness check (`isConfiguredAsync`) on OpenClaw 2026.10.10 and newer, and the plugin no longer calls `isProviderApiKeyConfigured`, which OpenClaw retires after December 31, 2026.
- Image and video providers no longer implement the synchronous `isConfigured` hook. Speech keeps it, without the credential-store read, because OpenClaw versions before 2026.10.10 require it.
- Chat models for OpenClaw's model pickers are registered through `registerModelCatalogProvider`, which replaces the provider's `staticCatalog` hook.
- Still works with OpenClaw 2026.9.33 and newer.
- `npm run inspect` checks the packed plugin with the OpenClaw Plugin Inspector; CI and the Publish workflow run it.

## 0.1.0

- First release. Works with OpenClaw 2026.9.33 and newer.
- `empiriolabs` provider for OpenClaw with API key onboarding (`--auth-choice empiriolabs-api-key`, `EMPIRIOLABS_API_KEY`).
- Chat models load from the live EmpirioLabs AI catalog, with streaming, tool calling, reasoning effort, and prices per model.
- Image generation, video generation (text to video and image to video), text to speech, audio transcription, and embeddings, each with its model list from the catalog.
