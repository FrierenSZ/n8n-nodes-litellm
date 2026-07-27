import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';

/** What a model must be/do to be worth offering for a given operation. */
export interface ModelRequirement {
	/** LiteLLM's `mode`: which endpoint the model serves. One value per model. */
	mode?: string;
	/**
	 * `supports_*` flags. A model qualifies if ANY of them is true, or if it
	 * declares none of them — see `filterModels` for why it is an OR.
	 */
	supports?: string[];
}

/**
 * `mode` says which endpoint a model serves; the `supports_*` booleans say what it
 * can ingest. A vision model is still `mode: "chat"` — so image/audio/document
 * analysis has to check both: a chat model AND the right capability flag.
 *
 * Keyed `resource:operation` to match the action node's parameters.
 */
export const OPERATION_REQUIREMENTS: Record<string, ModelRequirement> = {
	'text:message': { mode: 'chat' },
	'image:generate': { mode: 'image_generation' },
	'audio:transcribe': { mode: 'audio_transcription' },
	'video:generateVideo': { mode: 'video_generation' },

	// Reading a file needs a multimodal chat model. In practice LiteLLM only fills
	// in supports_vision — supports_audio_input is null even for models that do
	// hear, and there is no video flag at all. So each of these also accepts
	// supports_vision as the "this model is multimodal" signal, which is what
	// actually separates them from the text-only models.
	'image:analyze': { mode: 'chat', supports: ['supports_vision'] },
	'audio:analyze': { mode: 'chat', supports: ['supports_audio_input', 'supports_vision'] },
	'document:analyze': { mode: 'chat', supports: ['supports_pdf_input', 'supports_vision'] },
	'video:analyze': { mode: 'chat', supports: ['supports_vision'] },
};

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
 * Capability records per model, from LiteLLM's own info routes.
 *
 * Both routes are admin-only. A virtual key scoped to `llm_api_routes` — the right
 * way to key n8n — gets `403 Virtual key is not allowed to call this route`, so an
 * empty map is the normal case, not an error. Callers fall back to no filtering.
 */
async function modelInfo(
	ctx: ILoadOptionsFunctions,
	baseURL: string,
): Promise<Map<string, IDataObject>> {
	const infos = new Map<string, IDataObject>();
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

			// Merge field by field, not record by record: /model_group/info returns a
			// slim projection (only supports_vision), while /model/info carries the
			// full set (supports_audio_input, supports_pdf_input, ...). Replacing
			// wholesale would throw away whichever arrived second.
			for (const [name, info] of parseModelInfo(response)) {
				const merged = infos.get(name) ?? {};
				for (const [field, value] of Object.entries(info)) {
					if (merged[field] == null) merged[field] = value;
				}
				infos.set(name, merged);
			}
		} catch {
			// forbidden or absent -> try the next one
		}
	}
	return infos;
}

/**
 * Flattens either shape LiteLLM ships: `{data: [...]}` keyed by `model_name`
 * (/model/info, capabilities nested under `model_info`) or by `model_group`
 * (/model_group/info, capabilities at the top level); plus the older object-keyed
 * form. Returns one flat record per model so `mode` and `supports_*` read alike.
 */
export function parseModelInfo(response: IDataObject): Map<string, IDataObject> {
	const infos = new Map<string, IDataObject>();
	const payload = (response?.data ?? response) as IDataObject | IDataObject[] | undefined;
	if (!payload) return infos;

	const entries: Array<[string, IDataObject]> = Array.isArray(payload)
		? payload.map((e) => [((e?.model_name ?? e?.model_group) as string) ?? '', e ?? {}])
		: Object.entries(payload).map(([name, e]) => [name, (e as IDataObject) ?? {}]);

	for (const [name, entry] of entries) {
		if (!name) continue;
		infos.set(name, { ...entry, ...((entry.model_info as IDataObject) ?? {}) });
	}
	return infos;
}

/**
 * Keeps models that meet the requirement, plus any the proxy told us nothing about.
 * LiteLLM knows nothing about models missing from its cost map (custom aliases,
 * self-hosted), and hiding those would drop models that work fine.
 *
 * An empty result is a real answer — "no model here does that" — not a failure to
 * report. Callers skip this entirely when capabilities are unreadable, so nothing
 * lands here without data to judge on.
 */
export function filterModels(
	ids: string[],
	infos: Map<string, IDataObject>,
	requirement: ModelRequirement,
): string[] {
	return ids.filter((id) => {
		const info = infos.get(id);
		if (info?.mode == null) return true;
		if (requirement.mode && info.mode !== requirement.mode) return false;
		if (!requirement.supports) return true;

		// OR, not AND: one true flag is enough. And a model that declares none of
		// them is kept — LiteLLM leaves most of these null, so treating null as
		// "no" would hide models that work.
		const flags = requirement.supports.map((flag) => info[flag]);
		return flags.some((v) => v === true) || flags.every((v) => v == null);
	});
}

async function loadModels(
	ctx: ILoadOptionsFunctions,
	requirement?: ModelRequirement,
): Promise<INodePropertyOptions[]> {
	const baseURL = (await ctx.getCredentials('liteLlmApi')).baseUrl as string;
	const ids = await listModelIds(ctx, baseURL);
	const infos = await modelInfo(ctx, baseURL);

	const showAll = requirement ? ctx.getNodeParameter('showAllModels', false) === true : true;
	// Filtering is a convenience that needs admin-only routes; degrade to the full
	// list rather than breaking the dropdown for a normally-scoped key.
	const visible = showAll || infos.size === 0 ? ids : filterModels(ids, infos, requirement!);

	return visible.map((id) => ({
		name: id,
		value: id,
		description: (infos.get(id)?.mode as string) ?? undefined,
	}));
}

/** Loader for sub-nodes, which serve exactly one kind of model. */
export function getModelsFor(requirement: ModelRequirement) {
	return async function (this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		return loadModels(this, requirement);
	};
}

/** Loader for the action node, where the kind depends on the chosen operation. */
export async function getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const resource = this.getNodeParameter('resource', '') as string;
	const operation = this.getNodeParameter('operation', '') as string;
	return loadModels(this, OPERATION_REQUIREMENTS[`${resource}:${operation}`]);
}
