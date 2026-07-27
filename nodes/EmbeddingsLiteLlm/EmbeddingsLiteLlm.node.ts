import {
	NodeConnectionTypes,
	type IDataObject,
	type ISupplyDataFunctions,
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
} from 'n8n-workflow';
import { TracedEmbeddings } from './TracedEmbeddings';
import { getModels } from '../shared/loadModels';

export class EmbeddingsLiteLlm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LiteLLM Embeddings',
		// eslint-disable-next-line n8n-nodes-base/node-class-description-name-miscased
		name: 'embeddingsLiteLlm',
		icon: 'file:litellm.svg',
		group: ['transform'],
		version: 1,
		description: 'Embeddings model via a LiteLLM proxy, for vector stores',
		defaults: { name: 'LiteLLM Embeddings' },
		codex: {
			categories: ['AI'],
			subcategories: { AI: ['Embeddings'] },
		},
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
		outputs: [NodeConnectionTypes.AiEmbedding],
		outputNames: ['Embeddings'],
		credentials: [{ name: 'liteLlmApi', required: true }],
		properties: [
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getModels' },
				default: '',
				required: true,
				description:
					'Model list is loaded from your LiteLLM proxy. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Batch Size',
						name: 'batchSize',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 512,
						description: 'How many documents to embed per request',
					},
					{
						displayName: 'Dimensions',
						name: 'dimensions',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 768,
						description:
							'Size of the output vectors. LiteLLM maps this to Gemini\'s outputDimensionality and Vertex\'s output_dimensionality. Only supported by models that allow it (Gemini embedding, OpenAI text-embedding-3 and later) — leave unset otherwise.',
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						default: 2,
					},
					{
						displayName: 'Strip New Lines',
						name: 'stripNewLines',
						type: 'boolean',
						default: true,
						description: 'Whether to strip new lines from the input text',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 120000,
					},
				],
			},
		],
	};

	methods = {
		loadOptions: { getModels },
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('liteLlmApi');
		const model = this.getNodeParameter('model', itemIndex) as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;

		const embeddings = new TracedEmbeddings({
			openAIApiKey: credentials.apiKey as string,
			model,
			// Sent as `dimensions`; LiteLLM translates it per provider. Omitted when
			// unset so models that reject the field keep working.
			dimensions: options.dimensions as number | undefined,
			batchSize: options.batchSize as number | undefined,
			stripNewLines: options.stripNewLines as boolean | undefined,
			timeout: (options.timeout as number) ?? 120000,
			maxRetries: (options.maxRetries as number) ?? 2,
			configuration: {
				baseURL: credentials.baseUrl as string,
			},
		});
		embeddings.n8nContext = this;

		return { response: embeddings };
	}
}
