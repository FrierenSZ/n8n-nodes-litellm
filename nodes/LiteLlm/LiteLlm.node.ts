import { Blob } from 'node:buffer';
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
import { mediaPartFromBase64, mediaPartFromUrl, type MediaKind } from '../shared/media';

interface ChatMessage {
	role: string;
	content: string;
}

/** How often to ask LiteLLM whether a video job finished. Generation takes minutes. */
const VIDEO_POLL_MS = 10_000;

/** Fetches a finished video and wraps it as a binary item. */
async function fetchVideo(
	ctx: IExecuteFunctions,
	i: number,
	baseURL: string,
	videoId: string,
	headers: IDataObject | undefined,
	binaryPropertyName: string,
): Promise<INodeExecutionData> {
	const content = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'liteLlmApi', {
		method: 'GET',
		url: `/videos/${videoId}/content`,
		baseURL,
		headers,
		encoding: 'arraybuffer',
		json: false,
	})) as Buffer;

	return {
		json: { id: videoId },
		binary: {
			[binaryPropertyName]: await ctx.helpers.prepareBinaryData(
				Buffer.from(content),
				'video.mp4',
				'video/mp4',
			),
		},
		pairedItem: { item: i },
	};
}

/**
 * Turns a provider's "I don't accept that content block" 400 into an actionable
 * message. The model list can't prevent this: LiteLLM reports
 * `supports_audio_input: null` both for models that do accept audio (Gemini) and
 * for models that don't (gpt-4.1-mini), so neither can be filtered out up front.
 */
function explainMediaRejection(ctx: IExecuteFunctions, i: number, error: unknown): unknown {
	const message = (error as JsonObject)?.message;
	const detail = typeof message === 'string' ? message : JSON.stringify(message ?? '');
	if (!/content blocks|image_url|input_audio|invalid.*messages/i.test(detail)) return error;

	return new NodeOperationError(
		ctx.getNode(),
		'This model rejected the file you sent — it cannot read that kind of input.',
		{
			itemIndex: i,
			description:
				'Pick a model that accepts this media type (Gemini handles image, audio, video and PDF; OpenAI GPT models take images and PDFs, but only the gpt-4o-audio line takes audio). The dropdown cannot filter these out because LiteLLM reports no audio/video capability for either kind of model.',
		},
	);
}

/** Reads the file the user pointed at and turns it into a chat content part. */
async function buildMediaPart(
	ctx: IExecuteFunctions,
	i: number,
	kind: MediaKind,
): Promise<IDataObject> {
	const inputType = ctx.getNodeParameter('inputType', i) as string;

	if (inputType === 'url') {
		const url = ctx.getNodeParameter('url', i) as string;
		if (kind !== 'audio') return mediaPartFromUrl(kind, url);
		// input_audio takes base64 only, so fetch the URL ourselves.
		const res = (await ctx.helpers.httpRequest({
			url,
			method: 'GET',
			encoding: 'arraybuffer',
			returnFullResponse: true,
			json: false,
		})) as { body: Buffer; headers: IDataObject };
		const contentType = ((res.headers['content-type'] as string) ?? 'audio/mpeg').split(';')[0];
		return mediaPartFromBase64(kind, Buffer.from(res.body).toString('base64'), contentType);
	}

	const binaryPropertyName = ctx.getNodeParameter('binaryPropertyName', i) as string;
	const meta = ctx.helpers.assertBinaryData(i, binaryPropertyName);
	const buffer = await ctx.helpers.getBinaryDataBuffer(i, binaryPropertyName);
	return mediaPartFromBase64(kind, buffer.toString('base64'), meta.mimeType);
}

