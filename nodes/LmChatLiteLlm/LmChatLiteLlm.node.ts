import {
	NodeConnectionTypes,
	type IDataObject,
	type ISupplyDataFunctions,
	type INodeType,
	type INodeTypeDescription,
	type SupplyData,
} from 'n8n-workflow';
import { ChatLiteLlm } from './ChatLiteLlm';
import { N8nLlmTracing } from './N8nLlmTracing';
import { getModelsFor } from '../shared/loadModels';
import { isDeepSeekModel } from '../shared/deepseek';

export class LmChatLiteLlm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LiteLLM Chat Model',
		// eslint-disable-next-line n8n-nodes-base/node-class-description-name-miscased
		name: 'lmChatLiteLlm',
		icon: 'file:litellm.svg',
		group: ['transform'],
		version: 1,
		description:
			'Language model for the AI Agent via a LiteLLM proxy, with automatic DeepSeek reasoning support',
		defaults: { name: 'LiteLLM Chat Model' },
		codex: {
			categories: ['AI'],
			subcategories: { AI: ['Language Models', 'Root Nodes'] },
		},
		// eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
		inputs: [],
		// eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [{ name: 'liteLlmApi', required: true }],
		properties: [
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getModels',
					loadOptionsDependsOn: ['showAllModels'],
				},
				default: '',
				required: true,
				description: 'Chat models on your LiteLLM proxy. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Show All Models',
				name: 'showAllModels',
				type: 'boolean',
				default: false,
				description:
					'Whether to list every model on the proxy instead of only the chat ones. Turn on if your model is missing — LiteLLM cannot report a mode for custom or self-hosted models.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Frequency Penalty',
						name: 'frequencyPenalty',
						type: 'number',
						typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
						default: 0,
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						default: 2,
					},
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						type: 'number',
						default: 4096,
					},
					{
						displayName: 'Presence Penalty',
						name: 'presencePenalty',
						type: 'number',
						typeOptions: { minValue: -2, maxValue: 2, numberPrecision: 2 },
						default: 0,
					},
					{
						displayName: 'Reasoning (Thinking Mode)',
						name: 'reasoning',
						type: 'boolean',
						default: false,
						description:
							'Whether to enable reasoning when the selected model is DeepSeek. Ignored for non-DeepSeek models.',
					},
					{
						displayName: 'Reasoning Effort',
						name: 'reasoningEffort',
						type: 'options',
						options: [
							{ name: 'High', value: 'high' },
							{ name: 'Low', value: 'low' },
							{ name: 'Max', value: 'max' },
							{ name: 'Medium', value: 'medium' },
							{ name: 'None', value: 'none' },
						],
						default: 'high',
						description:
							'Sent as reasoning_effort to any model, not just DeepSeek (which takes High/Max). Set None for an OpenAI GPT-5 reasoning model, which otherwise refuses function tools in /chat/completions.',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 1,
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 120000,
					},
					{
						displayName: 'Top P',
						name: 'topP',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						default: 1,
					},
				],
			},
		],
	};

	methods = {
		loadOptions: { getModels: getModelsFor({ mode: 'chat' }) },
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('liteLlmApi');
		const model = this.getNodeParameter('model', itemIndex) as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;

		// `thinking` is DeepSeek-only and would break other providers.
		const useReasoning = options.reasoning === true && isDeepSeekModel(model);
		const modelKwargs: IDataObject = {};
		if (useReasoning) modelKwargs.thinking = { type: 'enabled' };

		// reasoning_effort is not DeepSeek-specific: OpenAI's GPT-5 line applies one by
		// default and then rejects function tools unless it is explicitly 'none'.
		if (options.reasoningEffort) modelKwargs.reasoning_effort = options.reasoningEffort;
		else if (useReasoning) modelKwargs.reasoning_effort = 'high';

		const llm = new ChatLiteLlm({
			openAIApiKey: credentials.apiKey as string,
			model,
			callbacks: [new N8nLlmTracing(this)],
			// Some LiteLLM-routed models (e.g. DeepSeek) reject OpenAI-style strict tool
			// schemas with a 400, which makes the agent retry forever. The official n8n
			// OpenAI node disables strict for the same reason.
			supportsStrictToolCalling: false,
			temperature: options.temperature as number | undefined,
			maxTokens: options.maxTokens as number | undefined,
			topP: options.topP as number | undefined,
			frequencyPenalty: options.frequencyPenalty as number | undefined,
			presencePenalty: options.presencePenalty as number | undefined,
			timeout: (options.timeout as number) ?? 120000,
			maxRetries: (options.maxRetries as number) ?? 2,
			configuration: {
				baseURL: credentials.baseUrl as string,
			},
			modelKwargs: Object.keys(modelKwargs).length ? modelKwargs : undefined,
		});
		// Only do the DeepSeek reasoning_content round-trip for DeepSeek models with
		// thinking mode on. Any other model behind the proxy behaves as plain ChatOpenAI.
		llm.echoReasoning = useReasoning;

		return { response: llm };
	}
}
