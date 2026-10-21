import { writable, derived, get } from 'svelte/store';
import type { PatchRecord, GlobalSettings, TrackConfig, MidiPortInfo, ActivePatchBaseline, AlteredControls, ConnectedFirmwareInfo, StorageCheck } from './types';
import { hasAlteredControls, areAlteredControlsEqual, getRerollCount, getRerollSeed, syncFlatFieldsFromAltered, resolveEngineIndex, resolveEngineName, SYNTH_ENGINES } from './types';

interface MidiState {
  isSupported: boolean;
  isSysexAllowed: boolean;
  inputPorts: MidiPortInfo[];
  outputPorts: MidiPortInfo[];
  selectedInputId: string;
  selectedOutputId: string;
  statusText: string;
}

export const midiStore = writable<MidiState>({
  isSupported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
  isSysexAllowed: false,
  inputPorts: [],
  outputPorts: [],
  selectedInputId: '',
  selectedOutputId: '',
  statusText: 'Disconnected',
});

// MIDI activity LEDs, kept separate from midiStore so per-message flashes don't re-render the port lists
export const midiActivityStore = writable<{ tx: boolean; rx: boolean }>({ tx: false, rx: false });

// Primary librarian patches list
export const patchesStore = writable<PatchRecord[]>([]);

// ID of the currently selected patch in the librarian
export const selectedPatchId = writable<string | null>(null);

// Currently armed / editing parameters for the right panel editor
export const activeGlobalSettings = writable<GlobalSettings>({
  type: 0,
  bpm: 120,
  root: 0,
  scale: 0,
});

export function normalizeTracks(tracks?: TrackConfig[]): TrackConfig[] {
  return [0, 1, 2, 3].map((idx) => {
    const existing = tracks?.find((t) => t.track === idx) ?? tracks?.[idx];
    if (existing) {
      return {
        ...existing,
        track: idx,
        active: existing.active !== undefined ? existing.active : false,
        originalEngine: existing.originalEngine || (existing.engine && existing.engine !== '—' ? existing.engine : undefined),
      };
    }
    return {
      track: idx,
      active: false,
      role: idx,
      mode: 0,
      engine: '—',
      muted: false,
      soloed: false,
    };
  });
}

export const activeTracks = writable<TrackConfig[]>([
  { track: 0, active: true, role: 0, mode: 0, engine: 'FM', muted: false, soloed: false },
  { track: 1, active: true, role: 1, mode: 0, engine: 'Acid (303)', muted: false, soloed: false },
  { track: 2, active: true, role: 2, mode: 1, engine: 'Harmonic', muted: false, soloed: false },
  { track: 3, active: true, role: 3, mode: 0, engine: 'Noise', muted: false, soloed: false },
]);

// Master MIDI CC controls (Channel 1)
export const masterVolumeStore = writable<number>(100);    // MASTER VOLUME: CC 7 (0-127)
export const masterReverbMultStore = writable<number>(64); // MASTER REV MULT: CC 91 (0-127, 64 = unity)

// Track / Channel MIDI CC controls (Channels 2-5 for CH 1-4)
export const trackVolumesStore = writable<number[]>([100, 100, 100, 100]); // CC 7 (0-127)
export const trackReverbsStore = writable<number[]>([64, 64, 64, 64]);      // CC 91 (0-127, nominal stock send = 64)

// REVERB CONTROLS: the 6 internal DSP reverb parameters (CC 85-90, Channel 1), defaults drawn from the seed
export const reverbPredelayStore = writable<number>(0);    // PRE-DELAY    CC 85
export const reverbToneStore = writable<number>(64);       // TONE         CC 86
export const reverbDiffusion1Store = writable<number>(64); // DIFFUSION 1  CC 87
export const reverbDiffusion2Store = writable<number>(64); // DIFFUSION 2  CC 88
export const reverbRoomSizeStore = writable<number>(64);   // ROOM SIZE    CC 89
export const reverbDecayStore = writable<number>(83);      // DECAY        CC 90 (value currently sent, incl. INF / LATCH)
export const reverbDecayKnobStore = writable<number>(83);  // DECAY knob position (unaffected by INF / LATCH)

