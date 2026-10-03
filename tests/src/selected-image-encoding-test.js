#!/usr/bin/env node

const assert = require('node:assert/strict');
const { buildSelectedContextForImages, loadProto } = require('../../src/cursor-agent.js');

(async () => {
  const { create, agent } = await loadProto();
  const bytes = Buffer.from('png-bytes');
  const selectedContext = buildSelectedContextForImages(create, agent, [{
    kind: 'image',
    mediaType: 'image/png',
    dataBase64: bytes.toString('base64'),
    width: 1,
    height: 2,
  }]);

  assert(selectedContext, 'selectedContext should be created for image input');
  assert.equal(selectedContext.selectedImages.length, 1);
  const image = selectedContext.selectedImages[0];
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.dataOrBlobId.case, 'data');
  assert.deepEqual(Buffer.from(image.dataOrBlobId.value), bytes);
  assert.equal(image.dimension.width, 1);
  assert.equal(image.dimension.height, 2);

  console.log('selected-image-encoding-test: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
