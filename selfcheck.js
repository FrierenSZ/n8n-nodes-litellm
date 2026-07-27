// Self-check for the pure logic. Run after a build: npm test
// Not shipped (package.json "files" is dist only) and not compiled (tsconfig
// only includes nodes/ and credentials/).
const assert = require('node:assert');
const { audioFormat, mediaPartFromBase64, mediaPartFromUrl } = require('./dist/nodes/shared/media');
const { isDeepSeekModel } = require('./dist/nodes/shared/deepseek');
const {
	filterModels,
	parseModelInfo,
	proxyRoot,
	OPERATION_REQUIREMENTS: REQ,
} = require('./dist/nodes/shared/loadModels');

// --- media content parts ------------------------------------------------

// input_audio.format wants a codec name, not the MIME subtype
assert.strictEqual(audioFormat('audio/mpeg'), 'mp3');
assert.strictEqual(audioFormat('audio/x-wav'), 'wav');
assert.strictEqual(audioFormat('audio/wav;codecs=1'), 'wav');
assert.strictEqual(audioFormat('audio/ogg'), 'ogg');

// each media kind has its own part shape — a wrong one 400s at the provider
assert.deepStrictEqual(mediaPartFromBase64('image', 'QUJD', 'image/png'), {
	type: 'image_url',
	image_url: { url: 'data:image/png;base64,QUJD' },
});
assert.deepStrictEqual(mediaPartFromBase64('audio', 'QUJD', 'audio/mpeg'), {
	type: 'input_audio',
	input_audio: { data: 'QUJD', format: 'mp3' },
});
assert.deepStrictEqual(mediaPartFromBase64('video', 'QUJD', 'video/mp4'), {
	type: 'video_url',
	video_url: { url: 'data:video/mp4;base64,QUJD' },
});
assert.deepStrictEqual(mediaPartFromBase64('document', 'QUJD', 'application/pdf'), {
	type: 'file',
	file: { file_data: 'data:application/pdf;base64,QUJD' },
});
assert.deepStrictEqual(mediaPartFromUrl('image', 'http://x/a.png'), {
	type: 'image_url',
	image_url: { url: 'http://x/a.png' },
});
assert.deepStrictEqual(mediaPartFromUrl('document', 'http://x/a.pdf'), {
	type: 'file',
	file: { file_id: 'http://x/a.pdf' },
});

// --- proxy URL ----------------------------------------------------------

// management endpoints live at the proxy root, never under /v1
assert.strictEqual(proxyRoot('http://litellm:4000/v1'), 'http://litellm:4000');
assert.strictEqual(proxyRoot('http://litellm:4000/v1/'), 'http://litellm:4000');
assert.strictEqual(proxyRoot('http://litellm:4000'), 'http://litellm:4000');
assert.strictEqual(proxyRoot('http://litellm:4000/'), 'http://litellm:4000');
// only a trailing /v1 is the prefix — a host or mid-path "v1" must stay put
assert.strictEqual(proxyRoot('https://v1.example.com'), 'https://v1.example.com');
assert.strictEqual(proxyRoot('https://x.com/v1/proxy'), 'https://x.com/v1/proxy');

// --- /model/info parsing ------------------------------------------------

// every shape LiteLLM ships must yield the same mode
for (const payload of [
	{ data: [{ model_name: 'a', model_info: { mode: 'chat' } }] }, // /model/info
	{ data: [{ model_group: 'a', mode: 'chat' }] }, //               /model_group/info
	{ a: { model_info: { mode: 'chat' } } }, //                      older object form
]) {
	assert.strictEqual(parseModelInfo(payload).get('a').mode, 'chat');
}
assert.deepStrictEqual(parseModelInfo({}), new Map());
assert.deepStrictEqual(parseModelInfo({ data: [] }), new Map());
// capabilities nested under model_info must surface at the top level, since
// /model_group/info reports the same fields flat
assert.strictEqual(
	parseModelInfo({ data: [{ model_name: 'a', model_info: { supports_vision: true } }] }).get('a')
		.supports_vision,
	true,
);

// --- model filtering ----------------------------------------------------

// mirrors what a real proxy reports: supports_vision is populated, audio/pdf are
// mostly null, and models outside LiteLLM's cost map are absent entirely
const infos = parseModelInfo({
	data: [
		{ model_group: 'gpt', mode: 'chat', supports_vision: true, supports_pdf_input: true },
		{ model_group: 'gemini', mode: 'chat', supports_vision: true },
		{ model_group: 'text-only', mode: 'chat', supports_vision: false },
		{ model_group: 'audio-only', mode: 'chat', supports_vision: false, supports_audio_input: true },
		{ model_group: 'whisper', mode: 'audio_transcription' },
		{ model_group: 'embed', mode: 'embedding' },
	],
});
const ids = ['gpt', 'gemini', 'text-only', 'audio-only', 'whisper', 'embed', 'unlisted'].sort();
const shown = (key) => filterModels(ids, infos, REQ[key]);

for (const key of ['image:analyze', 'audio:analyze', 'document:analyze', 'video:analyze']) {
	// a text-only model can't read a file, and a non-chat model isn't even the right endpoint
	assert.ok(!shown(key).includes('text-only'), `${key} must drop text-only`);
	assert.ok(!shown(key).includes('whisper'), `${key} must drop non-chat models`);
	assert.ok(!shown(key).includes('embed'), `${key} must drop embeddings`);
	// a model the proxy knows nothing about is never hidden
	assert.ok(shown(key).includes('unlisted'), `${key} must keep unknown models`);
	assert.ok(shown(key).includes('gemini'), `${key} must keep multimodal models`);
}
// an explicit audio flag qualifies a model that has no vision, and only for audio
assert.ok(shown('audio:analyze').includes('audio-only'));
assert.ok(!shown('image:analyze').includes('audio-only'));

// transcription is its own mode, not a chat model
assert.deepStrictEqual(shown('audio:transcribe'), ['unlisted', 'whisper']);
assert.deepStrictEqual(filterModels(ids, infos, { mode: 'embedding' }), ['embed', 'unlisted']);
// capabilities unreadable (403 on the info routes) -> nothing is filtered
assert.deepStrictEqual(filterModels(ids, new Map(), REQ['image:analyze']), ids);
// no model here generates video, so only the ones the proxy can't classify remain
assert.deepStrictEqual(filterModels(ids, infos, { mode: 'video_generation' }), ['unlisted']);
// "nothing here does that" is an honest empty list, not a reason to show everything
assert.deepStrictEqual(filterModels(['gpt'], infos, { mode: 'video_generation' }), []);

// --- DeepSeek detection -------------------------------------------------

// reasoning round-trip must trigger on LiteLLM aliases, not just bare names
assert.ok(isDeepSeekModel('deepseek-v4-flash'));
assert.ok(isDeepSeekModel('deepseek/deepseek-v4-flash'));
assert.ok(!isDeepSeekModel('gemini-2.5-flash-lite'));

console.log('selfcheck ok');
