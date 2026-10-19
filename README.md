# EmpirioLabs AI provider for OpenClaw

This plugin adds [EmpirioLabs AI](https://empiriolabs.ai) to [OpenClaw](https://openclaw.ai) as a model provider. It brings the EmpirioLabs AI chat models, with streaming and tool calling, plus image generation, video generation, text to speech, audio transcription, and embeddings. Every model list loads from the live EmpirioLabs AI catalog, so new models appear without a plugin update.

EmpirioLabs AI is a specialized AI inference and integration provider. It self-hosts open-source models on GPU infrastructure it manages, runs optimized endpoints for proprietary models, helps teams ship their own models to large audiences, and offers on-demand GPU Cloud instances and hosted AI agents. Its model catalog covers text, image, audio, video, transcription, embedding, reranking, research, decision, and 3D models.

## Requirements

- OpenClaw 2026.9.33 or newer. Run `openclaw update` on older versions.
- An EmpirioLabs AI API key. Create one at [platform.empiriolabs.ai/dashboard/api-keys](https://platform.empiriolabs.ai/dashboard/api-keys). Keys start with `sk-empiriolabs-`.

## Install

From ClawHub:

```bash
openclaw plugins install clawhub:@empiriolabs/openclaw-provider
```

From npm:

```bash
openclaw plugins install npm:@empiriolabs/openclaw-provider
```

OpenClaw shows the plugin's capabilities for review before it installs them. In a script, add `--accept-capabilities` after you have reviewed them; an npm install also needs `--force` to confirm the source. When a Gateway is running, the install applies to it; otherwise the plugin loads on the next Gateway start.

## Set up

Run `openclaw onboard` and choose **EmpirioLabs AI**, then paste your API key.

To set up without prompts, keep the key in the `EMPIRIOLABS_API_KEY` environment variable and save a reference to it instead of the key itself:

```bash
export EMPIRIOLABS_API_KEY="sk-empiriolabs-..."
openclaw onboard --non-interactive --accept-risk --skip-health --auth-choice empiriolabs-api-key --secret-input-mode ref
```

You can also pass the key with `--empiriolabs-api-key <key>`. Setup selects the catalog's default chat model; change it with `openclaw models set empiriolabs/<model-id>`.

## Use

Model IDs are listed at [empiriolabs.ai/models](https://empiriolabs.ai/models). Refer to a model as `empiriolabs/<model-id>`.

| Task | Command |
| --- | --- |
| List the chat models | `openclaw models list --all --provider empiriolabs --refresh` |
| Set the default chat model | `openclaw models set empiriolabs/<model-id>` |
| Send one prompt | `openclaw infer model run --model empiriolabs/<model-id> --prompt "Hello"` |
| Generate an image | `openclaw infer image generate --model empiriolabs/<model-id> --prompt "A lighthouse at dusk" --output ./image.png` |
| Generate a video | `openclaw infer video generate --model empiriolabs/<model-id> --prompt "A paper boat in the rain"` |
| Convert text to speech | `openclaw infer tts convert --provider empiriolabs --text "Hello" --output ./speech.mp3` |
| List voices | `openclaw infer tts voices --provider empiriolabs` |
| Transcribe audio | `openclaw infer audio transcribe --file ./memo.m4a --model empiriolabs/<model-id>` |
| Create embeddings | `openclaw infer embedding create --provider empiriolabs --text "Hello"` |

OpenClaw agents use the same chat models, including tool calls, and OpenClaw's image, video, speech, and transcription features use the matching EmpirioLabs AI models.

## What the plugin covers

| Capability | Endpoint | Details |
| --- | --- | --- |
| Chat | `POST /v1/chat/completions` | Streaming, tool calling, image input on vision models, and reasoning effort on models that offer it. Prices come from the catalog, so OpenClaw's usage estimates match your EmpirioLabs AI pricing. |
| Images | `POST /v1/images/generations` | Text to image, with aspect ratio, resolution, size, and image count where the model accepts them. |
| Video | `POST /v1/videos/generations` | Text to video and image to video. A reference image must be a public `https://` URL. Video takes minutes; the plugin waits for the job and returns the video link. |
| Speech | `POST /v1/audio/speech` | MP3 by default. Voices come from `GET /v1/voices` for models that list them. |
| Transcription | `POST /v1/audio/transcriptions` | Uploads the audio file and returns the transcript. |
| Embeddings | `POST /v1/embeddings` | OpenAI-compatible embeddings for memory and search. |

The plugin reads the public catalog at `GET https://api.empiriolabs.ai/v1/models` and refreshes it every 5 minutes. Text models that serve chat completions appear as chat models; image, video, speech, transcription, and embedding models appear only under their own capability. If the catalog cannot be reached, the plugin uses a small offline list with one default model for each capability, generated from the catalog when the version was released.

## Configuration

Speech settings go in `tts.providers.empiriolabs` in `openclaw.json`:

```json5
{
  tts: {
    provider: "empiriolabs",
    providers: {
      empiriolabs: {
        model: "<speech-model-id>",
        voice: "<voice-id>",
        outputFormat: "mp3",
      },
    },
  },
}
```

To send requests through your own proxy, set `models.providers.empiriolabs.baseUrl`.

## Data handling

The plugin sends requests only to `https://api.empiriolabs.ai` (or the base URL you set), authenticated with your API key, and downloads generated files from the links the API returns. It stores nothing itself. EmpirioLabs AI does not keep the content of your prompts or responses once they are delivered and does not use them to train models; for third-party models, the model's provider also receives the request under its own terms. Links to generated files expire after 7 days. See the [Privacy Policy](https://empiriolabs.ai/privacy-policy).

## Development

```bash
npm install
npm run build              # compile to dist/
npm run typecheck
npm test                   # unit tests with mocked HTTP
npm run inspect            # OpenClaw Plugin Inspector on the packed files (after a build)
npm run generate:fallback  # refresh the offline fallback from the live catalog (after a build)
npm pack --dry-run
```

The live smoke test lists the catalog, streams one short chat, makes one tool call, and generates one image, which uses a small amount of credit:

```bash
EMPIRIOLABS_LIVE_TEST=1 EMPIRIOLABS_API_KEY="sk-empiriolabs-..." npm run test:live
```

Set `EMPIRIOLABS_LIVE_MODEL` to choose the chat model.

### Releasing

Pushing a version tag such as `0.1.0` runs the [Publish workflow](.github/workflows/publish.yml). It regenerates the offline fallback from the live catalog, runs the tests, packs the plugin once, and publishes that package to npm with a provenance statement and to ClawHub. The tag must match the `version` in `package.json` and `PACKAGE_VERSION` in `src/constants.ts`.

## Resources

- [EmpirioLabs AI](https://empiriolabs.ai)
- [Documentation](https://docs.empiriolabs.ai)
- [API keys](https://platform.empiriolabs.ai/dashboard/api-keys)
- [Models and pricing](https://empiriolabs.ai/models)
- [npm package](https://www.npmjs.com/package/@empiriolabs/openclaw-provider)
- [OpenClaw provider plugins](https://docs.openclaw.ai/plugins/sdk-provider-plugins)
- Support: [support@empiriolabs.ai](mailto:support@empiriolabs.ai)

## License

[MIT](LICENSE)
