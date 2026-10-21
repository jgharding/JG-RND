// Applies a JG-RND patch file (public/firmware/jgpatch-0NN.json, made by make_jgpatch.py) to the
// official stock RNDsynth-v1.3.bin. Only JG-authored bytes are hosted; the stock image comes from the user.

export interface JgPatchRecord {
  offset: number;
  bytesHex: string;
}

export interface JgPatchFile {
  version: string;
  baseSha256: string;
  baseSize: number;
  resultSha256: string;
  resultSize: number;
  patches: JgPatchRecord[];
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Same algorithm as apply_records() in make_jgpatch.py. Both hashes are checked, so nothing
// unverified can reach the flasher.
export async function applyJgPatch(stock: ArrayBuffer, patch: JgPatchFile): Promise<Uint8Array> {
  if (stock.byteLength !== patch.baseSize || (await sha256Hex(stock)) !== patch.baseSha256) {
    throw new Error("This isn't the official RNDsynth v1.3 file. Download it again from Cyma Forma.");
  }

  const result = new Uint8Array(patch.resultSize);
  result.set(new Uint8Array(stock).subarray(0, patch.resultSize));
  for (const record of patch.patches) {
    const bytes = hexToBytes(record.bytesHex);
    if (record.offset + bytes.length > patch.resultSize) {
      throw new Error('Patch file is corrupt (record past end of image).');
    }
    result.set(bytes, record.offset);
  }

  if ((await sha256Hex(result)) !== patch.resultSha256) {
    throw new Error('Patched firmware failed verification. Nothing will be flashed.');
  }
  return result;
}