// True while librarian is actively loading a patch (prevents accidental dirty marking)
export const isPatchLoadingStore = writable<boolean>(false);

// Procedural patch calculation store (calculated from active patch seed via MT19937)
export const activeProceduralLevels = writable<import('./midi/procedural').ProceduralPatchLevels | null>(null);

/**
 * Centrally updates all mixer, track send, and 6 DSP reverb stores from procedural patch calculation.
 */
export function applyProceduralPatchLevels(procedural: import('./midi/procedural').ProceduralPatchLevels) {
  activeProceduralLevels.set(procedural);
  // masterVolumeStore is intentionally preserved across patch changes to match persistent hardware master volume
  trackVolumesStore.set([...procedural.trackVolumesCC]);
  masterReverbMultStore.set(procedural.masterReverbCC);
  trackReverbsStore.set([...procedural.trackReverbsCC]);
  reverbPredelayStore.set(procedural.predelayCC);
  reverbToneStore.set(procedural.toneCC);
  reverbDiffusion1Store.set(procedural.diffusion1CC);
  reverbDiffusion2Store.set(procedural.diffusion2CC);
  reverbDecayStore.set(procedural.decayCC);
  reverbDecayKnobStore.set(procedural.decayCC);
  reverbRoomSizeStore.set(procedural.roomSizeCC);
}

// Active patch baseline for tracking default vs modified states
export const activePatchBaseline = writable<ActivePatchBaseline | null>(null);

// Rerolled state & count per track (CH 1-4, indices 0-3) for deterministic PRNG tracking & glowing blue reroll symbol
export const rerolledTracksStore = writable<number[]>([0, 0, 0, 0]);

export function markTrackRerolled(trackIndex: number) {
  rerolledTracksStore.update((arr) => {
    const next = [...arr];
    next[trackIndex] = (next[trackIndex] || 0) + 1;
    return next;
  });
}

// 32-bit TRNG seed of each track's most recent reroll, reported by the RND via SysEx 0x23 (JGpatch-014).
// Replaying it with SysEx 0x1A regenerates the exact same rerolled timbre, whatever engine it landed on.
export const rerollSeedsStore = writable<(number | null)[]>([null, null, null, null]);

export function setTrackRerollSeed(trackIndex: number, seed: number) {
  rerollSeedsStore.update((arr) => {
    const next = [...arr];
    next[trackIndex] = seed >>> 0;
    return next;
  });
}

export function clearRerolledTracks() {
  rerolledTracksStore.set([0, 0, 0, 0]);
  rerollSeedsStore.set([null, null, null, null]);
}

/**
 * Sets the active patch baseline figures (BPM, Root, Octave, Scale, Track Engines)
 * to allow highlighting modified controls in blue (#38bdf8).
 */
