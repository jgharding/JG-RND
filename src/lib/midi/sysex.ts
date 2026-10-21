import {
  SYSEX_HEADER,
  SYSEX_TERMINATOR,
  type GlobalSettings,
  type TrackConfig,
  type StorageCheck,
} from '../types';

/**
 * Converts a Uint8Array or number array to an uppercase hex string without spaces.
 * Example: [0xF0, 0x6F, 0x62, 0x78, 0x10, ...] -> "F06F627810..."
 */
function bytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}

/**
 * Parses a hex string (with or without spaces) into a Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
  const sanitized = hex.replace(/[\s,]/g, '');
  if (sanitized.length % 2 !== 0) {
    throw new Error('Hex string must have an even number of characters');
  }
  const bytes = new Uint8Array(sanitized.length / 2);
  for (let i = 0; i < sanitized.length; i += 2) {
    bytes[i / 2] = parseInt(sanitized.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Checks if a byte sequence is a valid RND Synth SysEx message.
 */
function isValidRndSysEx(bytes: Uint8Array | number[]): boolean {
  if (bytes.length < 5) return false;
  if (bytes[0] !== SYSEX_HEADER[0]) return false; // 0xF0
  if (bytes[1] !== SYSEX_HEADER[1]) return false; // 0x6F
  if (bytes[2] !== SYSEX_HEADER[2]) return false; // 0x62
  if (bytes[3] !== SYSEX_HEADER[3]) return false; // 0x78
  if (bytes[bytes.length - 1] !== SYSEX_TERMINATOR) return false; // 0xF7
  return true;
}

type ParsedSysEx =
  | { type: 'seed'; seed: number; rawHex: string }
  | { type: 'delimiter' }
  | { type: 'global'; settings: GlobalSettings }
  | { type: 'track'; trackConfig: TrackConfig }
  | { type: 'rerollSeed'; track: number; seed: number }
  | { type: 'storageCheck'; check: StorageCheck }
  | {
      type: 'version';
      major: number;
      minor: number;
      patch: number;
      versionString: string;
      rawHex: string;
    }
  | { type: 'unknown'; command: number; rawHex: string };

/**
 * Parses an incoming RND Synth SysEx byte array.
 */
