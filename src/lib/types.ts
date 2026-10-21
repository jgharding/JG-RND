export interface GlobalSettings {
  type: number; // 0 = Looping Sequence, 1 = Drone, 2 = Jingle
  bpm: number;  // 50 - 200
  root: number; // 0 - 11 (C to B)
  scale: number; // 0 - 19
  octave?: number; // 0 - 8 (default 4)
}

export interface TrackConfig {
  track: number; // 0 - 3
  active: boolean;
  role: number; // 0 = Lead, 1 = Bass, 2 = Arp/Chord, 3 = Percussion
  mode: number; // 0 = Mono, 1 = Poly (4-voice), 2 = Drone/Sustain
  engine: string; // Engine name e.g. "FM", "Acid (303)", etc.
  originalEngine?: string; // Original randomly generated engine from hardware seed
  muted?: boolean;
  soloed?: boolean;
}

export interface AlteredControls {
  bpm?: number;
  root?: number;
  octave?: number;
  scale?: number;
  masterVolume?: number;
  masterReverb?: number;
  trackVolumes?: { [track: number]: number }; // track: 0..3
  trackReverbs?: { [track: number]: number }; // track: 0..3
  reverbParams?: { [cc: number]: number };    // cc: 85..90
  mutes?: boolean[];                          // indices 0..3
  solos?: boolean[];                          // indices 0..3
  engines?: { [track: number]: number | string }; // track: 0..3 -> engine index (0..7) or name
  rerolls?: (number | boolean)[];                 // indices 0..3: reroll count / PRNG state (or boolean)
  rerollSeeds?: (number | null)[];                // indices 0..3: 32-bit TRNG seed of the last reroll (JGpatch-014 SysEx 0x23)
}

export function getRerollCount(val: any): number {
  if (typeof val === 'number') return Math.max(0, val);
  if (typeof val === 'boolean') return val ? 1 : 0;
  return 0;
}

/** Returns a valid unsigned 32-bit reroll seed, or undefined if none is stored. */
export function getRerollSeed(val: any): number | undefined {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 0xffffffff) return undefined;
  return val;
}

/** CSV REROLL cell: "<count>" or "<count>:<8-digit hex seed>" (seed enables exact replay on JGpatch-014+). */
export function formatRerollCell(count: number, seed?: number): string {
  if (count <= 0) return '';
  const s = getRerollSeed(seed);
  return s !== undefined ? `${count}:${s.toString(16).toUpperCase().padStart(8, '0')}` : String(count);
}

export function resolveEngineIndex(val: any): number {
  if (val === undefined || val === null || val === '' || val === '—') return -1;
  if (typeof val === 'number') {
    return val >= 0 && val < SYNTH_ENGINES.length ? val : -1;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    const parsed = parseInt(trimmed, 10);
    if (!isNaN(parsed) && String(parsed) === trimmed && parsed >= 0 && parsed < SYNTH_ENGINES.length) {
      return parsed;
    }
    const idx = SYNTH_ENGINES.indexOf(trimmed as any);
    if (idx >= 0) return idx;
    const lower = trimmed.toLowerCase();
    const ciIdx = SYNTH_ENGINES.findIndex((e) => e.toLowerCase() === lower);
    if (ciIdx >= 0) return ciIdx;
  }
  return -1;
}

export function resolveEngineName(val: any): string {
  const idx = resolveEngineIndex(val);
  return idx >= 0 ? SYNTH_ENGINES[idx] : 'FM';
}

export function hasAlteredControls(altered?: AlteredControls): boolean {
  if (!altered) return false;
  if (altered.bpm !== undefined) return true;
  if (altered.root !== undefined) return true;
  if (altered.octave !== undefined) return true;
  if (altered.scale !== undefined) return true;
  if (altered.masterVolume !== undefined) return true;
  if (altered.masterReverb !== undefined) return true;
  if (altered.trackVolumes && Object.keys(altered.trackVolumes).length > 0) return true;
  if (altered.trackReverbs && Object.keys(altered.trackReverbs).length > 0) return true;
  if (altered.reverbParams && Object.keys(altered.reverbParams).length > 0) return true;
  if (altered.mutes && altered.mutes.some(Boolean)) return true;
  if (altered.solos && altered.solos.some(Boolean)) return true;
  if (altered.engines && Object.keys(altered.engines).length > 0) return true;
  if (altered.rerolls && altered.rerolls.some((r) => getRerollCount(r) > 0)) return true;
  return false;
}

/**
 * Whether the Librarian should flag a patch with the ALTERED CONTROLS icon.
 * Master volume is still saved, exported and shown blue, but on its own it does not flag the patch.
 */
