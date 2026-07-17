# @frierensz_/n8n-nodes-litellm

Community node for [LiteLLM](https://www.litellm.ai) (OpenAI-compatible proxy) in [n8n](https://n8n.io).

The **Model** field is populated live from your LiteLLM proxy's own `/models` list — no
hardcoded model names. If the selected model is a **DeepSeek** model, the node automatically
handles DeepSeek's reasoning quirk: the `reasoning_content` (thinking) that DeepSeek's thinking
mode requires to be echoed back is round-tripped for you, instead of causing a `400` loop like it
does with generic OpenAI-compatible nodes. Any other model behind the proxy behaves as a normal
OpenAI-compatible chat model.

## Nodes

- **LiteLLM** — action node. Send messages to any model served by your LiteLLM proxy, with
  reasoning (DeepSeek only), tools (function calling) and JSON output. Output splits `content`,
  `reasoning_content` and `tool_calls`.
- **LiteLLM Chat Model** — sub-node for the **AI Agent**. Plug it into an Agent to use any model
  behind your LiteLLM proxy as the reasoning brain, with tool calling.

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
```

Point n8n at the built package with `N8N_CUSTOM_EXTENSIONS=/path/to/n8n-nodes-litellm`, or
`npm link` it into `~/.n8n/custom`.

## License

MIT