export function parseSysExMessage(bytes: Uint8Array): ParsedSysEx | null {
  if (!isValidRndSysEx(bytes)) return null;

  const command = bytes[4];
  const rawHex = bytesToHex(bytes);

  switch (command) {
    case 0x10: {
      // Seed payload: F0 6F 62 78 10 <b0> <b1> <b2> <b3> <b4> F7 (11 bytes)
      if (bytes.length < 11) return null;
      const b0 = bytes[5] & 0x7f;
      const b1 = bytes[6] & 0x7f;
      const b2 = bytes[7] & 0x7f;
      const b3 = bytes[8] & 0x7f;
      const b4 = bytes[9] & 0x0f;

      const seed =
        (b0 | (b1 << 7) | (b2 << 14) | (b3 << 21) | (b4 << 28)) >>> 0;

      return { type: 'seed', seed, rawHex };
    }

    case 0x20: {
      // Delimiter: F0 6F 62 78 20 F7 (6 bytes)
      return { type: 'delimiter' };
    }

    case 0x21: {
      // Global settings: F0 6F 62 78 21 <type> <bpm_l> <bpm_h> <root> <scale> F7 (11 bytes)
      if (bytes.length < 11) return null;
      const patchType = bytes[5] & 0x7f;
      const bpmLow = bytes[6] & 0x7f;
      const bpmHigh = bytes[7] & 0x7f;
      const bpm = (bpmLow | (bpmHigh << 7)) >>> 0;
      const root = bytes[8] & 0x7f;
      const scale = bytes[9] & 0x7f;

      return {
        type: 'global',
        settings: {
          type: Math.min(Math.max(patchType, 0), 2),
          bpm: Math.min(Math.max(bpm, 50), 200),
          root: Math.min(Math.max(root, 0), 11),
          scale: Math.min(Math.max(scale, 0), 19),
        },
      };
    }

    case 0x22: {
      // Track config: F0 6F 62 78 22 <track> <role> <mode> <name...> 00 F7
      if (bytes.length < 9) return null;
      const track = bytes[5] & 0x7f;
      const role = bytes[6] & 0x7f;
      const mode = bytes[7] & 0x7f;

      // Extract ASCII engine string up to 0x00 or F7
      let engineName = '';
      for (let i = 8; i < bytes.length - 1; i++) {
        if (bytes[i] === 0x00) break;
        engineName += String.fromCharCode(bytes[i]);
      }

      return {
        type: 'track',
        trackConfig: {
          track: Math.min(Math.max(track, 0), 3),
          active: true,
          role: Math.min(Math.max(role, 0), 3),
          mode: Math.min(Math.max(mode, 0), 2),
          engine: engineName.trim() || 'Unknown',
        },
      };
    }

    case 0x23: {
      // Reroll Seed Report (JGpatch-014): F0 6F 62 78 23 <track> <s0> <s1> <s2> <s3> <s4> F7
      if (bytes.length < 12) return null;
      const track = bytes[5] & 0x03;
      const seed =
        ((bytes[6] & 0x7f) |
          ((bytes[7] & 0x7f) << 7) |
          ((bytes[8] & 0x7f) << 14) |
          ((bytes[9] & 0x7f) << 21) |
          ((bytes[10] & 0x0f) << 28)) >>> 0;
      return { type: 'rerollSeed', track, seed };
    }

    case 0x24: {
      // RND STORAGE CHECK (JGpatch-019): F0 6F 62 78 24 <13 bytes> F7, 0x7F = unknown
      if (bytes.length < 18) return null;
      const b = (i: number) => bytes[5 + i] & 0x7f;
      const opt = (v: number) => (v === 0x7f ? null : v);
      return {
        type: 'storageCheck',
        check: {
          ramMask: b(0),
          savedMask: b(1),
          recordCount: b(2) | (b(3) << 7),
          validRecordLoaded: b(4) !== 0,
          flashError: b(5) !== 0,
          latestRecordMask: opt(b(6)),
          latestRecordValid: b(7) === 1,
          saveRequested: b(8) !== 0,
          cc14SaveRequests: opt(b(9)),
          recordWrites: opt(b(10)),
          bootRestoredMask: opt(b(11)),
          lastGenerationMask: opt(b(12)),
          receivedAt: Date.now(),
        },
      };
    }

    case 0x7f: {
      // Firmware Version Response: F0 6F 62 78 7F <base_major> <base_minor> <patch_lsb> <patch_msb> F7 (10 bytes)
      if (bytes.length < 10) return null;
      const major = bytes[5] & 0x7f;
      const minor = bytes[6] & 0x7f;
      const patchLsb = bytes[7] & 0x7f;
      const patchMsb = bytes[8] & 0x7f;
      const patch = (patchLsb | (patchMsb << 7)) >>> 0;
      const padNum = String(patch).padStart(3, '0');
      return {
        type: 'version',
        major,
        minor,
        patch,
        versionString: `v${major}.${minor}-JGpatch-${padNum}`,
        rawHex,
      };
    }

    default:
      return { type: 'unknown', command, rawHex };
  }
}

// ================= OUTGOING MESSAGE ENCODERS =================

/**
 * Builds Seed SysEx message (0x10):
 * F0 6F 62 78 10 <b0> <b1> <b2> <b3> <b4> F7
 */
export function buildSeedSysEx(seed: number): Uint8Array {
  const uSeed = seed >>> 0;
  const b0 = (uSeed >> 0) & 0x7f;
  const b1 = (uSeed >> 7) & 0x7f;
  const b2 = (uSeed >> 14) & 0x7f;
  const b3 = (uSeed >> 21) & 0x7f;
  const b4 = (uSeed >> 28) & 0x0f;

  return new Uint8Array([
    0xf0, 0x6f, 0x62, 0x78, 0x10, b0, b1, b2, b3, b4, 0xf7,
  ]);
}

/**
 * Builds Hardware Random Seed Generation SysEx message (0x10 with no payload bytes):
 * F0 6F 62 78 10 F7
 * Triggers hardware TRNG generator (0x8020b80) on the RND synth to generate a new random seed.
 */
export function buildGenerateSeedSysEx(): Uint8Array {
  return new Uint8Array([0xf0, 0x6f, 0x62, 0x78, 0x10, 0xf7]);
}

/**
 * Builds Hardware Trigger / Patch Dump SysEx message (0x18):
 * F0 6F 62 78 18 F7
 * Requests the synth to dump the currently active patch (0x800cc44) over MIDI.
 */
export function buildTriggerSysEx(): Uint8Array {
  return new Uint8Array([0xf0, 0x6f, 0x62, 0x78, 0x18, 0xf7]);
}

/**
 * Builds Re-randomize Track SysEx message (0x12):
 * F0 6F 62 78 12 <track: 00-03> F7
 */