export function shouldFlagAlteredControls(altered?: AlteredControls): boolean {
  if (!altered) return false;
  const { masterVolume: _masterVolume, ...rest } = altered;
  return hasAlteredControls(rest);
}

export function areAlteredControlsEqual(a?: AlteredControls, b?: AlteredControls): boolean {
  const aHas = hasAlteredControls(a);
  const bHas = hasAlteredControls(b);
  if (!aHas && !bHas) return true;
  if (!aHas || !bHas || !a || !b) return false;

  if (a.bpm !== b.bpm) return false;
  if (a.root !== b.root) return false;
  if (a.octave !== b.octave) return false;
  if (a.scale !== b.scale) return false;
  if (a.masterVolume !== b.masterVolume) return false;
  if (a.masterReverb !== b.masterReverb) return false;

  for (let i = 0; i < 4; i++) {
    if (a.trackVolumes?.[i] !== b.trackVolumes?.[i]) return false;
    if (a.trackReverbs?.[i] !== b.trackReverbs?.[i]) return false;
    if ((a.mutes?.[i] ?? false) !== (b.mutes?.[i] ?? false)) return false;
    if ((a.solos?.[i] ?? false) !== (b.solos?.[i] ?? false)) return false;
    const aEng = a.engines?.[i] !== undefined ? resolveEngineIndex(a.engines[i]) : -1;
    const bEng = b.engines?.[i] !== undefined ? resolveEngineIndex(b.engines[i]) : -1;
    if (aEng !== bEng) return false;
    if (getRerollCount(a.rerolls?.[i]) !== getRerollCount(b.rerolls?.[i])) return false;
    if (getRerollSeed(a.rerollSeeds?.[i]) !== getRerollSeed(b.rerollSeeds?.[i])) return false;
  }

  for (let cc = 85; cc <= 90; cc++) {
    if (a.reverbParams?.[cc] !== b.reverbParams?.[cc]) return false;
  }

  return true;
}

interface AlteredItem {
  category: string; // e.g. 'Global', 'Master', 'CH 1', 'Reverb'
  name: string;     // e.g. 'Tempo BPM', 'Volume', 'Pre-Delay'
  value: string;    // e.g. '130 BPM', '105', 'Muted'
}

export const CSV_COLUMNS = [
  'SYSEX',
  'PATCH NAME',
  'CH 1 VOLUME',
  'CH 1 REVERB',
  'CH 1 MUTE',
  'CH 1 SOLO',
  'CH 1 ENGINE',
  'CH 1 REROLL',
  'CH 2 VOLUME',
  'CH 2 REVERB',
  'CH 2 MUTE',
  'CH 2 SOLO',
  'CH 2 ENGINE',
  'CH 2 REROLL',
  'CH 3 VOLUME',
  'CH 3 REVERB',
  'CH 3 MUTE',
  'CH 3 SOLO',
  'CH 3 ENGINE',
  'CH 3 REROLL',
  'CH 4 VOLUME',
  'CH 4 REVERB',
  'CH 4 MUTE',
  'CH 4 SOLO',
  'CH 4 ENGINE',
  'CH 4 REROLL',
  'MASTER REVERB MULTIPLIER',
  'MASTER VOLUME',
  'REVERB PRE-DELAY',
  'REVERB TONE',
  'REVERB DIFFUSION 1',
  'REVERB DIFFUSION 2',
  'REVERB ROOM SIZE',
  'REVERB DECAY',
  'TEMPO BPM',
  'KEY ROOT NOTE',
  'KEY ROOT OCTAVE',
  'MUSICAL SCALE',
] as const;

export interface PatchRecord {
  id: string;
  name: string;
  sysexHex: string; // Primary 0x10 SysEx hex string (no spaces, e.g. F06F62781043010F3903F7)
  seed: number;     // 32-bit unsigned integer
  createdAt: number;
  sortOrder?: number; // Librarian display position (ascending; set by drag & drop, new patches go on top)
  isSaved: boolean;  // True if persisted in IndexedDB
  globalSettings?: GlobalSettings;
  tracks?: TrackConfig[];
  originalGlobalSettings?: GlobalSettings;
  originalTracks?: TrackConfig[];
  proceduralLevels?: import('./midi/procedural').ProceduralPatchLevels;
  altered?: AlteredControls; // Saved blue/modified controls

  // Dedicated Database & CSV export properties:
  ch1Volume?: number;
  ch1Reverb?: number;
  ch1Mute?: boolean;
  ch1Solo?: boolean;
  ch1Engine?: number | string;
  ch1Reroll?: number;
  ch1RerollSeed?: number;

