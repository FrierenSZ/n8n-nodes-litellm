// Self-check for the media content-part shapes. Run after a build: npm test
// Not shipped (package.json "files" is dist only) and not compiled (tsconfig
// only includes nodes/ and credentials/).
const assert = require('node:assert');
const { audioFormat, mediaPartFromBase64, mediaPartFromUrl } = require('./dist/nodes/shared/media');
const { isDeepSeekModel } = require('./dist/nodes/shared/deepseek');

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

// reasoning round-trip must trigger on LiteLLM aliases, not just bare names
assert.ok(isDeepSeekModel('deepseek-v4-flash'));
assert.ok(isDeepSeekModel('deepseek/deepseek-v4-flash'));
assert.ok(!isDeepSeekModel('gemini-2.5-flash-lite'));

console.log('selfcheck ok');
