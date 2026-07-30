import { ChatOpenAI } from '@langchain/openai';

/**
 * DeepSeek V4 in thinking mode requires the assistant's `reasoning_content` to be
 * echoed back when that assistant message reappears in the request history
 * (otherwise the API returns
 * `400 The reasoning_content in the thinking mode must be passed back to the API`,
 * which makes the AI Agent loop forever). LangChain's ChatOpenAI drops that field
 * both when parsing responses and when re-serializing messages, so we intercept the
 * single choke point — completionWithRetry — to capture it from each response and
 * re-inject it into the outgoing assistant messages.
 *
 * We key captured reasoning by tool_call id (for tool-call turns) and by content
 * string (for final-answer turns), since either can be replayed by the agent/memory.
 *
 * This behaves as plain ChatOpenAI for any non-DeepSeek model behind the LiteLLM
 * proxy — the node only sets echoReasoning when it detects a DeepSeek model.
 */
export class ChatLiteLlm extends ChatOpenAI {
	// Set by the node: only round-trip reasoning_content for DeepSeek models with
	// thinking mode enabled. Otherwise behave like plain ChatOpenAI.
	echoReasoning = false;

	/**
	 * Raw `usage` from the last non-streaming response. LangChain flattens usage to
	 * {promptTokens, completionTokens, totalTokens} before the callbacks see it,
	 * dropping `prompt_tokens_details.cached_tokens` and friends — so N8nLlmTracing
	 * reads the untouched object from here instead.
	 *
	 * ponytail: last-write-wins. Requests are sequential per node run; if a future
	 * change fires them in parallel this needs keying by request.
	 */
	lastUsage?: Record<string, unknown>;

	private reasoningByKey = new Map<string, string>();

	async completionWithRetry(request: any, options?: any): Promise<any> {
		if (this.echoReasoning) this.injectReasoning(request);

		const response: any = await super.completionWithRetry(request, options);

		if (response && request?.stream !== true) {
			if (response.usage) this.lastUsage = response.usage;
			if (this.echoReasoning) this.captureReasoning(response);
		}

		return response;
	}

	/** Puts each assistant turn's reasoning_content back before DeepSeek sees it. */
	private injectReasoning(request: any): void {
		const messages = request?.messages;
		if (!Array.isArray(messages)) return;

		for (const m of messages) {
			if (m?.role !== 'assistant' || m.reasoning_content != null) continue;
			let rc: string | undefined;
			if (Array.isArray(m.tool_calls) && m.tool_calls[0]?.id) {
				rc = this.reasoningByKey.get('tc:' + m.tool_calls[0].id);
			}
			if (rc == null && typeof m.content === 'string' && m.content.length > 0) {
				rc = this.reasoningByKey.get('ct:' + m.content);
			}
			// Fallback to empty when nothing was captured (e.g. history loaded from memory
			// across executions) so DeepSeek stops rejecting the request.
			m.reasoning_content = rc ?? '';
		}
	}

	/** Remembers this turn's reasoning_content so the next request can echo it. */
	private captureReasoning(response: any): void {
		if (!Array.isArray(response.choices)) return;

		for (const choice of response.choices) {
			const msg = choice?.message;
			const rc = msg?.reasoning_content;
			if (!rc) continue;
			if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
				for (const tc of msg.tool_calls) {
					if (tc?.id) this.reasoningByKey.set('tc:' + tc.id, rc);
				}
			} else if (typeof msg.content === 'string' && msg.content.length > 0) {
				this.reasoningByKey.set('ct:' + msg.content, rc);
			}
		}
	}
}