  ch2Volume?: number;
  ch2Reverb?: number;
  ch2Mute?: boolean;
  ch2Solo?: boolean;
  ch2Engine?: number | string;
  ch2Reroll?: number;
  ch2RerollSeed?: number;

  ch3Volume?: number;
  ch3Reverb?: number;
  ch3Mute?: boolean;
  ch3Solo?: boolean;
  ch3Engine?: number | string;
  ch3Reroll?: number;
  ch3RerollSeed?: number;

  ch4Volume?: number;
  ch4Reverb?: number;
  ch4Mute?: boolean;
  ch4Solo?: boolean;
  ch4Engine?: number | string;
  ch4Reroll?: number;
  ch4RerollSeed?: number;

  masterReverbMultiplier?: number;
  masterVolume?: number;

  reverbPredelay?: number;
  reverbTone?: number;
  reverbDiffusion1?: number;
  reverbDiffusion2?: number;
  reverbRoomSize?: number;
  reverbDecay?: number;

  tempoBpm?: number;
  keyRootNote?: string;
  keyRootOctave?: number;
  musicalScale?: string;
}

/** sortOrder values that place `count` new patches above every patch in `list`, in order. */
export function topSortOrders(list: PatchRecord[], count = 1): number[] {
  const min = list.reduce((m, p) => Math.min(m, p.sortOrder ?? 0), 0);
  return Array.from({ length: count }, (_, i) => min - count + i);
}

export function syncFlatFieldsFromAltered(patch: PatchRecord): PatchRecord {
  const alt = patch.altered;
  const p = { ...patch };

  p.ch1Volume = alt?.trackVolumes?.[0];
  p.ch1Reverb = alt?.trackReverbs?.[0];
  p.ch1Mute = alt?.mutes?.[0];
  p.ch1Solo = alt?.solos?.[0];
  const eng0 = alt?.engines?.[0] !== undefined ? resolveEngineIndex(alt.engines[0]) : -1;
  p.ch1Engine = eng0 >= 0 ? eng0 : undefined;
  const r0 = getRerollCount(alt?.rerolls?.[0]);
  p.ch1Reroll = r0 > 0 ? r0 : undefined;
  p.ch1RerollSeed = r0 > 0 ? getRerollSeed(alt?.rerollSeeds?.[0]) : undefined;

  p.ch2Volume = alt?.trackVolumes?.[1];
  p.ch2Reverb = alt?.trackReverbs?.[1];
  p.ch2Mute = alt?.mutes?.[1];
  p.ch2Solo = alt?.solos?.[1];
  const eng1 = alt?.engines?.[1] !== undefined ? resolveEngineIndex(alt.engines[1]) : -1;
  p.ch2Engine = eng1 >= 0 ? eng1 : undefined;
  const r1 = getRerollCount(alt?.rerolls?.[1]);
  p.ch2Reroll = r1 > 0 ? r1 : undefined;
  p.ch2RerollSeed = r1 > 0 ? getRerollSeed(alt?.rerollSeeds?.[1]) : undefined;

  p.ch3Volume = alt?.trackVolumes?.[2];
  p.ch3Reverb = alt?.trackReverbs?.[2];
  p.ch3Mute = alt?.mutes?.[2];
  p.ch3Solo = alt?.solos?.[2];
  const eng2 = alt?.engines?.[2] !== undefined ? resolveEngineIndex(alt.engines[2]) : -1;
  p.ch3Engine = eng2 >= 0 ? eng2 : undefined;
  const r2 = getRerollCount(alt?.rerolls?.[2]);
  p.ch3Reroll = r2 > 0 ? r2 : undefined;
  p.ch3RerollSeed = r2 > 0 ? getRerollSeed(alt?.rerollSeeds?.[2]) : undefined;

  p.ch4Volume = alt?.trackVolumes?.[3];
  p.ch4Reverb = alt?.trackReverbs?.[3];
  p.ch4Mute = alt?.mutes?.[3];
  p.ch4Solo = alt?.solos?.[3];
  const eng3 = alt?.engines?.[3] !== undefined ? resolveEngineIndex(alt.engines[3]) : -1;
  p.ch4Engine = eng3 >= 0 ? eng3 : undefined;
  const r3 = getRerollCount(alt?.rerolls?.[3]);
  p.ch4Reroll = r3 > 0 ? r3 : undefined;
  p.ch4RerollSeed = r3 > 0 ? getRerollSeed(alt?.rerollSeeds?.[3]) : undefined;

  p.masterReverbMultiplier = alt?.masterReverb;
  p.masterVolume = alt?.masterVolume;

  p.reverbPredelay = alt?.reverbParams?.[85];
  p.reverbTone = alt?.reverbParams?.[86];
  p.reverbDiffusion1 = alt?.reverbParams?.[87];
  p.reverbDiffusion2 = alt?.reverbParams?.[88];
  p.reverbRoomSize = alt?.reverbParams?.[89];
  p.reverbDecay = alt?.reverbParams?.[90];

  p.tempoBpm = alt?.bpm;
  p.keyRootNote = alt?.root !== undefined ? (ROOT_NOTES[alt.root] ?? String(alt.root)) : undefined;
  p.keyRootOctave = alt?.octave;
  p.musicalScale = alt?.scale !== undefined ? (SCALES[alt.scale] ?? String(alt.scale)) : undefined;

  return p;
}

