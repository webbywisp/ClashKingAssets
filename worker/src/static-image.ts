// Inspect container metadata, not decoded pixels. null means more header bytes
// are needed. Reject animations so clients can fall back to their original URL.
export function staticImageHeader(bytes: Uint8Array): boolean | null {
  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length < 12) return null;
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
    if (bytes.length < 21) return null;
    return text(12, 16) !== 'VP8X' || (bytes[20] & 2) === 0;
  }
  if (bytes[0] === 137 && text(1, 4) === 'PNG') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const size = view.getUint32(offset);
      const type = text(offset + 4, offset + 8);
      if (type === 'acTL') return false;
      if (type === 'IDAT' || type === 'IEND') return true;
      offset += size + 12;
    }
    return null;
  }
  if (text(4, 8) === 'ftyp') {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16) return false;
    if (bytes.length < size) return null;
    for (let offset = 8; offset + 4 <= size; offset += 4) {
      if (offset !== 12 && text(offset, offset + 4) === 'avis') return false;
    }
  }
  return true; // Other/invalid encodings are validated by Images.
}

/** Buffer only header metadata; replay consumed chunks and stream the remainder. */
export async function staticImageStream(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const header = new Uint8Array(65_536);
  let length = 0;
  let ended = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { ended = true; break; }
      chunks.push(chunk.value);
      const copied = Math.min(chunk.value.length, header.length - length);
      header.set(chunk.value.subarray(0, copied), length);
      length += copied;
      const supported = staticImageHeader(header.subarray(0, length));
      if (supported === false || (supported === null && length === header.length)) {
        await reader.cancel();
        return null;
      }
      if (supported === true) break;
    }
    // Truncated headers cannot be an animation; the encoder will reject them.
    let index = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < chunks.length) { controller.enqueue(chunks[index++]); return; }
        if (ended) { controller.close(); reader.releaseLock(); return; }
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); reader.releaseLock(); }
          else controller.enqueue(chunk.value);
        } catch (error) { controller.error(error); reader.releaseLock(); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}