export class LiteLlm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LiteLLM',
		name: 'liteLlm',
		icon: 'file:litellm.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Chat, analyze images/audio/video/documents and generate images via a LiteLLM proxy',
		defaults: { name: 'LiteLLM' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'liteLlmApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Audio', value: 'audio' },
					{ name: 'Document', value: 'document' },
					{ name: 'Image', value: 'image' },
					{ name: 'Text', value: 'text' },
					{ name: 'Video', value: 'video' },
				],
				default: 'text',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['text'] } },
				options: [
					{ name: 'Message a Model', value: 'message', action: 'Message a model' },
				],
				default: 'message',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['image'] } },
				options: [
					{ name: 'Analyze an Image', value: 'analyze', action: 'Analyze an image' },
					{ name: 'Generate an Image', value: 'generate', action: 'Generate an image' },
				],
				default: 'analyze',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['audio'] } },
				options: [
					{ name: 'Analyze Audio', value: 'analyze', action: 'Analyze audio' },
					{
						name: 'Transcribe a Recording',
						value: 'transcribe',
						action: 'Transcribe a recording',
					},
				],
				default: 'analyze',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['document'] } },
				options: [
					{ name: 'Analyze a Document', value: 'analyze', action: 'Analyze a document' },
				],
				default: 'analyze',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['video'] } },
				options: [
					{ name: 'Analyze a Video', value: 'analyze', action: 'Analyze a video' },
					{ name: 'Generate a Video', value: 'generateVideo', action: 'Generate a video' },
				],
				default: 'analyze',
			},
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getModels',
					loadOptionsDependsOn: ['resource', 'operation', 'showAllModels'],
				},
				default: '',
				required: true,
				description:
					'Models on your proxy that suit the chosen action. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Show All Models',
				name: 'showAllModels',
				type: 'boolean',
				default: false,
				description:
					'Whether to list every model on the proxy instead of only those suited to this action. Turn on if your model is missing.',
			},
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				placeholder: 'Add Message',
				default: { message: [{ role: 'user', content: '' }] },
				displayOptions: { show: { resource: ['text'] } },
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
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { operation: ['analyze', 'generate', 'generateVideo'] } },
				description: 'What to ask about the file, or what image/video to generate',
			},
			{
				displayName: 'Input Type',
				name: 'inputType',
				type: 'options',
				options: [
					{ name: 'Binary File', value: 'binary' },
					{ name: 'URL', value: 'url' },
				],
				default: 'binary',
				displayOptions: { show: { operation: ['analyze'] } },
			},
			{
				displayName: 'Input Data Field Name',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { operation: ['analyze'], inputType: ['binary'] } },
				description: 'Name of the binary field holding the file to send',
			},
			{
				displayName: 'Input Data Field Name',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { operation: ['transcribe'] } },
				description: 'Name of the binary field holding the recording to transcribe',
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['analyze'], inputType: ['url'] } },
				description: 'Publicly reachable URL of the file. Audio URLs are downloaded by the node.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['message', 'analyze'] } },
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
			{
				displayName: 'Options',
				name: 'imageOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['generate'] } },
				options: [
					{
						displayName: 'Number of Images',
						name: 'n',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 1,
					},
					{
						displayName: 'Put Output in Field',
						name: 'binaryPropertyName',
						type: 'string',
						default: 'data',
						description:
							'Binary field to store the image in, when the provider returns raw image data instead of a URL',
					},
					{
						displayName: 'Quality',
						name: 'quality',
						type: 'string',
						default: '',
						description: 'Provider-specific, e.g. "standard" or "hd"',
					},
					{
						displayName: 'Size',
						name: 'size',
						type: 'string',
						default: '',
						description: 'Provider-specific, e.g. "1024x1024"',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'videoOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['generateVideo'] } },
				options: [
					{
						displayName: 'Max Wait (Minutes)',
						name: 'maxWaitMinutes',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 10,
						description: 'How long to keep polling before giving up',
					},
					{
						displayName: 'Provider',
						name: 'provider',
						type: 'string',
						default: '',
						description:
							'Sent as the custom-llm-provider header, e.g. "openai". Only needed when LiteLLM cannot infer the provider from the video ID.',
					},
					{
						displayName: 'Put Output in Field',
						name: 'binaryPropertyName',
						type: 'string',
						default: 'data',
						description: 'Binary field to store the finished video in',
					},
					{
						displayName: 'Seconds',
						name: 'seconds',
						type: 'string',
						default: '',
						description: 'Video duration, provider-specific, e.g. "8"',
					},
					{
						displayName: 'Size',
						name: 'size',
						type: 'string',
						default: '',
						description: 'Provider-specific, e.g. "720x1280"',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'transcribeOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { operation: ['transcribe'] } },
				options: [
					{
						displayName: 'Language',
						name: 'language',
						type: 'string',
						default: '',
						description: 'ISO-639-1 code of the spoken language, e.g. "pt". Improves accuracy.',
					},
					{
						displayName: 'Prompt',
						name: 'prompt',
						type: 'string',
						default: '',
						description: 'Hint to guide spelling of names or jargon',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
						default: 0,
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
		const baseURL = (await this.getCredentials('liteLlmApi')).baseUrl as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const model = this.getNodeParameter('model', i) as string;

				if (operation === 'transcribe') {
					const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;
					const options = this.getNodeParameter('transcribeOptions', i, {}) as IDataObject;
					const meta = this.helpers.assertBinaryData(i, binaryPropertyName);
					const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);

					const form = new FormData();
					form.append(
						'file',
						new Blob([buffer], { type: meta.mimeType }) as unknown as Blob,
						meta.fileName ?? 'audio',
					);
					form.append('model', model);
					if (options.language) form.append('language', options.language as string);
					if (options.prompt) form.append('prompt', options.prompt as string);
					if (options.temperature !== undefined)
						form.append('temperature', String(options.temperature));

					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'liteLlmApi',
						{ method: 'POST', url: '/audio/transcriptions', baseURL, body: form },
					)) as IDataObject;

					returnData.push({ json: response, pairedItem: { item: i } });
					continue;
				}

				if (operation === 'generateVideo') {
					const prompt = this.getNodeParameter('prompt', i) as string;
					const options = this.getNodeParameter('videoOptions', i, {}) as IDataObject;
					const headers = options.provider
						? { 'custom-llm-provider': options.provider as string }
						: undefined;

					const body: IDataObject = { model, prompt };
					if (options.seconds) body.seconds = String(options.seconds);
					if (options.size) body.size = options.size;

					let job = (await this.helpers.httpRequestWithAuthentication.call(this, 'liteLlmApi', {
						method: 'POST',
						url: '/videos',
						baseURL,
						headers,
						body,
						json: true,
					})) as IDataObject;

					const videoId = job.id as string;
					const deadline = Date.now() + ((options.maxWaitMinutes as number) ?? 10) * 60_000;
					while (job.status !== 'completed') {
						if (job.status === 'failed') {
							throw new NodeOperationError(
								this.getNode(),
								`Video generation failed: ${JSON.stringify(job.error ?? job)}`,
								{ itemIndex: i },
							);
						}
						if (Date.now() > deadline) {
							throw new NodeOperationError(
								this.getNode(),
								`Video ${videoId} was still "${job.status}" after the maximum wait. Raise Max Wait (Minutes) if the model needs longer.`,
								{ itemIndex: i },
							);
						}
						await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_MS));
						job = (await this.helpers.httpRequestWithAuthentication.call(this, 'liteLlmApi', {
							method: 'GET',
							url: `/videos/${videoId}`,
							baseURL,
							headers,
							json: true,
						})) as IDataObject;
					}

					returnData.push(
						await fetchVideo(
							this,
							i,
							baseURL,
							videoId,
							headers,
							(options.binaryPropertyName as string) ?? 'data',
						),
					);
					continue;
				}

				if (operation === 'generate') {
					const prompt = this.getNodeParameter('prompt', i) as string;
					const options = this.getNodeParameter('imageOptions', i, {}) as IDataObject;

					const body: IDataObject = { model, prompt };
					if (options.n !== undefined) body.n = options.n;
					if (options.size) body.size = options.size;
					if (options.quality) body.quality = options.quality;

					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'liteLlmApi',
						{ method: 'POST', url: '/images/generations', baseURL, body, json: true },
					)) as IDataObject;

					const binaryPropertyName = (options.binaryPropertyName as string) ?? 'data';
					for (const image of (response.data as IDataObject[]) ?? []) {
						// Providers return either a hosted URL or raw base64; only the latter
						// can be handed to downstream nodes as a file.
						if (!image.b64_json) {
							returnData.push({ json: image, pairedItem: { item: i } });
							continue;
						}
						const buffer = Buffer.from(image.b64_json as string, 'base64');
						returnData.push({
							json: { revised_prompt: image.revised_prompt ?? null },
							binary: {
								[binaryPropertyName]: await this.helpers.prepareBinaryData(
									buffer,
									'image.png',
									'image/png',
								),
							},
							pairedItem: { item: i },
						});
					}
					continue;
				}

				// message + analyze both go to /chat/completions
				const options = this.getNodeParameter('options', i, {}) as IDataObject;
				let messages: IDataObject[];

				if (operation === 'analyze') {
					const prompt = this.getNodeParameter('prompt', i) as string;
					const part = await buildMediaPart(this, i, resource as MediaKind);
					messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, part] }];
				} else {
					const messagesUi = this.getNodeParameter('messages.message', i, []) as ChatMessage[];
					if (!messagesUi.length) {
						throw new NodeOperationError(this.getNode(), 'At least one message is required', {
							itemIndex: i,
						});
					}
					messages = messagesUi.map((m) => ({ role: m.role, content: m.content }));
				}

				const body: IDataObject = { model, messages };

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
					{ method: 'POST', url: '/chat/completions', baseURL, body, json: true },
				)) as IDataObject;

				const simplify = options.simplify !== false;
				if (simplify) {
					const message = ((response.choices as IDataObject[])?.[0]?.message ?? {}) as IDataObject;
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
				throw explainMediaRejection(this, i, error);
			}
		}

		return [returnData];
	}
}