export function buildAlteredFromFlatFields(p: Partial<PatchRecord>): AlteredControls | undefined {
  const altered: AlteredControls = {};
  let hasAny = false;

  if (p.ch1Volume !== undefined || p.ch2Volume !== undefined || p.ch3Volume !== undefined || p.ch4Volume !== undefined) {
    altered.trackVolumes = {};
    if (p.ch1Volume !== undefined) { altered.trackVolumes[0] = p.ch1Volume; hasAny = true; }
    if (p.ch2Volume !== undefined) { altered.trackVolumes[1] = p.ch2Volume; hasAny = true; }
    if (p.ch3Volume !== undefined) { altered.trackVolumes[2] = p.ch3Volume; hasAny = true; }
    if (p.ch4Volume !== undefined) { altered.trackVolumes[3] = p.ch4Volume; hasAny = true; }
  }

  if (p.ch1Reverb !== undefined || p.ch2Reverb !== undefined || p.ch3Reverb !== undefined || p.ch4Reverb !== undefined) {
    altered.trackReverbs = {};
    if (p.ch1Reverb !== undefined) { altered.trackReverbs[0] = p.ch1Reverb; hasAny = true; }
    if (p.ch2Reverb !== undefined) { altered.trackReverbs[1] = p.ch2Reverb; hasAny = true; }
    if (p.ch3Reverb !== undefined) { altered.trackReverbs[2] = p.ch3Reverb; hasAny = true; }
    if (p.ch4Reverb !== undefined) { altered.trackReverbs[3] = p.ch4Reverb; hasAny = true; }
  }

  if (p.ch1Mute !== undefined || p.ch2Mute !== undefined || p.ch3Mute !== undefined || p.ch4Mute !== undefined) {
    altered.mutes = [p.ch1Mute ?? false, p.ch2Mute ?? false, p.ch3Mute ?? false, p.ch4Mute ?? false];
    if (altered.mutes.some(Boolean)) hasAny = true;
  }

  if (p.ch1Solo !== undefined || p.ch2Solo !== undefined || p.ch3Solo !== undefined || p.ch4Solo !== undefined) {
    altered.solos = [p.ch1Solo ?? false, p.ch2Solo ?? false, p.ch3Solo ?? false, p.ch4Solo ?? false];
    if (altered.solos.some(Boolean)) hasAny = true;
  }

  if (p.ch1Engine !== undefined || p.ch2Engine !== undefined || p.ch3Engine !== undefined || p.ch4Engine !== undefined) {
    altered.engines = {};
    if (p.ch1Engine !== undefined) {
      const idx = resolveEngineIndex(p.ch1Engine);
      if (idx >= 0) { altered.engines[0] = idx; hasAny = true; }
    }
    if (p.ch2Engine !== undefined) {
      const idx = resolveEngineIndex(p.ch2Engine);
      if (idx >= 0) { altered.engines[1] = idx; hasAny = true; }
    }
    if (p.ch3Engine !== undefined) {
      const idx = resolveEngineIndex(p.ch3Engine);
      if (idx >= 0) { altered.engines[2] = idx; hasAny = true; }
    }
    if (p.ch4Engine !== undefined) {
      const idx = resolveEngineIndex(p.ch4Engine);
      if (idx >= 0) { altered.engines[3] = idx; hasAny = true; }
    }
  }

  if (p.ch1Reroll !== undefined || p.ch2Reroll !== undefined || p.ch3Reroll !== undefined || p.ch4Reroll !== undefined) {
    const r0 = p.ch1Reroll ? Math.max(0, p.ch1Reroll) : 0;
    const r1 = p.ch2Reroll ? Math.max(0, p.ch2Reroll) : 0;
    const r2 = p.ch3Reroll ? Math.max(0, p.ch3Reroll) : 0;
    const r3 = p.ch4Reroll ? Math.max(0, p.ch4Reroll) : 0;
    if (r0 > 0 || r1 > 0 || r2 > 0 || r3 > 0) {
      altered.rerolls = [r0, r1, r2, r3];
      hasAny = true;
      const seeds = [p.ch1RerollSeed, p.ch2RerollSeed, p.ch3RerollSeed, p.ch4RerollSeed].map((sd, i) =>
        [r0, r1, r2, r3][i] > 0 ? (getRerollSeed(sd) ?? null) : null
      );
      if (seeds.some((sd) => sd !== null)) altered.rerollSeeds = seeds;
    }
  }

  if (p.masterReverbMultiplier !== undefined) {
    altered.masterReverb = p.masterReverbMultiplier;
    hasAny = true;
  }

  if (p.masterVolume !== undefined) {
    altered.masterVolume = p.masterVolume;
    hasAny = true;
  }

  if (
    p.reverbPredelay !== undefined ||
    p.reverbTone !== undefined ||
    p.reverbDiffusion1 !== undefined ||
    p.reverbDiffusion2 !== undefined ||
    p.reverbRoomSize !== undefined ||
    p.reverbDecay !== undefined
  ) {
    altered.reverbParams = {};
    if (p.reverbPredelay !== undefined) { altered.reverbParams[85] = p.reverbPredelay; hasAny = true; }
    if (p.reverbTone !== undefined) { altered.reverbParams[86] = p.reverbTone; hasAny = true; }
    if (p.reverbDiffusion1 !== undefined) { altered.reverbParams[87] = p.reverbDiffusion1; hasAny = true; }
    if (p.reverbDiffusion2 !== undefined) { altered.reverbParams[88] = p.reverbDiffusion2; hasAny = true; }
    if (p.reverbRoomSize !== undefined) { altered.reverbParams[89] = p.reverbRoomSize; hasAny = true; }
    if (p.reverbDecay !== undefined) { altered.reverbParams[90] = p.reverbDecay; hasAny = true; }
  }

  if (p.tempoBpm !== undefined) {
    altered.bpm = p.tempoBpm;
    hasAny = true;
  }

  if (p.keyRootNote !== undefined && p.keyRootNote !== '') {
    const idx = ROOT_NOTES.findIndex((n) => n.toLowerCase() === String(p.keyRootNote).toLowerCase());
    if (idx >= 0) {
      altered.root = idx;
      hasAny = true;
    } else if (!isNaN(Number(p.keyRootNote))) {
      altered.root = Number(p.keyRootNote);
      hasAny = true;
    }
  }

  if (p.keyRootOctave !== undefined) {
    altered.octave = p.keyRootOctave;
    hasAny = true;
  }

  if (p.musicalScale !== undefined && p.musicalScale !== '') {
    const idx = SCALES.findIndex((s) => s.toLowerCase() === String(p.musicalScale).toLowerCase());
    if (idx >= 0) {
      altered.scale = idx;
      hasAny = true;
    } else if (!isNaN(Number(p.musicalScale))) {
      altered.scale = Number(p.musicalScale);
      hasAny = true;
    }
  }

  return hasAny ? altered : undefined;
}

