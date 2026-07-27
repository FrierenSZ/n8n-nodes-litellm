import type { IDataObject } from 'n8n-workflow';

export type MediaKind = 'image' | 'audio' | 'video' | 'document';

/**
 * `input_audio.format` wants a bare codec name ("wav", "mp3") — not the MIME
 * subtype it usually arrives as.
 */
export function audioFormat(mimeType: string): string {
	const subtype = (mimeType.split('/')[1] ?? '').split(';')[0].toLowerCase();
	if (subtype === 'mpeg' || subtype === 'mpga') return 'mp3';
	if (subtype === 'x-wav' || subtype === 'wave') return 'wav';
	return subtype;
}

/**
 * Multimodal content parts have a different shape per media kind — see
 * https://docs.litellm.ai/docs/completion/input. LiteLLM forwards these to the
 * upstream provider (Gemini, GPT, ...), so the shape has to be exact.
 */
export function mediaPartFromBase64(
	kind: MediaKind,
	base64: string,
	mimeType: string,
): IDataObject {
	const dataUri = `data:${mimeType};base64,${base64}`;
	switch (kind) {
		case 'audio':
			return { type: 'input_audio', input_audio: { data: base64, format: audioFormat(mimeType) } };
		case 'video':
			return { type: 'video_url', video_url: { url: dataUri } };
		case 'document':
			return { type: 'file', file: { file_data: dataUri } };
		default:
			return { type: 'image_url', image_url: { url: dataUri } };
	}
}

/**
 * Pass a URL straight through where the provider accepts one, so we don't pay to
 * download and re-upload the file. Audio is excluded on purpose: `input_audio`
 * only takes base64, so the node fetches those itself.
 */
export function mediaPartFromUrl(kind: Exclude<MediaKind, 'audio'>, url: string): IDataObject {
	switch (kind) {
		case 'video':
			return { type: 'video_url', video_url: { url } };
		case 'document':
			return { type: 'file', file: { file_id: url } };
		default:
			return { type: 'image_url', image_url: { url } };
	}
}
