import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticImageHeader, staticImageStream } from '../src/static-image.ts';

const webp = (animated: boolean) => {
  const bytes = new Uint8Array(100);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  bytes[20] = animated ? 2 : 0;
  return bytes;
};
test('animated WebP is rejected, including headers split over network chunks', async () => {
  const bytes = webp(true);
  assert.equal(staticImageHeader(bytes), false);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
  assert.equal(await staticImageStream(stream), null);
});
test('static WebP bytes are replayed exactly without truncation', async () => {
  const bytes = webp(false);
  const result = await staticImageStream(new Response(bytes).body!);
  assert.ok(result);
  assert.deepEqual(new Uint8Array(await new Response(result).arrayBuffer()), bytes);
});
test('APNG animation control before IDAT is rejected; static PNG is allowed', () => {
  const bytes = new Uint8Array(64);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode('acTL'), 12);
  assert.equal(staticImageHeader(bytes), false);
  bytes.set(new TextEncoder().encode('IDAT'), 12);
  assert.equal(staticImageHeader(bytes), true);
});
test('AVIF sequence brands are rejected when resizing', () => {
  const bytes = new Uint8Array(24);
  new DataView(bytes.buffer).setUint32(0, 24);
  bytes.set(new TextEncoder().encode('ftypavif'), 4);
  bytes.set(new TextEncoder().encode('avis'), 16);
  assert.equal(staticImageHeader(bytes), false);
});
