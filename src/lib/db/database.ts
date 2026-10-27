import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { PatchRecord } from '../types';
import { resolveEngineIndex, resolveEngineName, syncFlatFieldsFromAltered } from '../types';

interface RndDbSchema extends DBSchema {
  patches: {
    key: string;
    value: PatchRecord;
    indexes: { 'by-name': string; 'by-created': number };
  };
}

const DB_NAME = 'rnd_synth_librarian';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<RndDbSchema>> | null = null;

function getDb(): Promise<IDBPDatabase<RndDbSchema>> {
  if (typeof indexedDB === 'undefined') {
    if (!dbPromise) {
      const inMem = new Map<string, any>();
      dbPromise = Promise.resolve({
        transaction: () => ({
          store: { put: async (val: any) => inMem.set(val.id, val) },
          done: Promise.resolve(),
        }),
        clear: async () => inMem.clear(),
        getAll: async () => Array.from(inMem.values()),
        get: async (_store: any, id: any) => inMem.get(id),
        put: async (_store: any, val: any) => inMem.set(val.id, val),
        delete: async (_store: any, id: any) => inMem.delete(id),
      } as any);
    }
    return dbPromise;
  }

  if (!dbPromise) {
    dbPromise = openDB<RndDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('patches')) {
          const store = db.createObjectStore('patches', { keyPath: 'id' });
          store.createIndex('by-name', 'name');
          store.createIndex('by-created', 'createdAt');
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Migrates existing patch records to the new numeric engine format (0..7),
 * ensuring any legacy text engine names in flat fields, altered controls,
 * or tracks are converted to their correct number and canonical names.
 */
function migratePatchRecord(patch: PatchRecord): { migrated: PatchRecord; changed: boolean } {
  let changed = false;
  const p = { ...patch };

  const engineKeys: (keyof Pick<PatchRecord, 'ch1Engine' | 'ch2Engine' | 'ch3Engine' | 'ch4Engine'>)[] = [
    'ch1Engine', 'ch2Engine', 'ch3Engine', 'ch4Engine'
  ];
  const rerollKeys: (keyof Pick<PatchRecord, 'ch1Reroll' | 'ch2Reroll' | 'ch3Reroll' | 'ch4Reroll' | 'ch1RerollSeed' | 'ch2RerollSeed' | 'ch3RerollSeed' | 'ch4RerollSeed'>)[] = [
    'ch1Reroll', 'ch2Reroll', 'ch3Reroll', 'ch4Reroll',
    'ch1RerollSeed', 'ch2RerollSeed', 'ch3RerollSeed', 'ch4RerollSeed'
  ];

  // 1. Migrate flat engine fields to numbers
  for (let ch = 0; ch < 4; ch++) {
    const key = engineKeys[ch];
    const val = p[key];
    if (val !== undefined) {
      const idx = resolveEngineIndex(val);
      if (idx >= 0 && val !== idx) {
        p[key] = idx;
        changed = true;
      }
    }
  }

  // 2. Migrate altered.engines to numbers
  if (p.altered && p.altered.engines) {
    const altEngines = { ...p.altered.engines };
    let altChanged = false;
    for (let ch = 0; ch < 4; ch++) {
      if (altEngines[ch] !== undefined) {
        const idx = resolveEngineIndex(altEngines[ch]);
        if (idx >= 0 && altEngines[ch] !== idx) {
          altEngines[ch] = idx;
          altChanged = true;
        }
      }
    }
    if (altChanged) {
      p.altered = { ...p.altered, engines: altEngines };
      changed = true;
    }
  }


  // 3. Ensure flat fields are in sync with altered
  if (p.altered) {
    const synced = syncFlatFieldsFromAltered(p);
    for (const key of engineKeys) {
      if (synced[key] !== p[key]) {
        p[key] = synced[key];
        changed = true;
      }
    }
    for (const key of rerollKeys) {
      if (synced[key] !== p[key]) {
        p[key] = synced[key];
        changed = true;
      }
    }
  } else if (p.ch1Reroll || p.ch2Reroll || p.ch3Reroll || p.ch4Reroll) {
    const r0 = p.ch1Reroll ? Math.max(0, p.ch1Reroll) : 0;
    const r1 = p.ch2Reroll ? Math.max(0, p.ch2Reroll) : 0;
    const r2 = p.ch3Reroll ? Math.max(0, p.ch3Reroll) : 0;
    const r3 = p.ch4Reroll ? Math.max(0, p.ch4Reroll) : 0;
    if (r0 > 0 || r1 > 0 || r2 > 0 || r3 > 0) {
      p.altered = { ...(p.altered ?? {}), rerolls: [r0, r1, r2, r3] };
      changed = true;
    }
  }

  // 4. Ensure track.engine has standard display name string
  if (p.tracks) {
    const trks = p.tracks.map((t) => {
      const engName = resolveEngineName(t.engine);
      if (t.engine !== engName) {
        changed = true;
        return { ...t, engine: engName };
      }
      return t;
    });
    p.tracks = trks;
  }

  return { migrated: p, changed };
}

export async function getAllStoredPatches(): Promise<PatchRecord[]> {
  try {
    const db = await getDb();
    const records = await db.getAll('patches');
    const migratedRecords: PatchRecord[] = [];
    const tx = db.transaction('patches', 'readwrite');

    for (const r of records) {
      const { migrated, changed } = migratePatchRecord(r);
      const withSaved = { ...migrated, isSaved: true };
      if (changed) {
        await tx.store.put(withSaved);
      }
      migratedRecords.push(withSaved);
    }

    // Librarian order: sortOrder ascending; records from before drag & drop fall back to newest first
    migratedRecords.sort(
      (a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || b.createdAt - a.createdAt
    );
    // Give legacy records an explicit position so later reorders and inserts stay consistent
    if (migratedRecords.some((p) => p.sortOrder === undefined)) {
      for (let i = 0; i < migratedRecords.length; i++) {
        migratedRecords[i] = { ...migratedRecords[i], sortOrder: i };
        await tx.store.put(migratedRecords[i]);
      }
    }
    await tx.done;

    return migratedRecords;
  } catch (err) {
    console.error('Failed to load patches from IndexedDB:', err);
    return [];
  }
}

export async function getPatchFromDb(id: string): Promise<PatchRecord | undefined> {
  try {
    const db = await getDb();
    const record = await db.get('patches', id);
    if (!record) return undefined;
    const { migrated, changed } = migratePatchRecord(record);
    if (changed) {
      await db.put('patches', { ...migrated, isSaved: true });
    }
    return { ...migrated, isSaved: true };
  } catch (err) {
    console.error('Failed to get patch from IndexedDB:', err);
    return undefined;
  }
}

export async function savePatchToDb(patch: PatchRecord): Promise<void> {
  const db = await getDb();
  const { migrated } = migratePatchRecord(patch);
  await db.put('patches', { ...migrated, isSaved: true });
}

export async function deletePatchFromDb(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('patches', id);
}

export async function saveMultiplePatchesToDb(patches: PatchRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('patches', 'readwrite');
  for (const patch of patches) {
    await tx.store.put({ ...patch, isSaved: true });
  }
  await tx.done;
}

/**
 * Persists Librarian order. Only sortOrder is written, onto the stored record, so unsaved edits
 * held in the UI are never committed; ids not in the database (unsaved patches) are skipped.
 */
export async function updatePatchSortOrdersInDb(order: { id: string; sortOrder: number }[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('patches', 'readwrite');
  for (const { id, sortOrder } of order) {
    const rec = await tx.store.get(id);
    if (rec && rec.sortOrder !== sortOrder) {
      await tx.store.put({ ...rec, sortOrder });
    }
  }
  await tx.done;
}

/**
 * Replaces the whole library in one transaction: if writing the new patches fails,
 * the old library is left untouched instead of being wiped.
 */
export async function replaceAllPatchesInDb(patches: PatchRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('patches', 'readwrite');
  await tx.store.clear();
  for (const patch of patches) {
    await tx.store.put({ ...patch, isSaved: true });
  }
  await tx.done;
}

