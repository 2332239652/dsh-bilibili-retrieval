/**
 * Minimal PNG header reader for tests. Parses the signature and IHDR only —
 * enough to assert geometry and pixel format without pulling in an image
 * library.
 */

/**
 * Read a PNG's signature and IHDR fields.
 * @param {Uint8Array} bytes - file bytes.
 * @returns {{signature: boolean, width: number, height: number, bitDepth: number, colorType: number, interlace: number}}
 */
export function decodePngHeader(bytes) {
  const expected = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const signature = expected.every((byte, index) => bytes[index] === byte);
  if (!signature) return { signature: false, width: 0, height: 0, bitDepth: 0, colorType: -1, interlace: -1 };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 8 signature + 4 length + 4 type, then IHDR data.
  const dataStart = 16;
  return {
    signature: true,
    width: view.getUint32(dataStart),
    height: view.getUint32(dataStart + 4),
    bitDepth: bytes[dataStart + 8],
    colorType: bytes[dataStart + 9],
    interlace: bytes[dataStart + 12],
  };
}