export function setPatchBaseline(patch: PatchRecord) {
  // A trusted baseline only exists once the hardware 0x21 dump (or a reset) has recorded it
  // in patch.originalGlobalSettings. Anything else is a provisional guess: it is used to
  // highlight altered controls immediately on load, but is NEVER written back to the patch,
  // and is replaced by the real seed defaults when the 0x21 dump arrives.
  let g = patch.originalGlobalSettings;
  const provisional = !g;
  if (!g) {
    if (patch.globalSettings) {
      g = { ...patch.globalSettings };
      // If patch has altered overrides, ensure baseline reflects unedited defaults
      // so altered controls highlight in blue immediately upon load
      if (patch.altered) {
        if (patch.altered.octave !== undefined && g.octave === patch.altered.octave) {
          g.octave = patch.altered.octave === 4 ? 3 : 4;
        }
        if (patch.altered.root !== undefined && g.root === patch.altered.root) {
          g.root = (patch.altered.root + 1) % 12;
        }
        if (patch.altered.scale !== undefined && g.scale === patch.altered.scale) {
          g.scale = (patch.altered.scale + 1) % 20;
        }
        if (patch.altered.bpm !== undefined && g.bpm === patch.altered.bpm) {
          g.bpm = patch.altered.bpm === 120 ? 110 : 120;
        }
      }
    } else {
      g = { bpm: 120, root: 0, octave: 4, scale: 0, type: 0 };
    }
  }

  // Baseline engines:
  // 1. If patch.originalTracks exists and has valid engine strings, use them.
  // 2. Otherwise, use patch.tracks, but for any track recorded in patch.altered.engines,
  //    derive a baseline distinct from the altered engine so the blue altered state is preserved.
  const baseEngines: string[] = ['', '', '', ''];
  const sourceTracks = patch.originalTracks && patch.originalTracks.length > 0 ? patch.originalTracks : patch.tracks;

  for (let ch = 0; ch < 4; ch++) {
    const origEngine =
      patch.originalTracks?.[ch]?.originalEngine ||
      patch.originalTracks?.[ch]?.engine ||
      sourceTracks?.[ch]?.originalEngine;
    if (origEngine && origEngine !== '—' && origEngine !== '') {
      baseEngines[ch] = resolveEngineName(origEngine);
    } else if (patch.altered?.engines?.[ch] !== undefined) {
      // Channel was altered! Baseline is distinct from altered engine
      const altIdx = resolveEngineIndex(patch.altered.engines[ch]);
      const trackIdx = sourceTracks?.[ch]?.engine ? resolveEngineIndex(sourceTracks[ch].engine) : -1;
      const defEngines = ['FM', 'Acid (303)', 'Harmonic', 'Noise'];
      if (trackIdx >= 0 && trackIdx !== altIdx) {
        baseEngines[ch] = SYNTH_ENGINES[trackIdx];
      } else {
        const fallback = defEngines[ch] ?? 'FM';
        baseEngines[ch] = resolveEngineIndex(fallback) !== altIdx ? fallback : (altIdx === 0 ? 'FM' : 'Subtractive');
      }
    } else if (sourceTracks?.[ch]?.engine && sourceTracks[ch].engine !== '—' && sourceTracks[ch].engine !== '') {
      // Channel was NOT altered: baseline matches the current track engine!
      baseEngines[ch] = resolveEngineName(sourceTracks[ch].engine);
    } else {
      // Procedural seed fallback: wait for authentic 0x22 hardware dump
      baseEngines[ch] = '';
    }
  }

  if (!patch.originalTracks && sourceTracks && sourceTracks.length > 0) {
    // Preserve each channel's real active flag - never force all four channels active.
    const normSource = normalizeTracks(sourceTracks);
    patch.originalTracks = baseEngines.map((eng, idx) => ({
      track: idx,
      active: normSource[idx].active,
      role: idx,
      mode: 0,
      engine: eng,
      originalEngine: eng,
    }));
  }

  activePatchBaseline.set({
    patchId: patch.id,
    seed: patch.seed,
    bpm: g.bpm,
    root: g.root,
    octave: g.octave ?? 4,
    scale: g.scale,
    enginePerTrack: baseEngines,
    provisional,
  });
}

/**
 * Collects any user-modified parameters that differ from the active baseline / procedural seed defaults.
 * EXCLUDES: INF HOLD, LATCH, and TYPES TO GENERATE checkboxes.
 */
