import { OpenAIEmbeddings } from '@langchain/openai';
import {
	NodeConnectionTypes,
	type IDataObject,
	type ISupplyDataFunctions,
} from 'n8n-workflow';

/**
 * n8n only registers a sub-node's run when the node reports it — without this the
 * node executes but shows up grey ("not called"). OpenAIEmbeddings exposes no
 * callback hooks for embedding calls, so we report around the two public methods.
 * Same job N8nLlmTracing does for the chat model.
 */
export class TracedEmbeddings extends OpenAIEmbeddings {
	// Set by the node after construction, so the OpenAIEmbeddings constructor
	// signature stays untouched.
	n8nContext?: ISupplyDataFunctions;

	private async traced<T>(
		input: IDataObject,
		run: () => Promise<T>,
		summarize: (result: T) => IDataObject,
	): Promise<T> {
		const ctx = this.n8nContext;
		if (!ctx) return run();

		let index = 0;
		try {
			index = ctx.addInputData(NodeConnectionTypes.AiEmbedding, [[{ json: input }]]).index;
		} catch {
			// tracing must never break the embedding call
		}

		try {
			const result = await run();
			try {
				ctx.addOutputData(NodeConnectionTypes.AiEmbedding, index, [
					[{ json: summarize(result) }],
				]);
			} catch {
				// tracing must never break the embedding call
			}
			return result;
		} catch (error) {
			try {
				ctx.addOutputData(NodeConnectionTypes.AiEmbedding, index, [
					[{ json: { error: (error as Error).message } }],
				]);
			} catch {
				// tracing must never break the embedding call
			}
			throw error;
		}
	}

	// ponytail: report vector counts/size, not the vectors themselves — a single
	// batch is thousands of floats and would bloat every execution log.
	async embedDocuments(texts: string[]): Promise<number[][]> {
		return this.traced(
			{ documents: texts.length },
			async () => super.embedDocuments(texts),
			(vectors) => ({ vectors: vectors.length, dimensions: vectors[0]?.length ?? 0 }),
		);
	}

	async embedQuery(text: string): Promise<number[]> {
		return this.traced(
			{ text },
			async () => super.embedQuery(text),
			(vector) => ({ dimensions: vector.length }),
		);
	}
}