export function getDetailedAlteredList(altered?: AlteredControls): AlteredItem[] {
  if (!altered) return [];
  const list: AlteredItem[] = [];

  // Channels 1-4
  for (let ch = 0; ch < 4; ch++) {
    const chName = `CH ${ch + 1}`;
    if (altered.trackVolumes && altered.trackVolumes[ch] !== undefined) {
      list.push({ category: chName, name: 'Volume', value: String(altered.trackVolumes[ch]) });
    }
    if (altered.trackReverbs && altered.trackReverbs[ch] !== undefined) {
      list.push({ category: chName, name: 'Reverb', value: String(altered.trackReverbs[ch]) });
    }
    if (altered.mutes && altered.mutes[ch]) {
      list.push({ category: chName, name: 'Mute', value: 'Muted' });
    }
    if (altered.solos && altered.solos[ch]) {
      list.push({ category: chName, name: 'Solo', value: 'Soloed' });
    }
    if (altered.engines && altered.engines[ch] !== undefined) {
      const engIdx = resolveEngineIndex(altered.engines[ch]);
      const engVal = engIdx >= 0 ? `${SYNTH_ENGINES[engIdx]} (${engIdx})` : String(altered.engines[ch]);
      list.push({ category: chName, name: 'Engine', value: engVal });
    }
    const rCount = getRerollCount(altered.rerolls?.[ch]);
    if (rCount > 0) {
      const seed = getRerollSeed(altered.rerollSeeds?.[ch]);
      const seedTxt = seed !== undefined ? ` · seed ${seed.toString(16).toUpperCase().padStart(8, '0')}` : '';
      list.push({ category: chName, name: 'Timbre / Reroll', value: (rCount > 1 ? `Rerolled (${rCount}x)` : 'Rerolled') + seedTxt });
    }
  }

  // Master
  if (altered.masterReverb !== undefined) {
    const mult = altered.masterReverb <= 64 ? (altered.masterReverb / 64).toFixed(2) : (1 + (altered.masterReverb - 64) / 63).toFixed(2);
    list.push({ category: 'Master', name: 'Master Reverb Multiplier', value: `${mult}x (${altered.masterReverb})` });
  }
  if (altered.masterVolume !== undefined) {
    list.push({ category: 'Master', name: 'Master Volume', value: String(altered.masterVolume) });
  }

  // Reverb Controls
  if (altered.reverbParams) {
    const ccNames: { [cc: number]: string } = {
      85: 'Pre-Delay',
      86: 'Tone',
      87: 'Diffusion 1',
      88: 'Diffusion 2',
      89: 'Room Size',
      90: 'Decay',
    };
    for (const cc of [85, 86, 87, 88, 89, 90]) {
      if (altered.reverbParams[cc] !== undefined) {
        list.push({ category: 'Reverb', name: ccNames[cc], value: String(altered.reverbParams[cc]) });
      }
    }
  }

  // Global Settings
  if (altered.bpm !== undefined) {
    list.push({ category: 'Global', name: 'Tempo BPM', value: `${altered.bpm} BPM` });
  }
  if (altered.root !== undefined) {
    const rootName = ROOT_NOTES[altered.root] ?? `Note ${altered.root}`;
    list.push({ category: 'Global', name: 'Key Root Note', value: rootName });
  }
  if (altered.octave !== undefined) {
    list.push({ category: 'Global', name: 'Key Root Octave', value: String(altered.octave) });
  }
  if (altered.scale !== undefined) {
    const scaleName = SCALES[altered.scale] ?? `Scale ${altered.scale}`;
    list.push({ category: 'Global', name: 'Musical Scale', value: scaleName });
  }

  return list;
}