export function collectCurrentAlteredControls(): AlteredControls {
  const altered: AlteredControls = {};
  const base = get(activePatchBaseline);
  const globals = get(activeGlobalSettings);
  const proc = get(activeProceduralLevels);
  const tracks = get(activeTracks);

  // Global Settings
  if (base?.bpm !== undefined && globals.bpm !== base.bpm) {
    altered.bpm = globals.bpm;
  }
  if (base?.root !== undefined && globals.root !== base.root) {
    altered.root = globals.root;
  }
  if (base?.octave !== undefined && (globals.octave ?? 4) !== base.octave) {
    altered.octave = globals.octave ?? 4;
  }
  if (base?.scale !== undefined && globals.scale !== base.scale) {
    altered.scale = globals.scale;
  }

  // Master Volume (CC 7 Ch 1) - default 100
  const mVol = get(masterVolumeStore);
  if (mVol !== 100) {
    altered.masterVolume = mVol;
  }

  // Master Reverb (CC 91 Ch 1) - default from procedural
  const mRev = get(masterReverbMultStore);
  const defMRev = proc?.masterReverbCC ?? 64;
  if (mRev !== defMRev) {
    altered.masterReverb = mRev;
  }

  // Tracks (CH 1 - CH 4, indices 0..3)
  const trackVols = get(trackVolumesStore);
  const trackRevs = get(trackReverbsStore);
  const rerollCounts = get(rerolledTracksStore);
  const rerollSeeds = get(rerollSeedsStore);
  for (let ch = 0; ch < 4; ch++) {
    // Volume
    const defVol = proc?.trackVolumesCC?.[ch] ?? 100;
    if (trackVols[ch] !== defVol) {
      if (!altered.trackVolumes) altered.trackVolumes = {};
      altered.trackVolumes[ch] = trackVols[ch];
    }
    // Reverb
    const defRev = proc?.trackReverbsCC?.[ch] ?? 64;
    if (trackRevs[ch] !== defRev) {
      if (!altered.trackReverbs) altered.trackReverbs = {};
      altered.trackReverbs[ch] = trackRevs[ch];
    }
    // Mute
    if (tracks[ch]?.muted) {
      if (!altered.mutes) altered.mutes = [false, false, false, false];
      altered.mutes[ch] = true;
    }
    // Solo
    if (tracks[ch]?.soloed) {
      if (!altered.solos) altered.solos = [false, false, false, false];
      altered.solos[ch] = true;
    }
    // Engine & Rerolls
    const curEngine = tracks[ch]?.engine;
    const baseEngine = base?.enginePerTrack?.[ch];
    const rCount = getRerollCount(rerollCounts[ch]);

    if (rCount > 0) {
      if (!altered.rerolls) altered.rerolls = [0, 0, 0, 0];
      altered.rerolls[ch] = rCount;
      const seed = getRerollSeed(rerollSeeds[ch]);
      if (seed !== undefined) {
        if (!altered.rerollSeeds) altered.rerollSeeds = [null, null, null, null];
        altered.rerollSeeds[ch] = seed;
      }
    }

    if (
      curEngine &&
      curEngine !== '—' &&
      curEngine !== ''
    ) {
      const curIdx = resolveEngineIndex(curEngine);
      const baseIdx = baseEngine && baseEngine !== '—' && baseEngine !== '' ? resolveEngineIndex(baseEngine) : -1;
      // Record engine ONLY if it actually differs from baseline (user changed it!):
      if (curIdx >= 0 && baseIdx >= 0 && curIdx !== baseIdx) {
        if (!altered.engines) altered.engines = {};
        altered.engines[ch] = curIdx;
      }
    }
  }

  // REVERB CONTROLS (CC 85-90). DECAY uses the knob position, so INF / LATCH never count as edits.
  const reverbControls: [number, number, number][] = [
    [85, get(reverbPredelayStore), proc?.predelayCC ?? 0],
    [86, get(reverbToneStore), proc?.toneCC ?? 64],
    [87, get(reverbDiffusion1Store), proc?.diffusion1CC ?? 64],
    [88, get(reverbDiffusion2Store), proc?.diffusion2CC ?? 64],
    [89, get(reverbRoomSizeStore), proc?.roomSizeCC ?? 64],
    [90, get(reverbDecayKnobStore), proc?.decayCC ?? 83],
  ];
  for (const [cc, value, def] of reverbControls) {
    if (value !== def) {
      if (!altered.reverbParams) altered.reverbParams = {};
      altered.reverbParams[cc] = value;
    }
  }

  return altered;
}

/**
 * Applies saved altered controls to the active stores when loading a patch.
 */