export function buildRerollTrackSysEx(trackIndex: number): Uint8Array {
  return new Uint8Array([0xf0, 0x6f, 0x62, 0x78, 0x12, trackIndex & 0x03, 0xf7]);
}

/**
 * Builds Seeded Reroll Track SysEx message (0x1A, JGpatch-014):
 * F0 6F 62 78 1A <track: 00-03> <s0> <s1> <s2> <s3> <s4> F7
 * Replays an exact reroll from the 32-bit seed previously reported via 0x23.
 */
export function buildSeededRerollSysEx(trackIndex: number, seed: number): Uint8Array {
  const uSeed = seed >>> 0;
  return new Uint8Array([
    0xf0,
    0x6f,
    0x62,
    0x78,
    0x1a,
    trackIndex & 0x03,
    (uSeed >> 0) & 0x7f,
    (uSeed >> 7) & 0x7f,
    (uSeed >> 14) & 0x7f,
    (uSeed >> 21) & 0x7f,
    (uSeed >> 28) & 0x0f,
    0xf7,
  ]);
}

/**
 * Builds RND STORAGE CHECK query (0x1C, JGpatch-019): F0 6F 62 78 1C F7
 * The RND answers with SysEx 0x24 describing where TYPES TO GENERATE is stored.
 */
export function buildStorageCheckSysEx(): Uint8Array {
  return new Uint8Array([0xf0, 0x6f, 0x62, 0x78, 0x1c, 0xf7]);
}

/**
 * Builds Patch Load Hold SysEx message (0x1B, JGpatch-015):
 * F0 6F 62 78 1B <00 = release | 01 = hold> F7
 * While held, the RND keeps its sequencer and voices paused and silent (reverb/master keep running),
 * so a seed plus all saved overrides can be applied before the first note. Auto-releases after ~3 s.
 */
export function buildLoadHoldSysEx(hold: boolean): Uint8Array {
  return new Uint8Array([0xf0, 0x6f, 0x62, 0x78, 0x1b, hold ? 0x01 : 0x00, 0xf7]);
}

/**
 * Builds Direct Track Engine Selection SysEx message (0x19):
 * F0 6F 62 78 19 <track: 00-03> <engine_idx: 00-07> F7
 */
export function buildDirectEngineSysEx(trackIndex: number, engineIndex: number): Uint8Array {
  return new Uint8Array([
    0xf0,
    0x6f,
    0x62,
    0x78,
    0x19,
    trackIndex & 0x03,
    engineIndex & 0x07,
    0xf7,
  ]);
}

/**
 * Builds Track Mute SysEx message (0x16):
 * F0 6F 62 78 16 <track: 00-03> <00=Unmuted|01=Muted> F7
 */
export function buildMuteTrackSysEx(trackIndex: number, muted: boolean): Uint8Array {
  return new Uint8Array([
    0xf0,
    0x6f,
    0x62,
    0x78,
    0x16,
    trackIndex & 0x03,
    muted ? 0x01 : 0x00,
    0xf7,
  ]);
}

/**
 * Builds Track Solo SysEx message (0x17):
 * F0 6F 62 78 17 <track: 00-03> <00=Unsoloed|01=Soloed> F7
 */
export function buildSoloTrackSysEx(trackIndex: number, soloed: boolean): Uint8Array {
  return new Uint8Array([
    0xf0,
    0x6f,
    0x62,
    0x78,
    0x17,
    trackIndex & 0x03,
    soloed ? 0x01 : 0x00,
    0xf7,
  ]);
}

/**
 * Builds Global Settings SysEx message (0x21):
 * F0 6F 62 78 21 <type> <bpm_l> <bpm_h> <root> <scale> F7
 */
export function buildGlobalSettingsSysEx(settings: GlobalSettings): Uint8Array {
  const bpm = Math.round(settings.bpm);
  const bpmLow = bpm & 0x7f;
  const bpmHigh = (bpm >> 7) & 0x7f;

  return new Uint8Array([
    0xf0,
    0x6f,
    0x62,
    0x78,
    0x21,
    settings.type & 0x7f,
    bpmLow,
    bpmHigh,
    settings.root & 0x7f,
    settings.scale & 0x7f,
    0xf7,
  ]);
}

/**
 * Builds Firmware Version Inquiry SysEx message (0x7E):
 * F0 6F 62 78 7E F7
 */
export function buildVersionInquirySysEx(): Uint8Array {
  return new Uint8Array([0xf0, 0x6f, 0x62, 0x78, 0x7e, 0xf7]);
}