export interface ActivePatchBaseline {
  patchId: string | null;
  seed?: number;
  bpm: number;
  root: number;
  octave: number;
  scale: number;
  enginePerTrack: string[];
  /**
   * True when bpm/root/octave/scale were guessed from stored patch data (no trusted
   * originalGlobalSettings yet). A provisional baseline is replaced by the real
   * seed defaults when the 0x21 hardware dump arrives and is never persisted.
   */
  provisional?: boolean;
}

export interface MidiPortInfo {
  id: string;
  name: string;
  manufacturer?: string;
  state: string;
}

// 20 Scales from RND Synth manual
export const SCALES = [
  'Major',
  'Minor',
  'Harmonic Minor',
  'Blues',
  'Major Pentatonic',
  'Minor Pentatonic',
  'Dorian',
  'Phrygian',
  'Lydian',
  'Mixolydian',
  'Locrian',
  'Whole Tone',
  'Double Harmonic',
  'Hungarian Minor',
  'Phrygian Dominant',
  'Hirajoshi',
  'In Sen',
  'Prometheus',
  'Octatonic',
  'Persian',
] as const;

export const ROOT_NOTES = [
  'C',
  'C#',
  'D',
  'D# / Eb',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A# / Bb',
  'B',
] as const;

export const PATCH_TYPES = [
  'Looping Sequence',
  'Drone (Evolving)',
  'Jingle (Plays Once)',
] as const;

export const TRACK_ROLES = [
  'Lead / Melodic Sequence',
  'Bassline',
  'Arp / Chord / Harmony',
  'Percussion / Rhythm',
] as const;

export const VOICE_MODES = [
  'Monophonic',
  'Polyphonic (4-Voice)',
  'Sustained / Drone',
] as const;

export const SYNTH_ENGINES = [
  'Subtractive',    // 0: Track.engines[0]
  'FM',             // 1: Track.engines[1]
  'Acid (303)',     // 2: Track.engines[2]
  'Noise',          // 3: Track.engines[3]
  'Speech',         // 4: Track.engines[4]
  'Plucked String', // 5: Track.engines[5]
  'SuperSaw',       // 6: Track.engines[6]
  'Harmonic',       // 7: Track.engines[7]
] as const;

/**
 * Hardware synthesis engine compatibility per track role:
 * - Role 0 (Lead / Melodic Sequence): Subtractive, FM, Acid (303), Speech, Plucked String, SuperSaw (Harmonic excluded to prevent wrong-key drone)
 * - Role 1 (Bassline): Subtractive, FM, Acid (303), Plucked String
 * - Role 2 (Arp / Chord / Harmony): Subtractive, FM, Noise, Plucked String, SuperSaw, Harmonic (monophonic Acid and Speech excluded)
 * - Role 3 (Percussion / Rhythm): Subtractive, FM, Noise, Plucked String, Harmonic
 */