export function applyAlteredControls(altered?: AlteredControls): void {
  if (!altered) return;

  if (altered.bpm !== undefined || altered.root !== undefined || altered.octave !== undefined || altered.scale !== undefined) {
    activeGlobalSettings.update((s) => ({
      ...s,
      bpm: altered.bpm ?? s.bpm,
      root: altered.root ?? s.root,
      octave: altered.octave ?? s.octave,
      scale: altered.scale ?? s.scale,
    }));
  }

  if (altered.masterVolume !== undefined) {
    masterVolumeStore.set(altered.masterVolume);
  }
  if (altered.masterReverb !== undefined) {
    masterReverbMultStore.set(altered.masterReverb);
  }

  if (altered.trackVolumes) {
    trackVolumesStore.update((vols) => {
      const next = [...vols];
      for (const [k, v] of Object.entries(altered.trackVolumes!)) {
        const idx = Number(k);
        if (idx >= 0 && idx < 4) next[idx] = v;
      }
      return next;
    });
  }

  if (altered.trackReverbs) {
    trackReverbsStore.update((revs) => {
      const next = [...revs];
      for (const [k, v] of Object.entries(altered.trackReverbs!)) {
        const idx = Number(k);
        if (idx >= 0 && idx < 4) next[idx] = v;
      }
      return next;
    });
  }

  if (altered.reverbParams) {
    if (altered.reverbParams[85] !== undefined) reverbPredelayStore.set(altered.reverbParams[85]);
    if (altered.reverbParams[86] !== undefined) reverbToneStore.set(altered.reverbParams[86]);
    if (altered.reverbParams[87] !== undefined) reverbDiffusion1Store.set(altered.reverbParams[87]);
    if (altered.reverbParams[88] !== undefined) reverbDiffusion2Store.set(altered.reverbParams[88]);
    if (altered.reverbParams[89] !== undefined) reverbRoomSizeStore.set(altered.reverbParams[89]);
    if (altered.reverbParams[90] !== undefined) {
      reverbDecayStore.set(altered.reverbParams[90]);
      reverbDecayKnobStore.set(altered.reverbParams[90]);
    }
  }

  if (altered.rerolls) {
    rerolledTracksStore.set(altered.rerolls.map((r) => getRerollCount(r)));
    rerollSeedsStore.set([0, 1, 2, 3].map((i) => getRerollSeed(altered.rerollSeeds?.[i]) ?? null));
  } else {
    clearRerolledTracks();
  }

  if (altered.mutes || altered.solos || altered.engines) {
    activeTracks.update((trks) => {
      const next = normalizeTracks(trks);
      for (let i = 0; i < 4; i++) {
        if (altered.mutes && altered.mutes[i] !== undefined) {
          next[i].muted = altered.mutes[i];
        }
        if (altered.solos && altered.solos[i] !== undefined) {
          next[i].soloed = altered.solos[i];
        }
        if (altered.engines && altered.engines[i] !== undefined) {
          next[i].engine = resolveEngineName(altered.engines[i]);
        }
      }
      return next;
    });
  }

  const activeId = get(selectedPatchId);
  if (activeId) {
    patchesStore.update((list) =>
      list.map((p) => {
        if (p.id !== activeId) return p;
        const tracks = normalizeTracks(p.tracks);
        for (let i = 0; i < 4; i++) {
          if (altered.mutes && altered.mutes[i] !== undefined) {
            tracks[i].muted = altered.mutes[i];
          }
          if (altered.solos && altered.solos[i] !== undefined) {
            tracks[i].soloed = altered.solos[i];
          }
          if (altered.engines && altered.engines[i] !== undefined) {
            tracks[i].engine = resolveEngineName(altered.engines[i]);
          }
        }
        return {
          ...p,
          tracks,
          altered: hasAlteredControls(altered) ? altered : undefined,
        };
      })
    );
  }
}

/**
 * Checks if any controls differ from baseline and marks the active patch unsaved/dirty,
 * causing the librarian save button to enter the red flashing state.
 */
export function markActivePatchDirty(): void {
  if (get(isPatchLoadingStore)) return;

  const activeId = get(selectedPatchId);
  if (!activeId) return;

  const currentPatches = get(patchesStore);
  const patch = currentPatches.find((p) => p.id === activeId);
  if (!patch) return;

  const altered = collectCurrentAlteredControls();
  const isAltered = hasAlteredControls(altered);

  // If the patch was previously marked saved, verify if active altered controls match saved patch.altered.
  // If they match what was saved, the patch is NOT dirty and remains saved!
  let isSaved = patch.isSaved;
  if (isSaved) {
    const matchesSaved = areAlteredControlsEqual(altered, patch.altered);
    if (!matchesSaved) {
      isSaved = false;
    }
  }

  const globalSettings = { ...get(activeGlobalSettings) };
  const tracks = get(activeTracks).map((t) => ({ ...t }));
  patchesStore.update((list) =>
    list.map((p) =>
      p.id !== activeId
        ? p
        : syncFlatFieldsFromAltered({ ...p, isSaved, altered: isAltered ? altered : undefined, globalSettings, tracks })
    )
  );
}

