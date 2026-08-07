const utf8Encoder = new TextEncoder();

/** Encode a string as UTF-8 bytes without relying on a host-specific buffer type. */
export function encodeUtf8(value: string): Uint8Array {
  return utf8Encoder.encode(value);
}

/** Concatenate byte chunks into one exactly sized, runtime-neutral byte array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let byteLength = 0;
  for (const chunk of chunks) byteLength += chunk.byteLength;

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
