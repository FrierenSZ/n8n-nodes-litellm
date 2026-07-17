import {
	NodeOperationError,
	type IExecuteFunctions,
	type IDataObject,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';
import { getModels } from '../shared/loadModels';
import { isDeepSeekModel } from '../shared/deepseek';

interface ChatMessage {
	role: string;
	content: string;
}

export class LiteLlm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LiteLLM',
		name: 'liteLlm',
		icon: 'file:litellm.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["model"]}}',
		description: 'Send messages to a model through a LiteLLM proxy, with reasoning and tools',
		defaults: { name: 'LiteLLM' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'liteLlmApi', required: true }],
		properties: [
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getModels' },
				default: '',
				required: true,
				description: 'Model list is loaded from your LiteLLM proxy. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				placeholder: 'Add Message',
				default: { message: [{ role: 'user', content: '' }] },
				options: [
					{
						name: 'message',
						displayName: 'Message',
						values: [
							{
								displayName: 'Role',
								name: 'role',
								type: 'options',
								options: [
									{ name: 'System', value: 'system' },
									{ name: 'User', value: 'user' },
									{ name: 'Assistant', value: 'assistant' },
								],
								default: 'user',
							},
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: { rows: 3 },
								default: '',
							},
						],
					},
				],
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
						displayName: 'Max Tokens',
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
							'Whether to enable reasoning when the selected model is DeepSeek. Returns reasoning_content separately. Ignored for non-DeepSeek models.',
					},
					{
						displayName: 'Reasoning Effort',
						name: 'reasoningEffort',
						type: 'options',
						options: [
							{ name: 'High', value: 'high' },
							{ name: 'Max', value: 'max' },
						],
						default: 'high',
						displayOptions: { show: { reasoning: [true] } },
					},
					{
						displayName: 'Response Format',
						name: 'responseFormat',
						type: 'options',
						options: [
							{ name: 'JSON Object', value: 'json_object' },
							{ name: 'Text', value: 'text' },
						],
						default: 'text',
						description: 'Force the model to return valid JSON',
					},
					{
						displayName: 'Simplify Output',
						name: 'simplify',
						type: 'boolean',
						default: true,
						description: 'Whether to return only content, reasoning_content and tool_calls',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						default: 1,
					},
					{
						displayName: 'Tools (JSON)',
						name: 'tools',
						type: 'json',
						default: '',
						description:
							'Array of tool/function definitions (OpenAI format). Tool calls are returned in the output.',
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
		loadOptions: { getModels },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const model = this.getNodeParameter('model', i) as string;
				const messagesUi = this.getNodeParameter('messages.message', i, []) as ChatMessage[];
				const options = this.getNodeParameter('options', i, {}) as IDataObject;

				if (!messagesUi.length) {
					throw new NodeOperationError(this.getNode(), 'At least one message is required', {
						itemIndex: i,
					});
				}

				const body: IDataObject = {
					model,
					messages: messagesUi.map((m) => ({ role: m.role, content: m.content })),
				};

				if (options.temperature !== undefined) body.temperature = options.temperature;
				if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
				if (options.topP !== undefined) body.top_p = options.topP;
				if (options.frequencyPenalty !== undefined)
					body.frequency_penalty = options.frequencyPenalty;
				if (options.presencePenalty !== undefined)
					body.presence_penalty = options.presencePenalty;

				// DeepSeek-only params: sending these to a non-DeepSeek model would break the request.
				if (options.reasoning === true && isDeepSeekModel(model)) {
					body.thinking = { type: 'enabled' };
					body.reasoning_effort = (options.reasoningEffort as string) ?? 'high';
				}

				if (options.responseFormat && options.responseFormat !== 'text') {
					body.response_format = { type: options.responseFormat };
				}

				if (options.tools) {
					let tools = options.tools;
					if (typeof tools === 'string' && tools.trim() !== '') {
						try {
							tools = JSON.parse(tools);
						} catch {
							throw new NodeOperationError(this.getNode(), 'Tools must be valid JSON', {
								itemIndex: i,
							});
						}
					}
					if (Array.isArray(tools) && tools.length) body.tools = tools;
				}

				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'liteLlmApi',
					{
						method: 'POST',
						url: '/chat/completions',
						baseURL: (await this.getCredentials('liteLlmApi')).baseUrl as string,
						body,
						json: true,
					},
				)) as IDataObject;

				const simplify = options.simplify !== false;
				if (simplify) {
					const message = ((response.choices as IDataObject[])?.[0]?.message ??
						{}) as IDataObject;
					returnData.push({
						json: {
							content: message.content ?? null,
							reasoning_content: message.reasoning_content ?? null,
							tool_calls: message.tool_calls ?? null,
							usage: response.usage ?? null,
						},
						pairedItem: { item: i },
					});
				} else {
					returnData.push({ json: response, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as JsonObject).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