// Browser storage can be unavailable or throw on access (blocked site data, private modes)
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Persistence is a convenience only
  }
}

// TYPES TO GENERATE (CC 14 mask: bit 0 = Looping, bit 1 = Drone, bit 2 = Jingle)
const TYPES_TO_GENERATE_KEY = 'rnd_type_filter';

function createTypesToGenerateStore() {
  let initial: [boolean, boolean, boolean] = [true, true, true];
  try {
    const parsed = JSON.parse(readStorage(TYPES_TO_GENERATE_KEY) ?? 'null');
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.some(Boolean)) {
      initial = parsed as [boolean, boolean, boolean];
    }
  } catch {
    // Ignore a malformed stored value
  }

  const { subscribe, set, update } = writable<[boolean, boolean, boolean]>(initial);

  return {
    subscribe,
    set: (val: [boolean, boolean, boolean]) => {
      let next = val;
      if (!next[0] && !next[1] && !next[2]) {
        next = [true, true, true];
      }
      writeStorage(TYPES_TO_GENERATE_KEY, JSON.stringify(next));
      set(next);
    },
    update: (fn: (val: [boolean, boolean, boolean]) => [boolean, boolean, boolean]) => {
      update((current) => {
        let next = fn(current);
        if (!next[0] && !next[1] && !next[2]) {
          next = [true, true, true];
        }
        writeStorage(TYPES_TO_GENERATE_KEY, JSON.stringify(next));
        return next;
      });
    },
    toggle: (idx: number) => {
      update((current) => {
        let next = [...current] as [boolean, boolean, boolean];
        next[idx] = !next[idx];
        // If the user unticks the only ticked box, instead of leaving them all unticked, automatically tick them all
        if (!next[0] && !next[1] && !next[2]) {
          next = [true, true, true];
        }
        writeStorage(TYPES_TO_GENERATE_KEY, JSON.stringify(next));
        return next;
      });
    },
  };
}

export const typesToGenerateStore = createTypesToGenerateStore();

// TYPES TO GENERATE as the 3-bit CC 14 mask (1 to 7)
export const typesToGenerateMask = derived(typesToGenerateStore, ($filter) => {
  let mask = 0;
  if ($filter[0]) mask |= 1;
  if ($filter[1]) mask |= 2;
  if ($filter[2]) mask |= 4;
  return mask === 0 ? 7 : mask; // fallback to all enabled if all unchecked
});

// Derived store to find the selected patch object
export const selectedPatch = derived(
  [patchesStore, selectedPatchId],
  ([$patches, $selectedPatchId]) => {
    if (!$selectedPatchId) return null;
    return $patches.find((p) => p.id === $selectedPatchId) ?? null;
  }
);

// Flash the TX / RX activity LEDs (subscribers are only notified when a LED actually changes state)
let txTimer: number | null = null;
export function flashTxLed() {
  if (!get(midiActivityStore).tx) midiActivityStore.update((s) => ({ ...s, tx: true }));
  if (txTimer) clearTimeout(txTimer);
  txTimer = window.setTimeout(() => midiActivityStore.update((s) => ({ ...s, tx: false })), 120);
}

let rxTimer: number | null = null;
export function flashRxLed() {
  if (!get(midiActivityStore).rx) midiActivityStore.update((s) => ({ ...s, rx: true }));
  if (rxTimer) clearTimeout(rxTimer);
  rxTimer = window.setTimeout(() => midiActivityStore.update((s) => ({ ...s, rx: false })), 120);
}

// JG-RND Patcher (firmware dialog) visibility
export const isFirmwareModalOpen = writable<boolean>(false);

// Connected Synthesizer Detected Firmware Version
export const connectedFirmware = writable<ConnectedFirmwareInfo | null>(null);

// Last RND STORAGE CHECK readout (JGpatch-019 SysEx 0x24)
export const storageCheckStore = writable<StorageCheck | null>(null);
