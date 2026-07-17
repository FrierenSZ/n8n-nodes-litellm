import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import { NodeConnectionTypes, type ISupplyDataFunctions, type IDataObject } from 'n8n-workflow';

/**
 * Minimal port of n8n's internal N8nLlmTracing callback handler.
 * Without this, an LLM sub-node runs but the AI Agent never records its
 * execution — the node shows up as "not called" and no token usage appears.
 * It reports each model call to n8n via addInputData / addOutputData so the
 * sub-node lights up with its input, output and token usage.
 */
export class N8nLlmTracing extends BaseCallbackHandler {
	name = 'N8nLlmTracing';

	// run the handlers to completion so addOutputData finishes before the node returns
	awaitHandlers = true;

	private runIndexByRunId = new Map<string, number>();

	constructor(private readonly ctx: ISupplyDataFunctions) {
		super();
	}

	async handleLLMStart(_llm: unknown, prompts: string[], runId: string): Promise<void> {
		try {
			const { index } = this.ctx.addInputData(NodeConnectionTypes.AiLanguageModel, [
				[{ json: { messages: prompts } }],
			]);
			this.runIndexByRunId.set(runId, index);
		} catch {
			// tracing must never break the model call
		}
	}

	async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
		try {
			const index = this.runIndexByRunId.get(runId) ?? 0;
			this.runIndexByRunId.delete(runId);

			const tokenUsage = (output.llmOutput?.tokenUsage ??
				output.llmOutput?.estimatedTokenUsage) as IDataObject | undefined;

			const generations = output.generations.map((gen) =>
				gen.map((g) => ({ text: g.text, generationInfo: g.generationInfo })),
			);

			this.ctx.addOutputData(NodeConnectionTypes.AiLanguageModel, index, [
				[{ json: { generations, tokenUsage: tokenUsage ?? null } }],
			]);
		} catch {
			// tracing must never break the model call
		}
	}

	async handleLLMError(error: Error, runId: string): Promise<void> {
		try {
			const index = this.runIndexByRunId.get(runId) ?? 0;
			this.runIndexByRunId.delete(runId);
			this.ctx.addOutputData(NodeConnectionTypes.AiLanguageModel, index, [
				[{ json: { error: error.message } }],
			]);
		} catch {
			// tracing must never break the model call
		}
	}
}
