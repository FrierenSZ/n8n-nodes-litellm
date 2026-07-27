# @frierensz_/n8n-nodes-litellm

Community node for [LiteLLM](https://www.litellm.ai) (OpenAI-compatible proxy) in [n8n](https://n8n.io).

The **Model** field is populated live from your LiteLLM proxy's own `/models` list — no
hardcoded model names. If the selected model is a **DeepSeek** model, the node automatically
handles DeepSeek's reasoning quirk: the `reasoning_content` (thinking) that DeepSeek's thinking
mode requires to be echoed back is round-tripped for you, instead of causing a `400` loop like it
does with generic OpenAI-compatible nodes. Any other model behind the proxy behaves as a normal
OpenAI-compatible chat model.

## Nodes

- **LiteLLM** — action node. See the actions below.
- **LiteLLM Chat Model** — sub-node for the **AI Agent**. Plug it into an Agent to use any model
  behind your LiteLLM proxy as the reasoning brain, with tool calling.

## Actions

| Resource | Action | Endpoint |
|----------|--------|----------|
| Text | Message a model | `/chat/completions` |
| Image | Analyze an image | `/chat/completions` (`image_url`) |
| Image | Generate an image | `/images/generations` |
| Audio | Analyze audio | `/chat/completions` (`input_audio`) |
| Audio | Transcribe a recording | `/audio/transcriptions` |
| Document | Analyze a document | `/chat/completions` (`file`) |
| Video | Analyze a video | `/chat/completions` (`video_url`) |
| Video | Generate a video | `/videos` |

The analyze actions take either a **binary field** from a previous node (default `data`) or a
**URL**. Whether a given model can actually read an image/audio/video/PDF depends on the model you
route to in LiteLLM — Gemini and GPT-4o handle all of them, most text-only models handle none.

Chat actions split `content`, `reasoning_content` and `tool_calls` in the output, and support tools
(function calling) and JSON mode.

**Generating video** takes minutes — LiteLLM returns a job ID and the node polls until it is done,
then hands you the mp4 as a binary field. Raise **Max Wait (Minutes)** (default 10) if your model
needs longer. Works with `sora-2` (OpenAI) and `veo-3` (Gemini).

**Note on transcription:** *Transcribe a Recording* uses the Whisper-style `/audio/transcriptions`
endpoint, which only a few providers implement (OpenAI, Azure, Groq, Deepgram, Fireworks). Gemini
has no such endpoint — to transcribe with Gemini, use **Analyze Audio** and ask for a transcript in
the prompt.

**Not available:** File Search stores — that is a Gemini-specific API with no OpenAI-compatible
equivalent on the proxy.

## Install

In n8n: **Settings → Community Nodes → Install** → `@frierensz_/n8n-nodes-litellm`.

## Credentials

Create a **LiteLLM API** credential with your proxy's master key (or a virtual key) and its base
URL (e.g. `http://localhost:4000`).

## Reasoning (DeepSeek)

Turn on **Reasoning (Thinking Mode)** in Options. It only takes effect when the selected model
name contains `deepseek` (e.g. `deepseek-v4-pro`, or whatever alias you gave it in LiteLLM) — for
any other model the toggle is ignored so non-DeepSeek requests aren't broken by DeepSeek-only
params.

## Develop

```bash
npm install
npm run build
npm test        # asserts the multimodal content-part shapes
```

Point n8n at the built package with `N8N_CUSTOM_EXTENSIONS=/path/to/n8n-nodes-litellm`, or
`npm link` it into `~/.n8n/custom`.

## License

MIT