const ROLE_COMPATIBLE_ENGINES: Record<number, string[]> = {
  0: ['Subtractive', 'FM', 'Acid (303)', 'Speech', 'Plucked String', 'SuperSaw'],
  1: ['Subtractive', 'FM', 'Acid (303)', 'Plucked String'],
  2: ['Subtractive', 'FM', 'Noise', 'Plucked String', 'SuperSaw', 'Harmonic'],
  3: ['Subtractive', 'FM', 'Noise', 'Plucked String', 'Harmonic'],
};

/**
 * Voice mode compatibility:
 * - Mode 0 (Monophonic): Subtractive, FM, Acid (303), Noise, Speech, Plucked String, SuperSaw (Harmonic excluded to prevent wrong-key drone notes on lead/bass)
 * - Mode 1 (Polyphonic 4-Voice): Subtractive, FM, Plucked String, SuperSaw, Harmonic (excludes monophonic Acid & Speech, and Noise)
 * - Mode 2 (Sustained / Drone): Subtractive, FM, Noise, Plucked String, SuperSaw, Harmonic (excludes monophonic Acid & Speech)
 */
const MODE_COMPATIBLE_ENGINES: Record<number, string[]> = {
  0: ['Subtractive', 'FM', 'Acid (303)', 'Noise', 'Speech', 'Plucked String', 'SuperSaw'],
  1: ['Subtractive', 'FM', 'Plucked String', 'SuperSaw', 'Harmonic'],
  2: ['Subtractive', 'FM', 'Noise', 'Plucked String', 'SuperSaw', 'Harmonic'],
};

/**
 * Returns filtered list of engines compatible with a given track role and voice mode,
 * strictly maintaining hardware indexing order and preventing voice mode corruption.
 * If an authentic original engine from hardware PRNG generation is provided,
 * it is guaranteed to remain included in the returned list.
 */
export function getCompatibleEngines(role?: number, mode?: number, originalEngine?: string): string[] {
  const r = role !== undefined && role >= 0 && role <= 3 ? role : 0;
  const m = mode !== undefined && mode >= 0 && mode <= 2 ? mode : 0;

  const roleEngines = ROLE_COMPATIBLE_ENGINES[r] ?? [...SYNTH_ENGINES];
  const modeEngines = new Set(MODE_COMPATIBLE_ENGINES[m] ?? SYNTH_ENGINES);

  const filtered = roleEngines.filter((eng) => modeEngines.has(eng));
  const list = filtered.length > 0 ? [...filtered] : [...roleEngines];

  if (
    originalEngine &&
    originalEngine !== '—' &&
    originalEngine !== '' &&
    !list.includes(originalEngine) &&
    resolveEngineIndex(originalEngine) >= 0
  ) {
    list.push(originalEngine);
    list.sort((a, b) => resolveEngineIndex(a) - resolveEngineIndex(b));
  }

  return list;
}

/** First real engine name among the candidates (skips the '—' / '' placeholders). */
export function pickOriginalEngine(...candidates: (string | undefined)[]): string | undefined {
  return candidates.find((e) => !!e && e !== '—');
}

/**
 * Engines offered for a track (SYNTH ENGINE dropdown and ◀ ENGINE / ENGINE ▶): the role- and
 * mode-compatible engines plus the track's original and current engines, in hardware engine order.
 */
export function getSelectableEngines(role: number, mode: number, originalEngine?: string, currentEngine?: string): string[] {
  const list = getCompatibleEngines(role, mode, originalEngine);
  if (currentEngine && currentEngine !== '—' && !list.includes(currentEngine) && resolveEngineIndex(currentEngine) >= 0) {
    list.push(currentEngine);
    list.sort((a, b) => resolveEngineIndex(a) - resolveEngineIndex(b));
  }
  return list;
}


export const SYSEX_HEADER = [0xf0, 0x6f, 0x62, 0x78]; // F0 6F 62 78
export const SYSEX_TERMINATOR = 0xf7;

