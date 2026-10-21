import type { PatchRecord, GlobalSettings } from '../types';
import {
  CSV_COLUMNS,
  ROOT_NOTES,
  SCALES,
  syncFlatFieldsFromAltered,
  buildAlteredFromFlatFields,
  resolveEngineIndex,
  resolveEngineName,
  getRerollCount,
  formatRerollCell,
  topSortOrders,
  parseTags,
} from '../types';
import { hexToBytes, parseSysExMessage } from '../midi/sysex';
import { calculateProceduralLevels } from '../midi/procedural';
import { saveMultiplePatchesToDb, replaceAllPatchesInDb } from './database';
import {
  patchesStore,
  selectedPatchId,
  activeGlobalSettings,
  activeTracks,
  normalizeTracks,
  setPatchBaseline,
  applyProceduralPatchLevels,
  applyAlteredControls,
} from '../stores';
import { get } from 'svelte/store';

/**
 * Escapes a string for CSV formatting.
 */
function escapeCsvField(val: string): string {
  const escaped = val.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Exports an array of PatchRecords to a downloadable CSV file.
 * Row 1 contains column headings.
 * Unaltered controls have empty/blank values ("").
 */
export function exportPatchesToCsv(patches: PatchRecord[]): void {
  const lines: string[] = [CSV_COLUMNS.join(',')];

  for (const patch of patches) {
    const cleanHex = patch.sysexHex.replace(/[\s,]/g, '').toUpperCase();
    const quotedName = escapeCsvField(patch.name || 'Untitled Patch');
    const alt = patch.altered;

    const row: string[] = [
      cleanHex,
      quotedName,
      // CH 1
      alt?.trackVolumes?.[0] !== undefined ? String(alt.trackVolumes[0]) : '',
      alt?.trackReverbs?.[0] !== undefined ? String(alt.trackReverbs[0]) : '',
      alt?.mutes?.[0] ? 'Muted' : '',
      alt?.solos?.[0] ? 'Soloed' : '',
      alt?.engines?.[0] !== undefined ? String(resolveEngineIndex(alt.engines[0])) : '',
      formatRerollCell(getRerollCount(alt?.rerolls?.[0] ?? patch.ch1Reroll), alt?.rerollSeeds?.[0] ?? patch.ch1RerollSeed),

      // CH 2
      alt?.trackVolumes?.[1] !== undefined ? String(alt.trackVolumes[1]) : '',
      alt?.trackReverbs?.[1] !== undefined ? String(alt.trackReverbs[1]) : '',
      alt?.mutes?.[1] ? 'Muted' : '',
      alt?.solos?.[1] ? 'Soloed' : '',
      alt?.engines?.[1] !== undefined ? String(resolveEngineIndex(alt.engines[1])) : '',
      formatRerollCell(getRerollCount(alt?.rerolls?.[1] ?? patch.ch2Reroll), alt?.rerollSeeds?.[1] ?? patch.ch2RerollSeed),

      // CH 3
      alt?.trackVolumes?.[2] !== undefined ? String(alt.trackVolumes[2]) : '',
      alt?.trackReverbs?.[2] !== undefined ? String(alt.trackReverbs[2]) : '',
      alt?.mutes?.[2] ? 'Muted' : '',
      alt?.solos?.[2] ? 'Soloed' : '',
      alt?.engines?.[2] !== undefined ? String(resolveEngineIndex(alt.engines[2])) : '',
      formatRerollCell(getRerollCount(alt?.rerolls?.[2] ?? patch.ch3Reroll), alt?.rerollSeeds?.[2] ?? patch.ch3RerollSeed),

      // CH 4
      alt?.trackVolumes?.[3] !== undefined ? String(alt.trackVolumes[3]) : '',
      alt?.trackReverbs?.[3] !== undefined ? String(alt.trackReverbs[3]) : '',
      alt?.mutes?.[3] ? 'Muted' : '',
      alt?.solos?.[3] ? 'Soloed' : '',
      alt?.engines?.[3] !== undefined ? String(resolveEngineIndex(alt.engines[3])) : '',
      formatRerollCell(getRerollCount(alt?.rerolls?.[3] ?? patch.ch4Reroll), alt?.rerollSeeds?.[3] ?? patch.ch4RerollSeed),

      // Master Reverb Multiplier & Master Volume
      alt?.masterReverb !== undefined ? String(alt.masterReverb) : '',
      alt?.masterVolume !== undefined ? String(alt.masterVolume) : '',

      // 6 DSP Reverb controls
      alt?.reverbParams?.[85] !== undefined ? String(alt.reverbParams[85]) : '',
      alt?.reverbParams?.[86] !== undefined ? String(alt.reverbParams[86]) : '',
      alt?.reverbParams?.[87] !== undefined ? String(alt.reverbParams[87]) : '',
      alt?.reverbParams?.[88] !== undefined ? String(alt.reverbParams[88]) : '',
      alt?.reverbParams?.[89] !== undefined ? String(alt.reverbParams[89]) : '',
      alt?.reverbParams?.[90] !== undefined ? String(alt.reverbParams[90]) : '',

      // Globals
      alt?.bpm !== undefined ? String(alt.bpm) : '',
      alt?.root !== undefined ? (ROOT_NOTES[alt.root] ?? String(alt.root)) : '',
      alt?.octave !== undefined ? String(alt.octave) : '',
      alt?.scale !== undefined ? (SCALES[alt.scale] ?? String(alt.scale)) : '',

      // Tags: one quoted cell, comma separated
      patch.tags && patch.tags.length > 0 ? escapeCsvField(patch.tags.join(', ')) : '',
    ];

    lines.push(row.join(','));
  }

  const csvContent = lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `rnd_synth_patches_${timestamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Parses a single CSV line supporting quoted fields and embedded commas.
 */
function parseCsvRow(rowText: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < rowText.length; i++) {
    const char = rowText[i];
    if (char === '"') {
      if (inQuotes && rowText[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Checks if the first row is a header row.
 */
function isHeaderRow(cols: string[]): boolean {
  if (cols.length === 0) return false;
  const c0 = cols[0].toLowerCase();
  const c1 = (cols[1] || '').toLowerCase();
  return (
    c0.includes('sysex') ||
    c0.includes('patch') ||
    c1.includes('name') ||
    c0.includes('ch 1')
  );
}

/**
 * Imports patches from a CSV string into IndexedDB and the patches store.
 * Supports:
 * - 39-column CSV with row 1 headers (current format, last column TAGS; older 38- and 34-column files still import)
 * - 2-column CSV (legacy format)
 * - 'append': Adds unique patches from CSV to the existing library.
 * - 'replace': Clears the existing library (IndexedDB & store) before adding the CSV patches.
 */
export async function importPatchesFromCsv(
  csvText: string,
  mode: 'append' | 'replace' = 'append'
): Promise<{ imported: number; errors: number }> {
  const lines = csvText.split(/\r?\n/);
  const newPatches: PatchRecord[] = [];
  let errorCount = 0;
  let headerMap: Map<string, number> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvRow(line);
    if (!cols || cols.length < 2) {
      errorCount++;
      continue;
    }

    // Skip title / header row if detected on row 1 and populate column mapping
    if (i === 0 && isHeaderRow(cols)) {
      headerMap = new Map();
      cols.forEach((col, idx) => {
        headerMap!.set(col.toUpperCase().trim(), idx);
      });
      continue;
    }

    const rawHex = (headerMap && headerMap.has('SYSEX') ? cols[headerMap.get('SYSEX')!] : cols[0]) || '';
    const patchName = (headerMap && headerMap.has('PATCH NAME') ? cols[headerMap.get('PATCH NAME')!] : cols[1]) || '';
    const cleanHex = rawHex.replace(/[\s,]/g, '').toUpperCase();

    // Validate F0...F7 framing
    if (
      cleanHex.length < 10 ||
      cleanHex.length % 2 !== 0 ||
      !cleanHex.startsWith('F0') ||
      !cleanHex.endsWith('F7')
    ) {
      console.warn(`[CSV Import] Invalid framing on line ${i + 1}:`, rawHex);
      errorCount++;
      continue;
    }

    try {
      const bytes = hexToBytes(cleanHex);
      const parsedSysEx = parseSysExMessage(bytes);

      let seed = 0;
      if (parsedSysEx && parsedSysEx.type === 'seed') {
        seed = parsedSysEx.seed;
      }

      // Procedural levels from seed
      const procedural = calculateProceduralLevels(seed);

      // Parse additional columns if present
      const parseNum = (str: string | undefined): number | undefined => {
        if (!str || str.trim() === '') return undefined;
        const n = Number(str.trim());
        return isNaN(n) ? undefined : n;
      };

      const parseBool = (str: string | undefined): boolean | undefined => {
        if (!str || str.trim() === '') return undefined;
        const s = str.trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'muted' || s === 'soloed' || s === 'yes') return true;
        if (s === 'false' || s === '0' || s === 'unmuted' || s === 'no' || s === 'off') return false;
        return undefined;
      };

      const parseStr = (str: string | undefined): string | undefined => {
        if (!str || str.trim() === '') return undefined;
        return str.trim();
      };

      const parseEngine = (str: string | undefined): number | undefined => {
        if (!str || str.trim() === '') return undefined;
        const idx = resolveEngineIndex(str);
        return idx >= 0 ? idx : undefined;
      };

      // "<count>:<hex seed>" (JGpatch-014 exact reroll) -> seed part
      const parseRerollSeed = (str: string | undefined): number | undefined => {
        const m = str?.trim().match(/^\d+\s*:\s*(?:0x)?([0-9a-f]{1,8})$/i);
        return m ? parseInt(m[1], 16) >>> 0 : undefined;
      };

      const parseReroll = (str: string | undefined): number | undefined => {
        if (!str || str.trim() === '') return undefined;
        const s = str.trim().split(':')[0].trim();
        const n = Number(s);
        if (!isNaN(n)) {
          return n > 0 ? Math.floor(n) : undefined;
        }
        const matchCount = s.match(/(\d+)\s*x/i);
        if (matchCount) {
          const val = parseInt(matchCount[1], 10);
          return val > 0 ? val : undefined;
        }
        const lower = s.toLowerCase();
        if (lower === 'true' || lower === 'yes' || lower === 'rerolled') {
          return 1;
        }
        return undefined;
      };

      const isNew38Format = cols.length >= 38;
      const getVal = (headerName: string, fallbackIdx38: number, fallbackIdx34: number): string | undefined => {
        if (headerMap && headerMap.has(headerName)) {
          return cols[headerMap.get(headerName)!];
        }
        if (isNew38Format) {
          return cols[fallbackIdx38];
        }
        return fallbackIdx34 >= 0 ? cols[fallbackIdx34] : undefined;
      };

      const partialFields: Partial<PatchRecord> = {
        ch1Volume: parseNum(getVal('CH 1 VOLUME', 2, 2)),
        ch1Reverb: parseNum(getVal('CH 1 REVERB', 3, 3)),
        ch1Mute: parseBool(getVal('CH 1 MUTE', 4, 4)),
        ch1Solo: parseBool(getVal('CH 1 SOLO', 5, 5)),
        ch1Engine: parseEngine(getVal('CH 1 ENGINE', 6, 6)),
        ch1Reroll: parseReroll(getVal('CH 1 REROLL', 7, -1)),
        ch1RerollSeed: parseRerollSeed(getVal('CH 1 REROLL', 7, -1)),

        ch2Volume: parseNum(getVal('CH 2 VOLUME', 8, 7)),
        ch2Reverb: parseNum(getVal('CH 2 REVERB', 9, 8)),
        ch2Mute: parseBool(getVal('CH 2 MUTE', 10, 9)),
        ch2Solo: parseBool(getVal('CH 2 SOLO', 11, 10)),
        ch2Engine: parseEngine(getVal('CH 2 ENGINE', 12, 11)),
        ch2Reroll: parseReroll(getVal('CH 2 REROLL', 13, -1)),
        ch2RerollSeed: parseRerollSeed(getVal('CH 2 REROLL', 13, -1)),

        ch3Volume: parseNum(getVal('CH 3 VOLUME', 14, 12)),
        ch3Reverb: parseNum(getVal('CH 3 REVERB', 15, 13)),
        ch3Mute: parseBool(getVal('CH 3 MUTE', 16, 14)),
        ch3Solo: parseBool(getVal('CH 3 SOLO', 17, 15)),
        ch3Engine: parseEngine(getVal('CH 3 ENGINE', 18, 16)),
        ch3Reroll: parseReroll(getVal('CH 3 REROLL', 19, -1)),
        ch3RerollSeed: parseRerollSeed(getVal('CH 3 REROLL', 19, -1)),

        ch4Volume: parseNum(getVal('CH 4 VOLUME', 20, 17)),
        ch4Reverb: parseNum(getVal('CH 4 REVERB', 21, 18)),
        ch4Mute: parseBool(getVal('CH 4 MUTE', 22, 19)),
        ch4Solo: parseBool(getVal('CH 4 SOLO', 23, 20)),
        ch4Engine: parseEngine(getVal('CH 4 ENGINE', 24, 21)),
        ch4Reroll: parseReroll(getVal('CH 4 REROLL', 25, -1)),
        ch4RerollSeed: parseRerollSeed(getVal('CH 4 REROLL', 25, -1)),

        masterReverbMultiplier: parseNum(getVal('MASTER REVERB MULTIPLIER', 26, 22)),
        masterVolume: parseNum(getVal('MASTER VOLUME', 27, 23)),

        reverbPredelay: parseNum(getVal('REVERB PRE-DELAY', 28, 24)),
        reverbTone: parseNum(getVal('REVERB TONE', 29, 25)),
        reverbDiffusion1: parseNum(getVal('REVERB DIFFUSION 1', 30, 26)),
        reverbDiffusion2: parseNum(getVal('REVERB DIFFUSION 2', 31, 27)),
        reverbRoomSize: parseNum(getVal('REVERB ROOM SIZE', 32, 28)),
        reverbDecay: parseNum(getVal('REVERB DECAY', 33, 29)),

        tempoBpm: parseNum(getVal('TEMPO BPM', 34, 30)),
        keyRootNote: parseStr(getVal('KEY ROOT NOTE', 35, 31)),
        keyRootOctave: parseNum(getVal('KEY ROOT OCTAVE', 36, 32)),
        musicalScale: parseStr(getVal('MUSICAL SCALE', 37, 33)),
      };

      const altered = buildAlteredFromFlatFields(partialFields);

      const defaultGlobals: GlobalSettings = {
        type: 0,
        bpm: altered?.bpm ?? 120,
        root: altered?.root ?? 0,
        octave: altered?.octave ?? 4,
        scale: altered?.scale ?? 0,
      };

      // Channel activity is unknown at import time: the hardware only emits 0x22 for its
      // active tracks, so activity is learned from the 0x22 dump when the patch is loaded.
      const defaultTracks = [0, 1, 2, 3].map((ch) => ({
        track: ch,
        active: false,
        role: ch,
        mode: 0,
        engine: altered?.engines?.[ch] !== undefined ? resolveEngineName(altered.engines[ch]) : '—',
        muted: altered?.mutes?.[ch] ?? false,
        soloed: altered?.solos?.[ch] ?? false,
      }));

      let patch: PatchRecord = {
        id: crypto.randomUUID(),
        name: patchName || `Imported Patch ${newPatches.length + 1}`,
        sysexHex: cleanHex,
        seed,
        createdAt: Date.now() + newPatches.length,
        isSaved: true,
        globalSettings: defaultGlobals,
        // originalGlobalSettings is intentionally left undefined: the true seed defaults are
        // recorded from the hardware 0x21 dump. Fabricating them here made unedited key/scale/BPM
        // controls appear edited after reload.
        tracks: normalizeTracks(defaultTracks),
        proceduralLevels: procedural,
        altered,
      };

      // TAGS: header column, else column 39 of a header-less 39-column file
      const tags = parseTags(headerMap ? getVal('TAGS', -1, -1) : cols.length >= 39 ? cols[38] : undefined);
      if (tags.length > 0) patch.tags = tags;

      patch = syncFlatFieldsFromAltered(patch);
      newPatches.push(patch);
    } catch (err) {
      console.warn(`[CSV Import] Error parsing hex on line ${i + 1}:`, err);
      errorCount++;
    }
  }

  if (newPatches.length > 0) {
    if (mode === 'replace') {
      // Deduplicate within the CSV file itself
      const seen = new Set<string>();
      const uniqueCsvPatches: PatchRecord[] = [];
      for (const p of newPatches) {
        const hex = p.sysexHex.replace(/[\s,]/g, '').toUpperCase();
        if (!seen.has(hex)) {
          seen.add(hex);
          uniqueCsvPatches.push(p);
        }
      }

      // Library order follows CSV row order
      uniqueCsvPatches.forEach((p, i) => (p.sortOrder = i));

      // 1. Replace the IndexedDB library (single transaction: a failed write keeps the old library)
      await replaceAllPatchesInDb(uniqueCsvPatches);

      // 3. Overwrite patchesStore with new patches
      patchesStore.set(uniqueCsvPatches);

      // 4. Select the first patch and initialize UI controls
      if (uniqueCsvPatches.length > 0) {
        const first = uniqueCsvPatches[0];
        selectedPatchId.set(first.id);
        setPatchBaseline(first);
        activeGlobalSettings.set({ octave: 4, ...(first.globalSettings || { bpm: 120, root: 0, octave: 4, scale: 0, type: 0 }) });
        activeTracks.set(normalizeTracks(first.tracks));
        if (first.proceduralLevels) {
          applyProceduralPatchLevels(first.proceduralLevels);
        }
        if (first.altered) {
          applyAlteredControls(first.altered);
        }
      } else {
        selectedPatchId.set(null);
      }

      return { imported: uniqueCsvPatches.length, errors: errorCount };
    }

    // Default 'append' mode:
    const current = get(patchesStore);
    const existingHexes = new Set(
      current.map((p) => p.sysexHex.replace(/[\s,]/g, '').toUpperCase())
    );

    // Filter out any patches that already exist in the librarian
    const uniquePatches = newPatches.filter(
      (p) => !existingHexes.has(p.sysexHex.replace(/[\s,]/g, '').toUpperCase())
    );

    if (uniquePatches.length > 0) {
      // Imported rows go on top of the library, keeping their CSV row order
      const orders = topSortOrders(current, uniquePatches.length);
      uniquePatches.forEach((p, i) => (p.sortOrder = orders[i]));

      // Save to IndexedDB
      await saveMultiplePatchesToDb(uniquePatches);

      // Merge into store
      patchesStore.update((existing) => {
        return [...uniquePatches, ...existing];
      });

      // Auto-select first newly imported patch and initialize UI controls
      const first = uniquePatches[0];
      selectedPatchId.set(first.id);
      setPatchBaseline(first);
      activeGlobalSettings.set({ octave: 4, ...(first.globalSettings || { bpm: 120, root: 0, octave: 4, scale: 0, type: 0 }) });
      activeTracks.set(normalizeTracks(first.tracks));
      if (first.proceduralLevels) {
        applyProceduralPatchLevels(first.proceduralLevels);
      }
      if (first.altered) {
        applyAlteredControls(first.altered);
      }
    }

    return { imported: uniquePatches.length, errors: errorCount };
  }

  return { imported: 0, errors: errorCount };
}
