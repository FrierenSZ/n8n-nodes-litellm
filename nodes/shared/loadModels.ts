import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';

/**
 * LiteLLM's management endpoints (/model/info, /model_group/info) live at the proxy
 * root. Only the OpenAI-compatible routes answer under /v1, so a credential whose
 * Base URL ends in /v1 loads models fine but 404s on capabilities.
 */
export function proxyRoot(baseURL: string): string {
	return baseURL.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Model IDs from the OpenAI-compatible list. Carries no capability info. */
async function listModelIds(ctx: ILoadOptionsFunctions, baseURL: string): Promise<string[]> {
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'liteLlmApi', {
		method: 'GET',
		url: '/models',
		baseURL,
		json: true,
	})) as IDataObject;

	return ((response.data as IDataObject[]) ?? [])
		.map((m) => (m.id as string) ?? '')
		.filter((id) => id.length > 0)
		.sort();
}

/**
 * `mode` ("chat", "embedding", "image_generation", ...) comes from LiteLLM's own
 * /model/info — the OpenAI-compatible /models has no such field.
 *
 * Both routes are admin-only. A virtual key scoped to `llm_api_routes` — the right
 * way to key n8n — gets `403 Virtual key is not allowed to call this route`, so an
 * empty map is the normal case, not an error. Callers fall back to no filtering.
 */
async function modelModes(
	ctx: ILoadOptionsFunctions,
	baseURL: string,
): Promise<Map<string, string | null>> {
	const modes = new Map<string, string | null>();
	const root = proxyRoot(baseURL);

	// /model_group/info is scoped to what the key may use, /model/info is the full
	// admin view. Try both and merge, preferring whichever reports a mode.
	for (const url of ['/model_group/info', '/model/info']) {
		try {
			const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'liteLlmApi', {
				method: 'GET',
				url,
				baseURL: root,
				json: true,
			})) as IDataObject;

			for (const [name, mode] of parseModelModes(response)) {
				if (modes.get(name) == null) modes.set(name, mode);
			}
		} catch {
			// forbidden or absent -> try the next one
		}
	}
	return modes;
}

/**
 * /model/info has shipped in two shapes: `{data: [{model_name, model_info}]}` and
 * an object keyed by model name. Read both — guessing wrong just yields an empty
 * map, which silently disables filtering and looks like the feature is broken.
 */
export function parseModelModes(response: IDataObject): Map<string, string | null> {
	const modes = new Map<string, string | null>();
	const payload = (response?.data ?? response) as IDataObject | IDataObject[] | undefined;
	if (!payload) return modes;

	const entries: Array<[string, IDataObject]> = Array.isArray(payload)
		? // /model/info keys it as model_name, /model_group/info as model_group
			payload.map((e) => [((e?.model_name ?? e?.model_group) as string) ?? '', e ?? {}])
		: Object.entries(payload).map(([name, e]) => [name, (e as IDataObject) ?? {}]);

	for (const [name, entry] of entries) {
		if (!name) continue;
		const info = (entry.model_info as IDataObject) ?? {};
		// `mode` sits under model_info, but tolerate it at the top level too.
		modes.set(name, (info.mode as string) ?? (entry.mode as string) ?? null);
	}
	return modes;
}

/**
 * Keeps models whose mode matches, plus any whose mode is unknown. LiteLLM reports
 * `mode: null` for models missing from its cost map (custom aliases, self-hosted),
 * and hiding those would silently drop models that work fine.
 */
export function filterByMode(
	ids: string[],
	modes: Map<string, string | null>,
	mode: string,
): string[] {
	const matching = ids.filter((id) => {
		const known = modes.get(id);
		return known == null || known === mode;
	});
	// Never hand back an empty dropdown — that reads as "broken", not "filtered".
	return matching.length ? matching : ids;
}

/**
 * Builds the Model dropdown loader. Pass a mode to show only models of that kind;
 * omit it to list everything. Nodes that filter also honour a `showAllModels`
 * boolean parameter as an escape hatch.
 */
export function getModelsFor(mode?: string) {
	return async function (this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		const baseURL = (await this.getCredentials('liteLlmApi')).baseUrl as string;
		const ids = await listModelIds(this, baseURL);
		const modes = await modelModes(this, baseURL);

		const showAll = mode ? this.getNodeParameter('showAllModels', false) === true : true;

		// Capabilities live behind admin-only routes: a virtual key scoped to
		// `llm_api_routes` (the sane way to key n8n) gets 403 there. Filtering is a
		// convenience, so degrade to the full list instead of breaking the dropdown.
		const visible = showAll || modes.size === 0 ? ids : filterByMode(ids, modes, mode!);

		return visible.map((id) => ({
			name: id,
			value: id,
			// Shows what /model/info reported for this model. If NO model has a
			// description, this key cannot read /model/info — which is also why
			// nothing got filtered out.
			description: modes.get(id) ?? undefined,
		}));
	};
}

/** Unfiltered loader, for nodes whose model kind depends on the chosen operation. */
export const getModels = getModelsFor();