// MIDI CC 9 range midpoints for scale selection (Firmware 1.3 chart)
const SCALE_CC_MIDPOINTS: number[] = [
  3,   // 0: Major (0–6)
  9,   // 1: Minor (7–12)
  16,  // 2: Harmonic Minor (13–19)
  22,  // 3: Blues (20–25)
  28,  // 4: Major Pentatonic (26–31)
  35,  // 5: Minor Pentatonic (32–38)
  41,  // 6: Dorian (39–44)
  48,  // 7: Phrygian (45–51)
  54,  // 8: Lydian (52–57)
  60,  // 9: Mixolydian (58–63)
  67,  // 10: Locrian (64–70)
  73,  // 11: Whole Tone (71–76)
  80,  // 12: Double Harmonic (77–83)
  86,  // 13: Hungarian Minor (84–89)
  92,  // 14: Phrygian Dominant (90–95)
  99,  // 15: Hirajoshi (96–102)
  105, // 16: In Sen (103–108)
  112, // 17: Prometheus (109–115)
  118, // 18: Octatonic (116–121)
  124, // 19: Persian (122–127)
];

/**
 * Maps scale index (0..19) to the mid-range value of MIDI CC 9.
 */
export function scaleIndexToCC9(scaleIndex: number): number {
  const safeIdx = Math.max(0, Math.min(19, scaleIndex));
  return SCALE_CC_MIDPOINTS[safeIdx];
}

/**
 * Maps incoming MIDI CC 9 value (0..127) back to the corresponding scale index (0..19).
 */
export function cc9ToScaleIndex(ccVal: number): number {
  if (ccVal <= 6) return 0;
  if (ccVal <= 12) return 1;
  if (ccVal <= 19) return 2;
  if (ccVal <= 25) return 3;
  if (ccVal <= 31) return 4;
  if (ccVal <= 38) return 5;
  if (ccVal <= 44) return 6;
  if (ccVal <= 51) return 7;
  if (ccVal <= 57) return 8;
  if (ccVal <= 63) return 9;
  if (ccVal <= 70) return 10;
  if (ccVal <= 76) return 11;
  if (ccVal <= 83) return 12;
  if (ccVal <= 89) return 13;
  if (ccVal <= 95) return 14;
  if (ccVal <= 102) return 15;
  if (ccVal <= 108) return 16;
  if (ccVal <= 115) return 17;
  if (ccVal <= 121) return 18;
  return 19;
}

/**
 * RND STORAGE CHECK readout (JGpatch-019, SysEx 0x1C -> 0x24) for TYPES TO GENERATE.
 * Mask values are the CC 14 bits (1 = Looping, 2 = Drone, 4 = Jingle); null = unknown / not set.
 */
export interface StorageCheck {
  ramMask: number;
  savedMask: number;
  recordCount: number;
  validRecordLoaded: boolean;
  flashError: boolean;
  latestRecordMask: number | null;
  latestRecordValid: boolean;
  saveRequested: boolean;
  cc14SaveRequests: number | null;
  recordWrites: number | null;
  bootRestoredMask: number | null;
  lastGenerationMask: number | null;
  receivedAt: number;
}

/** TYPES TO GENERATE mask as text, using the same type names as the type badge. */
export function describeTypeMask(mask: number | null): string {
  if (mask === null) return 'not set';
  const m = mask & 7;
  if (m === 0) return 'all types (0)';
  const names = [m & 1 ? 'Looping' : '', m & 2 ? 'Drone' : '', m & 4 ? 'Jingle' : ''].filter(Boolean);
  return `${names.join(' + ')} (${m})`;
}

export interface ConnectedFirmwareInfo {
  detected: boolean;
  major: number;
  minor: number;
  patch: number;
  versionString: string;
  isUpToDate: boolean;
  needsUpdate: boolean;
}

// Bundled firmware (public/firmware). Bump the first two together when shipping a new JGpatch build;
// the file names follow from them.
export const LATEST_FIRMWARE_PATCH = 22;
export const LATEST_FIRMWARE_STRING = 'v1.3-JGpatch-022';
export const LATEST_FIRMWARE_FILE = `RNDsynth-${LATEST_FIRMWARE_STRING}.bin`;
export const LATEST_FIRMWARE_PATCH_FILE = `jgpatch-${String(LATEST_FIRMWARE_PATCH).padStart(3, '0')}.json`;

// Firmware Permission Switch
// true  = host the full patched .bin (simple one-click mode; needs Cyma Forma's permission).
//         Also copy LATEST_FIRMWARE_FILE into public/firmware/ and remove its line from .gitignore.
// false = host only LATEST_FIRMWARE_PATCH_FILE; the user supplies the official stock
//         RNDsynth-v1.3.bin and it is patched in the browser.
export const FIRMWARE_PERMISSION_SWITCH = false;
export const STOCK_FIRMWARE_FILE = 'RNDsynth-v1.3.bin';
// Direct file from Cyma Forma's updater (listed in updater.cymaforma.com/data/rnd-synth/sources.json)
export const STOCK_FIRMWARE_URL = 'https://updater.cymaforma.com/data/rnd-synth/RNDsynth-v1.3.bin';
