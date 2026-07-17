import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';

/**
 * Populates the Model dropdown from the LiteLLM proxy's own model list
 * (GET /models, OpenAI-compatible) instead of a hardcoded set — LiteLLM aliases
 * are whatever the proxy operator named them.
 */
export async function getModels(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials('liteLlmApi');
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'liteLlmApi', {
		method: 'GET',
		url: '/models',
		baseURL: credentials.baseUrl as string,
		json: true,
	})) as IDataObject;

	const models = (response.data as IDataObject[]) ?? [];
	return models
		.map((m) => (m.id as string) ?? '')
		.filter((id) => id.length > 0)
		.sort()
		.map((id) => ({ name: id, value: id }));
}
