import { get } from 'svelte/store';
import {
  midiStore,
  patchesStore,
  selectedPatchId,
  activeGlobalSettings,
  activeTracks,
  flashRxLed,
  flashTxLed,
  masterVolumeStore,
  masterReverbMultStore,
  trackVolumesStore,
  trackReverbsStore,
  reverbPredelayStore,
  reverbToneStore,
  reverbDiffusion1Store,
  reverbDiffusion2Store,
  reverbDecayStore,
  reverbRoomSizeStore,
  applyProceduralPatchLevels,
  normalizeTracks,
  typesToGenerateMask,
  activePatchBaseline,
  setPatchBaseline,
  clearRerolledTracks,
  rerolledTracksStore,
  setTrackRerollSeed,
  isPatchLoadingStore,
  isSeedDumpPendingStore,
  markActivePatchDirty,
  applyAlteredControls,
  reverbDecayKnobStore,
  connectedFirmware,
  isFirmwareModalOpen,
  storageCheckStore,
} from '../stores';
import { calculateProceduralLevels } from './procedural';
import {
  buildGenerateSeedSysEx,
  buildGlobalSettingsSysEx,
  buildMuteTrackSysEx,
  buildRerollTrackSysEx,
  buildSeededRerollSysEx,
  buildLoadHoldSysEx,
  buildStorageCheckSysEx,
  buildDirectEngineSysEx,
  buildVersionInquirySysEx,
  buildSeedSysEx,
  buildSoloTrackSysEx,
  buildTriggerSysEx,
  hexToBytes,
  parseSysExMessage,
} from './sysex';
import { MidiTransmissionQueue } from './queue';
import {
  scaleIndexToCC9,
  hasAlteredControls,
  SYNTH_ENGINES,
  getSelectableEngines,
  pickOriginalEngine,
  resolveEngineIndex,
  resolveEngineName,
  getRerollCount,
  getRerollSeed,
  topSortOrders,
  LATEST_FIRMWARE_PATCH,
  type ConnectedFirmwareInfo,
  type MidiPortInfo,
  type PatchRecord,
  type GlobalSettings,
  type TrackConfig,
} from '../types';

const TARGET_DEVICE_NAME = 'RND Synth';

export function formatDefaultPatchName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  const secs = pad(d.getSeconds());
  return `Patch ${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

/** True for a real engine name (not the '—' / '' placeholders used for inactive or unknown tracks). */
function isEngineName(engine: string | number | undefined): engine is string | number {
  return engine !== undefined && engine !== '—' && engine !== '';
}

class MidiManager {
  private midiAccess: MIDIAccess | null = null;
  private queue: MidiTransmissionQueue;
  private currentInputPort: MIDIInput | null = null;
  private currentOutputPort: MIDIOutput | null = null;
  private isResetSeedPending: boolean = false;
  private resetSeedSessionUntil: number = 0;
  private resetSeedTimer: number | null = null;
  private currentLoadingPatchId: string | null = null;
  // Set while a reloaded patch's seed dump is arriving, before any overrides are sent: the 0x22
  // engines in that window are the seed's authentic engines.
  private seedDumpPatchId: string | null = null;
  private incomingSysexResolvers: Array<() => void> = [];
  private versionQueryTimer: number | null = null;
  private versionRetryTimer: number | null = null;
  private stockProbeTimer: number | null = null;
  // Set once the 0x7E version inquiry window has passed with no 0x7F reply (no JGpatch firmware answered)
  private versionCheckExpired: boolean = false;
  // While > now, RND SysEx is the reply to our stock-detection probe (0x18) and must not be ingested
  private stockProbeUntil: number = 0;
  private hasPromptedFirmwareUpdate: boolean = false;

  constructor() {
    this.queue = new MidiTransmissionQueue(30); // 30ms rate limit
    this.queue.setSendHandler(this.rawSend.bind(this));
  }

  public cancelResetSession(): void {
    this.isResetSeedPending = false;
    this.resetSeedSessionUntil = 0;
    if (this.resetSeedTimer !== null) {
      clearTimeout(this.resetSeedTimer);
      this.resetSeedTimer = null;
    }
  }

  private notifyIncomingSysex(): void {
    if (this.incomingSysexResolvers.length > 0) {
      const resolvers = [...this.incomingSysexResolvers];
      this.incomingSysexResolvers = [];
      for (const res of resolvers) {
        res();
      }
    }
  }

  /**
   * Waits for the RND synth to completely finish its response dump to a patch seed.
   * When 0x10 is sent, the synth responds with a burst: 0x10, 0x20, 0x21, and 0x22 for each active track.
   * This function collects incoming messages and waits for an idle period (settleMs, default 65ms)
   * after the last message, with an overall timeout fallback (maxTimeoutMs, default 300ms).
   */
  public async waitForPatchResponse(settleMs: number = 65, maxTimeoutMs: number = 300): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      let idleTimer: number | null = null;
      let hardTimer: number | null = null;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          if (idleTimer !== null) clearTimeout(idleTimer);
          if (hardTimer !== null) clearTimeout(hardTimer);
          this.incomingSysexResolvers = this.incomingSysexResolvers.filter((r) => r !== onMsg);
          resolve();
        }
      };

      const resetIdle = () => {
        if (resolved) return;
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = window.setTimeout(finish, settleMs);
      };

      const onMsg = () => {
        resetIdle();
      };

      this.incomingSysexResolvers.push(onMsg);

      // Hard timeout safeguard if hardware is offline or does not respond
      hardTimer = window.setTimeout(finish, maxTimeoutMs);
    });
  }

  /**
   * Loads a patch from the librarian:
   * 1. Sends the patch SysEx (0x10) to the RND synth.
   * 2. Waits for RND to send SysEx back (idle 65 ms, 300 ms timeout safeguard).
   * 3. Sequentially sends all saved altered states through the rate-limited transmission queue.
   *
   * Patches with altered controls are loaded under a Load Hold (SysEx 0x1B, JGpatch-015): the RND keeps
   * its sequencer and voices paused and silent from before the seed until the last override has been sent,
   * so the original random patch is never heard and no drone / jingle onset is missed.
   */
  public async loadPatchWithOverrides(patch: PatchRecord): Promise<void> {
    this.cancelResetSession();
    const patchId = patch.id;
    this.currentLoadingPatchId = patchId;
    isPatchLoadingStore.set(true);

    // Snapshot the saved track configurations before sending seed SysEx 0x10,
    // so incoming initial seed telemetry (0x22) cannot clobber saved rerolled engines.
    const savedTracks = patch.tracks ? patch.tracks.map((t) => ({ ...t })) : [];
    const flatEngines = [patch.ch1Engine, patch.ch2Engine, patch.ch3Engine, patch.ch4Engine];

    // Engine to restore on a track: the saved altered engine, or for a rerolled track its saved engine
    const targetEngineFor = (ch: number, rerolled: boolean): string | number | undefined => {
      const altEngine = patch.altered?.engines?.[ch];
      if (altEngine !== undefined) return altEngine;
      if (!rerolled) return undefined;
      return isEngineName(savedTracks[ch]?.engine) ? savedTracks[ch].engine : flatEngines[ch];
    };

    // Clear any pending messages from a previous patch to avoid race conditions
    this.queue.clear();

    const needsHold = !!patch.altered && hasAlteredControls(patch.altered);
    let holdActive = false;

    try {
      // Hold before the seed when overrides follow; otherwise release any hold left by an interrupted load
      await this.rawSend(buildLoadHoldSysEx(needsHold));
      holdActive = needsHold;

      if (patch.sysexHex) {
        const bytes = hexToBytes(patch.sysexHex);
        this.seedDumpPatchId = patchId;
        isSeedDumpPendingStore.set(true);
        await this.rawSend(bytes);
      }

      // Wait for RND synth to completely finish generating and dumping patch telemetry
      await this.waitForPatchResponse();
      if (this.seedDumpPatchId === patchId) {
        this.seedDumpPatchId = null;
        isSeedDumpPendingStore.set(false);
      }

      // Guard: Did user select another patch while waiting?
      if (this.currentLoadingPatchId !== patchId) return;

      const alt = patch.altered;
      if (alt && hasAlteredControls(alt)) {
        // 0. Exact rerolls (Seeded Reroll SysEx 0x1A, JGpatch-014). Replayed first, straight after the seed,
        // so the track regenerates from the same state it was originally rerolled from; engine, volume
        // and reverb alterations below are then layered on top exactly as before.
        for (let ch = 0; ch < 4; ch++) {
          if (this.currentLoadingPatchId !== patchId) return;
          const rerollSeed = getRerollSeed(alt.rerollSeeds?.[ch]);
          if (getRerollCount(alt.rerolls?.[ch]) > 0 && rerollSeed !== undefined) {
            const rerollMsg = buildSeededRerollSysEx(ch, rerollSeed);
            await this.queue.enqueue(rerollMsg, `CH ${ch + 1} Seeded Reroll (0x1A) seed=${rerollSeed.toString(16)}`);
          }
        }

        // 1. Tempo BPM
        if (alt.bpm !== undefined) {
          if (this.currentLoadingPatchId !== patchId) return;
          const currentGlobals = get(activeGlobalSettings);
          const updatedGlobals: GlobalSettings = { ...currentGlobals, bpm: alt.bpm };
          activeGlobalSettings.set(updatedGlobals);
          const bpmMsg = buildGlobalSettingsSysEx(updatedGlobals);
          await this.queue.enqueue(bpmMsg, `Altered BPM = ${alt.bpm}`);
        }

        // 2. Musical Scale (CC 9)
        if (alt.scale !== undefined) {
          if (this.currentLoadingPatchId !== patchId) return;
          activeGlobalSettings.update((s) => ({ ...s, scale: alt.scale! }));
          const ccVal = scaleIndexToCC9(alt.scale);
          const scaleMsg = new Uint8Array([0xb0, 9, ccVal & 0x7f]);
          await this.queue.enqueue(scaleMsg, `Altered Scale = ${alt.scale}`);
        }

        // 3. Key Root Note & Octave (Note On / Off)
        if (alt.root !== undefined || alt.octave !== undefined) {
          if (this.currentLoadingPatchId !== patchId) return;
          const root = alt.root ?? get(activeGlobalSettings).root ?? 0;
          const oct = alt.octave ?? get(activeGlobalSettings).octave ?? 4;
          activeGlobalSettings.update((s) => ({
            ...s,
            root: alt.root !== undefined ? alt.root : s.root,
            octave: alt.octave !== undefined ? alt.octave : (s.octave ?? 4),
          }));
          const noteNumber = Math.max(0, Math.min(127, (oct + 1) * 12 + (root % 12)));
          const noteOnMsg = new Uint8Array([0x90, noteNumber & 0x7f, 100]);
          await this.queue.enqueue(noteOnMsg, `Altered Root/Octave Note On`);
          const noteOffMsg = new Uint8Array([0x80, noteNumber & 0x7f, 0]);
          await this.queue.enqueue(noteOffMsg, `Altered Root/Octave Note Off`);
        }

        // 4. Master Volume (CC 7 Ch 1)
        if (alt.masterVolume !== undefined) {
          if (this.currentLoadingPatchId !== patchId) return;
          const mVolMsg = new Uint8Array([0xb0, 7, alt.masterVolume & 0x7f]);
          await this.queue.enqueue(mVolMsg, `Altered Master Volume = ${alt.masterVolume}`);
        }

        // 5. Master Reverb Multiplier (CC 91 Ch 1)
        if (alt.masterReverb !== undefined) {
          if (this.currentLoadingPatchId !== patchId) return;
          const mRevMsg = new Uint8Array([0xb0, 91, alt.masterReverb & 0x7f]);
          await this.queue.enqueue(mRevMsg, `Altered Master Reverb = ${alt.masterReverb}`);
        }

        // 6. CH 1 - 4 Controls (Volume, Reverb, Mute, Solo)
        for (let ch = 0; ch < 4; ch++) {
          if (this.currentLoadingPatchId !== patchId) return;
          const midiCh = ch + 1; // Channel 2 to 5 (0xb1 to 0xb4)
          const status = 0xb0 | midiCh;

          if (alt.trackVolumes && alt.trackVolumes[ch] !== undefined) {
            const vol = alt.trackVolumes[ch];
            const chVolMsg = new Uint8Array([status, 7, vol & 0x7f]);
            await this.queue.enqueue(chVolMsg, `Altered CH ${ch + 1} Volume = ${vol}`);
          }

          if (alt.trackReverbs && alt.trackReverbs[ch] !== undefined) {
            const rev = alt.trackReverbs[ch];
            const chRevMsg = new Uint8Array([status, 91, rev & 0x7f]);
            await this.queue.enqueue(chRevMsg, `Altered CH ${ch + 1} Reverb = ${rev}`);
          }

          if (alt.mutes && alt.mutes[ch] !== undefined) {
            const muteMsg = buildMuteTrackSysEx(ch, alt.mutes[ch]);
            await this.queue.enqueue(muteMsg, `Altered CH ${ch + 1} Mute = ${alt.mutes[ch]}`);
          }

          if (alt.solos && alt.solos[ch] !== undefined) {
            const soloMsg = buildSoloTrackSysEx(ch, alt.solos[ch]);
            await this.queue.enqueue(soloMsg, `Altered CH ${ch + 1} Solo = ${alt.solos[ch]}`);
          }
        }

        // 7. Track Engines (Direct Engine Select via SysEx 0x19 - non-randomizing & clickless)
        for (let ch = 0; ch < 4; ch++) {
          if (this.currentLoadingPatchId !== patchId) return;
          const rCount = getRerollCount(alt.rerolls?.[ch]);
          const targetEngineVal = targetEngineFor(ch, rCount > 0);
          if (isEngineName(targetEngineVal)) {
            const engName = resolveEngineName(targetEngineVal);
            const targetIdx = resolveEngineIndex(engName);
            const curTrack = get(activeTracks)[ch];
            const curEngineName = curTrack?.engine || get(activePatchBaseline)?.enginePerTrack?.[ch] || 'Subtractive';
            const curIdx = resolveEngineIndex(curEngineName);
            if (targetIdx >= 0 && (curIdx !== targetIdx || rCount > 0)) {
              const engineMsg = buildDirectEngineSysEx(ch, targetIdx);
              await this.queue.enqueue(engineMsg, `CH ${ch + 1} Set Engine to ${engName} (Direct 0x19)`);
            }
          }
        }

        // 8. 6 DSP Reverb controls (CC 85 - 90 on Ch 1)
        if (alt.reverbParams) {
          for (const cc of [85, 86, 87, 88, 89, 90]) {
            if (this.currentLoadingPatchId !== patchId) return;
            if (alt.reverbParams[cc] !== undefined) {
              const val = alt.reverbParams[cc];
              const dspMsg = new Uint8Array([0xb0, cc, val & 0x7f]);
              await this.queue.enqueue(dspMsg, `Altered DSP Reverb CC ${cc} = ${val}`);
            }
          }
        }

        // Every override is queued ahead of this, so the RND applies them all before playback resumes
        if (this.currentLoadingPatchId !== patchId) return;
        await this.queue.enqueue(buildLoadHoldSysEx(false), 'Release Load Hold (0x1B)');
        holdActive = false;

        // Wait for all queued messages to finish transmitting to the RND
        await this.queue.waitForDrain();

        // Small grace period to allow final telemetry responses (0x22 / etc) to arrive
        await new Promise((res) => setTimeout(res, 50));

        // Re-apply altered controls so any telemetry received during transmission
        // (such as initial 0x21/0x22 dumps) does not leave UI stores in seed default state
        applyAlteredControls(alt);

        // Ensure rerolled tracks retain their saved engines in activeTracks and patchesStore
        if (alt.rerolls) {
          const rerolledEngines = [0, 1, 2, 3].map((ch) => {
            const eng = getRerollCount(alt.rerolls?.[ch]) > 0 ? targetEngineFor(ch, true) : undefined;
            return isEngineName(eng) ? resolveEngineName(eng) : undefined;
          });
          const withRerolledEngines = (trks?: TrackConfig[]) =>
            normalizeTracks(trks).map((t, ch) => (rerolledEngines[ch] ? { ...t, engine: rerolledEngines[ch]! } : t));

          activeTracks.update(withRerolledEngines);
          patchesStore.update((list) =>
            list.map((p) => (p.id === patchId ? { ...p, tracks: withRerolledEngines(p.tracks) } : p))
          );
        }
      }
    } catch {
      // Cancelled by a newer load (queue cleared) or the RND went away mid-load
    } finally {
      // A newer load manages the hold itself; only release if this load still owns it
      if (holdActive && this.currentLoadingPatchId === patchId) {
        this.rawSend(buildLoadHoldSysEx(false)).catch(() => {});
      }
      if (this.seedDumpPatchId === patchId) {
        this.seedDumpPatchId = null;
        isSeedDumpPendingStore.set(false);
      }
      if (this.currentLoadingPatchId === patchId) {
        isPatchLoadingStore.set(false);
        this.currentLoadingPatchId = null;
      }
    }
  }

  /**
   * Initializes Web MIDI with SysEx permission.
   */
  public async initMidi(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      midiStore.update((s) => ({
        ...s,
        isSupported: false,
        statusText: 'Web MIDI API not supported in this browser',
      }));
      return;
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
      this.midiAccess.onstatechange = () => this.updatePortLists();

      midiStore.update((s) => ({
        ...s,
        isSupported: true,
        isSysexAllowed: true,
        statusText: 'MIDI Ready',
      }));

      this.updatePortLists();
    } catch (err: any) {
      console.warn('Web MIDI SysEx request failed:', err);
      midiStore.update((s) => ({
        ...s,
        isSupported: true,
        isSysexAllowed: false,
        statusText: 'SysEx permission denied or unavailable',
      }));
    }
  }

  /**
   * RESCAN: re-reads the port lists, or retries the Web MIDI permission request if it was denied.
   */
  public rescanPorts(): void {
    if (this.midiAccess) {
      this.updatePortLists();
    } else {
      this.initMidi();
    }
  }

  /**
   * Updates list of available input and output ports and auto-connects to RND Synth.
   */
  public updatePortLists(): void {
    if (!this.midiAccess) return;

    const inputs: MidiPortInfo[] = [];
    const outputs: MidiPortInfo[] = [];

    this.midiAccess.inputs.forEach((port) => {
      inputs.push({
        id: port.id,
        name: port.name ?? 'Unnamed Input',
        manufacturer: port.manufacturer ?? undefined,
        state: port.state,
      });
    });

    this.midiAccess.outputs.forEach((port) => {
      outputs.push({
        id: port.id,
        name: port.name ?? 'Unnamed Output',
        manufacturer: port.manufacturer ?? undefined,
        state: port.state,
      });
    });

    const currentState = get(midiStore);
    let selectedInputId = currentState.selectedInputId;
    let selectedOutputId = currentState.selectedOutputId;

    // Reset to (None) when the selected port has vanished or is no longer connected (e.g. the RND was unplugged)
    if (selectedInputId && !inputs.some((p) => p.id === selectedInputId && p.state === 'connected')) {
      selectedInputId = '';
    }
    if (selectedOutputId && !outputs.some((p) => p.id === selectedOutputId && p.state === 'connected')) {
      selectedOutputId = '';
    }

    // Auto-discovery: automatically search for a connected "RND Synth MIDI"
    const autoInput = inputs.find(
      (p) => p.state === 'connected' && p.name.toLowerCase().includes(TARGET_DEVICE_NAME.toLowerCase())
    );
    if (autoInput && !selectedInputId) {
      selectedInputId = autoInput.id;
    }

    const autoOutput = outputs.find(
      (p) => p.state === 'connected' && p.name.toLowerCase().includes(TARGET_DEVICE_NAME.toLowerCase())
    );
    if (autoOutput && !selectedOutputId) {
      selectedOutputId = autoOutput.id;
    }

    midiStore.update((s) => ({
      ...s,
      inputPorts: inputs,
      outputPorts: outputs,
      selectedInputId,
      selectedOutputId,
      statusText: selectedInputId && selectedOutputId ? 'Connected' : 'Select Ports',
    }));

    // An empty id releases the stale port handle and clears firmware info via handleDisconnect()
    this.selectInput(selectedInputId);
    this.selectOutput(selectedOutputId);
  }

  /**
   * Sets the active MIDI input port.
   */
  public selectInput(portId: string): void {
    if (this.currentInputPort) {
      this.currentInputPort.onmidimessage = null;
      this.currentInputPort.onstatechange = null;
    }

    midiStore.update((s) => ({ ...s, selectedInputId: portId }));
    if (!this.midiAccess) return;

    const input = this.midiAccess.inputs.get(portId);
    if (input) {
      this.currentInputPort = input;
      this.currentInputPort.onstatechange = (e: Event) => {
        if ((e as MIDIConnectionEvent)?.port?.state === 'disconnected') {
          this.handleDisconnect();
        }
      };
      this.currentInputPort.onmidimessage = (event: MIDIMessageEvent) => {
        if (event.data) {
          this.handleIncomingBytes(new Uint8Array(event.data));
        }
      };
      this.checkAndQueryFirmware();
    } else {
      this.currentInputPort = null;
      this.handleDisconnect();
    }
  }

  /**
   * Sets the active MIDI output port.
   */
  public selectOutput(portId: string): void {
    if (this.currentOutputPort) {
      this.currentOutputPort.onstatechange = null;
    }

    midiStore.update((s) => ({ ...s, selectedOutputId: portId }));
    if (!this.midiAccess) return;

    const output = this.midiAccess.outputs.get(portId);
    if (output) {
      this.currentOutputPort = output;
      this.currentOutputPort.onstatechange = (e: Event) => {
        if ((e as MIDIConnectionEvent)?.port?.state === 'disconnected') {
          this.handleDisconnect();
        }
      };
      // Synchronize TYPES TO GENERATE to the RND (CC 14)
      this.setTypesToGenerate(get(typesToGenerateMask));
      this.checkAndQueryFirmware();
    } else {
      this.currentOutputPort = null;
      this.handleDisconnect();
    }
  }

  /** Cancels any pending firmware version check / stock-firmware probe timers. */
  private clearVersionTimers(): void {
    for (const t of [this.versionQueryTimer, this.versionRetryTimer, this.stockProbeTimer]) {
      if (t !== null) clearTimeout(t);
    }
    this.versionQueryTimer = null;
    this.versionRetryTimer = null;
    this.stockProbeTimer = null;
  }

  public handleDisconnect(): void {
    this.clearVersionTimers();
    this.hasPromptedFirmwareUpdate = false;
    this.versionCheckExpired = false;
    this.stockProbeUntil = 0;
    connectedFirmware.set(null);
  }

  /**
   * Marks the connected RND as running stock factory v1.3 (no SysEx 0x7E version support)
   * and opens the JG-RND Patcher once.
   */
  private markStockFirmware(): void {
    const stockInfo: ConnectedFirmwareInfo = {
      detected: true,
      major: 1,
      minor: 3,
      patch: 0,
      versionString: 'v1.3 Stock Factory',
      isUpToDate: false,
      needsUpdate: true,
    };
    connectedFirmware.set(stockInfo);
    if (!this.hasPromptedFirmwareUpdate) {
      this.hasPromptedFirmwareUpdate = true;
      isFirmwareModalOpen.set(true);
    }
  }

  public checkAndQueryFirmware(): void {
    if (!this.currentInputPort || !this.currentOutputPort) return;

    this.clearVersionTimers();
    this.versionCheckExpired = false;

    // Query firmware version with a 200ms delay after connection
    this.versionQueryTimer = window.setTimeout(async () => {
      this.versionQueryTimer = null;
      await this.queryFirmwareVersion();

      // Retry once after 1200ms if no response received yet
      this.versionRetryTimer = window.setTimeout(async () => {
        this.versionRetryTimer = null;
        if (!get(connectedFirmware)) {
          await this.queryFirmwareVersion();

          // After another 1200ms (2.6s total) with no 0x7F reply, no JGpatch firmware is answering.
          // Stock factory v1.3 ignores 0x7E but does answer the 0x18 dump request, so probe with it:
          // any genuine RND SysEx reply proves an RND on stock firmware (see handleIncomingBytes).
          this.stockProbeTimer = window.setTimeout(async () => {
            this.stockProbeTimer = null;
            if (get(connectedFirmware)) return;
            this.versionCheckExpired = true;
            const inName = this.currentInputPort?.name?.toLowerCase() || '';
            const outName = this.currentOutputPort?.name?.toLowerCase() || '';
            if (inName.includes('rnd') || outName.includes('rnd')) {
              this.markStockFirmware();
              return;
            }
            this.stockProbeUntil = Date.now() + 1000;
            await this.rawSend(buildTriggerSysEx());
          }, 1200);
        }
      }, 1200);
    }, 200);
  }

  /** READ RND STORAGE: asks the RND (JGpatch-019+) where TYPES TO GENERATE is stored (reply: 0x24). */
  public async requestStorageCheck(): Promise<void> {
    storageCheckStore.set(null);
    await this.rawSend(buildStorageCheckSysEx());
  }

  public async queryFirmwareVersion(): Promise<void> {
    const msg = buildVersionInquirySysEx();
    await this.rawSend(msg);
  }

  /**
   * Low-level send (also the rate-limited queue's send handler). Silently does nothing while no
   * output port is selected; a port that fails mid-send (e.g. unplugged) is logged, never thrown.
   */
  private async rawSend(data: Uint8Array): Promise<void> {
    if (!this.currentOutputPort) return;
    flashTxLed();
    try {
      this.currentOutputPort.send(data);
    } catch (err) {
      console.error('[MIDI] Send failed:', err);
    }
  }

  /**
   * Handles incoming byte sequences from the RND.
   */
  public handleIncomingBytes(bytes: Uint8Array): void {
    flashRxLed();
    this.notifyIncomingSysex();
    const parsed = parseSysExMessage(bytes);
    if (!parsed) return;

    // Stock factory v1.3 detection: valid RND SysEx but no 0x7F version reply within the inquiry window.
    // This also catches a dump triggered later from the RND's own button.
    if (parsed.type !== 'version' && this.versionCheckExpired && !get(connectedFirmware)) {
      this.markStockFirmware();
    }
    // Swallow the reply to our own 0x18 probe so it is not ingested into the Librarian
    if (parsed.type !== 'version' && Date.now() < this.stockProbeUntil) return;

    switch (parsed.type) {
      case 'delimiter': {
        // 0x20: Frame delimiter emitted by hardware before globals (0x21) and active tracks (0x22).
        // The hardware emits 0x22 ONLY for active tracks, so the dump that follows is the single
        // source of truth for which channels are active. Reset the activity flags (keeping each
        // track's engine/role/etc.) for BOTH a newly generated patch and a librarian reload;
        // otherwise stale or defaulted `active: true` flags survive and all 4 channels show active.
        activeTracks.update((list) =>
          normalizeTracks(list).map((t) => ({ ...t, active: false }))
        );
        const activeId = get(selectedPatchId);
        if (activeId) {
          patchesStore.update((list) =>
            list.map((p) => {
              if (p.id !== activeId) return p;
              const tracks = normalizeTracks(p.tracks).map((t) => ({
                ...t,
                active: false,
              }));
              return { ...p, tracks };
            })
          );
        }
        // Only a newly generated patch (not a reload) discards the baseline.
        if (!this.currentLoadingPatchId) {
          activePatchBaseline.set(null);
        }
        break;
      }

      case 'seed': {
        // 0x10: Primary patch payload
        const isLoadingSeed = get(isPatchLoadingStore) || this.currentLoadingPatchId !== null;
        if (!isLoadingSeed) {
          clearRerolledTracks();
        }

        const wasResetPending = this.isResetSeedPending;
        const isResetSession = wasResetPending || Date.now() < this.resetSeedSessionUntil;

        // If GET + RESET SEED was clicked, immediately re-send the retrieved seed to the RND
        if (this.isResetSeedPending) {
          this.isResetSeedPending = false;
          if (this.resetSeedTimer !== null) {
            clearTimeout(this.resetSeedTimer);
            this.resetSeedTimer = null;
          }
          const seedToResend = parsed.seed;
          setTimeout(async () => {
            const reSendMsg = buildSeedSysEx(seedToResend);
            await this.rawSend(reSendMsg);
          }, 80);
        }

        const currentPatches = get(patchesStore);
        const cleanIncomingHex = parsed.rawHex.replace(/[\s,]/g, '').toUpperCase();

        // Calculate procedural levels from seed using MT19937 PRNG simulation
        const procedural = calculateProceduralLevels(parsed.seed);
        applyProceduralPatchLevels(procedural);

        // Check if exactly the same seed SysEx already exists in the librarian
        const existing = currentPatches.find(
          (p) =>
            p.sysexHex.replace(/[\s,]/g, '').toUpperCase() === cleanIncomingHex ||
            p.seed === parsed.seed
        );

        if (existing) {
          // Exactly the same seed sysex received: select it where it already is, do NOT duplicate it!
          selectedPatchId.set(existing.id);

          if (isResetSession) {
            // User requested GET + RESET SEED: reset all BLUE controls to their randomised procedural state!
            // CRUCIAL: Do NOT call applyAlteredControls(existing.altered)!
            this.resetPatchRecordToRandomizedBaseline(existing, parsed.seed, procedural);
          } else {
            setPatchBaseline(existing);
            const g = existing.globalSettings || { bpm: 120, root: 0, octave: 4, scale: 0, type: 0 };
            activeGlobalSettings.set({ octave: 4, ...g });
            const trks = existing.tracks && existing.tracks.length > 0 ? existing.tracks : [
              { track: 0, active: true, role: 0, mode: 0, engine: 'FM', muted: false, soloed: false },
              { track: 1, active: true, role: 1, mode: 0, engine: 'Acid (303)', muted: false, soloed: false },
              { track: 2, active: true, role: 2, mode: 1, engine: 'Harmonic', muted: false, soloed: false },
              { track: 3, active: true, role: 3, mode: 0, engine: 'Noise', muted: false, soloed: false },
            ];
            activeTracks.set(normalizeTracks(trks));
            if (existing.altered) {
              applyAlteredControls(existing.altered);
            }
          }
          break;
        }

        // New unique seed: append as a new row to the librarian, default name, auto-select
        const currentGlobals = get(activeGlobalSettings);
        const initialTracks = normalizeTracks([]); // All 4 tracks start inactive until 0x22 lines arrive

        const newPatch: PatchRecord = {
          id: crypto.randomUUID(),
          name: formatDefaultPatchName(),
          sysexHex: parsed.rawHex,
          seed: parsed.seed,
          createdAt: Date.now(),
          sortOrder: topSortOrders(get(patchesStore))[0],
          isSaved: false,
          globalSettings: { ...currentGlobals },
          tracks: initialTracks,
          proceduralLevels: procedural,
        };

        patchesStore.update((list) => [newPatch, ...list]);
        selectedPatchId.set(newPatch.id);
        activeTracks.set(initialTracks);
        activePatchBaseline.set(null);
        if (isResetSession) {
          this.resetPatchRecordToRandomizedBaseline(newPatch, parsed.seed, procedural);
        }
        break;
      }

      case 'global': {
        // 0x21: Global patch settings
        const activeId = get(selectedPatchId);
        const currentPatches = get(patchesStore);
        const activePatch = activeId ? currentPatches.find((p) => p.id === activeId) : null;
        const alt = activePatch?.altered;

        const isResetSession = this.isResetSeedPending || Date.now() < this.resetSeedSessionUntil;

        // Hardware factory baseline for this seed:
        const generatedBaseline: GlobalSettings = {
          type: parsed.settings.type,
          bpm: parsed.settings.bpm,
          root: parsed.settings.root,
          octave: 4,
          scale: parsed.settings.scale,
        };

        // Determine baseline: preserve existing originalGlobalSettings if present, otherwise set from hardware
        const baseSettings: GlobalSettings = isResetSession
          ? generatedBaseline
          : (activePatch?.originalGlobalSettings || generatedBaseline);

        const isLoading = get(isPatchLoadingStore);

        // Update activePatchBaseline so comparison with activeGlobalSettings correctly identifies edits
        activePatchBaseline.update((curr) => {
          if (!curr || curr.patchId !== activeId) {
            return {
              patchId: activeId,
              bpm: baseSettings.bpm,
              root: baseSettings.root,
              octave: baseSettings.octave ?? 4,
              scale: baseSettings.scale,
              enginePerTrack: ['', '', '', ''],
            };
          }
          // If we are actively loading a patch or already have altered controls for this patch,
          // do NOT let override confirmation telemetry from the synth overwrite a TRUSTED baseline.
          // A provisional baseline (guessed from stored data before any hardware dump) is always
          // replaced here by the real seed defaults, so default controls never show as edited.
          if (!isResetSession && !curr.provisional && (isLoading || activePatch?.altered)) {
            return curr;
          }
          return {
            ...curr,
            bpm: baseSettings.bpm,
            root: baseSettings.root,
            octave: baseSettings.octave ?? 4,
            scale: baseSettings.scale,
            provisional: false,
          };
        });

        // Determine active settings: in a reset session, use pure generated telemetry!
        // While reloading a library patch, any control the user did NOT edit must show the trusted
        // seed default (baseSettings) rather than raw hardware telemetry, which may be latched to a
        // previous patch's key/scale and would otherwise be flagged as an edit.
        const unedited: GlobalSettings = isLoading ? baseSettings : parsed.settings;
        const newActiveGlobals: GlobalSettings = isResetSession ? {
          type: parsed.settings.type,
          bpm: parsed.settings.bpm,
          root: parsed.settings.root,
          octave: 4,
          scale: parsed.settings.scale,
        } : {
          type: parsed.settings.type,
          bpm: alt?.bpm !== undefined ? alt.bpm : unedited.bpm,
          root: alt?.root !== undefined ? alt.root : unedited.root,
          octave: alt?.octave !== undefined ? alt.octave : (activePatch?.globalSettings?.octave ?? 4),
          scale: alt?.scale !== undefined ? alt.scale : unedited.scale,
        };

        activeGlobalSettings.set(newActiveGlobals);

        if (activeId) {
          patchesStore.update((list) =>
            list.map((p) => {
              if (p.id !== activeId) return p;
              return {
                ...p,
                altered: isResetSession ? undefined : p.altered,
                isSaved: isResetSession ? false : p.isSaved,
                originalGlobalSettings: isResetSession ? baseSettings : (p.originalGlobalSettings || baseSettings),
                globalSettings: newActiveGlobals,
              };
            })
          );
        }
        break;
      }

      case 'track': {
        // 0x22: Track configuration for an active track
        const tConfig = parsed.trackConfig;
        const activeId = get(selectedPatchId);
        const isResetSession = this.isResetSeedPending || Date.now() < this.resetSeedSessionUntil;
        const isLoadingTrack = get(isPatchLoadingStore) || this.currentLoadingPatchId !== null;
        const isRerolled = getRerollCount(get(rerolledTracksStore)[tConfig.track]) > 0;
        // A reloaded patch's seed dump reports the seed's own engines, so it corrects any stale
        // stored baseline. Only a saved engine alteration or a reroll keeps the stored engine.
        const isSeedDump = activeId !== null && this.seedDumpPatchId === activeId;
        const hasAlteredEngine =
          get(patchesStore).find((p) => p.id === activeId)?.altered?.engines?.[tConfig.track] !== undefined;
        const keepStoredEngine = (stored: string | undefined) => {
          if (!isLoadingTrack || !stored || stored === '—' || stored === '') return false;
          if (isSeedDump) return isRerolled || hasAlteredEngine;
          return isRerolled || stored !== tConfig.engine;
        };

        activeTracks.update((list) => {
          const updated = normalizeTracks(list);
          const existing = updated[tConfig.track];
          const originalEngine =
            isResetSession || isSeedDump || !existing?.originalEngine || existing.originalEngine === '—'
              ? tConfig.engine
              : existing.originalEngine;
          const engine = keepStoredEngine(existing?.engine) ? existing.engine : tConfig.engine;
          updated[tConfig.track] = {
            ...existing,
            ...tConfig,
            engine,
            originalEngine,
            active: true,
          };
          return updated;
        });

        if (activeId) {
          patchesStore.update((list) =>
            list.map((p) => {
              if (p.id !== activeId) return p;
              const tracks = normalizeTracks(p.tracks);
              const origTracks = p.originalTracks ? [...p.originalTracks] : normalizeTracks([]);
              if (
                isResetSession ||
                isSeedDump ||
                !origTracks[tConfig.track] ||
                origTracks[tConfig.track].engine === '—' ||
                !origTracks[tConfig.track].active
              ) {
                origTracks[tConfig.track] = {
                  ...tracks[tConfig.track],
                  ...tConfig,
                  originalEngine: tConfig.engine,
                  active: true,
                };
              }
              const trackOrigEngine =
                origTracks[tConfig.track]?.originalEngine ||
                origTracks[tConfig.track]?.engine ||
                tConfig.engine;

              const curTrk = tracks[tConfig.track];
              const engine = keepStoredEngine(curTrk?.engine) ? curTrk.engine : tConfig.engine;

              tracks[tConfig.track] = {
                ...tracks[tConfig.track],
                ...tConfig,
                engine,
                originalEngine: trackOrigEngine,
                active: true,
              };
              return { ...p, tracks, originalTracks: origTracks };
            })
          );
        }

        // If a reset seed session is active (brand new seed generated or reset seed requested),
        // populate the baseline with the true seed engines from the hardware.
        // A reloaded patch's seed dump also sets them (it is the seed's own engine, before overrides).
        // Otherwise, DO NOT overwrite baseline engines on standard patch loading or button clicks!
        if (isResetSession || isSeedDump || !isEngineName(get(activePatchBaseline)?.enginePerTrack?.[tConfig.track])) {
          activePatchBaseline.update((curr) => {
            if (!curr || curr.patchId !== activeId) return curr;
            const engines = [...curr.enginePerTrack];
            engines[tConfig.track] = tConfig.engine;
            return { ...curr, enginePerTrack: engines };
          });
        }

        // Trigger dirty/altered check now that activeTracks has updated with confirmed hardware telemetry,
        // but suppress during patch loading so saved status is not clobbered.
        if (!isLoadingTrack) {
          markActivePatchDirty();
        }
        break;
      }

      case 'storageCheck': {
        // 0x24 (JGpatch-019): RND STORAGE CHECK readout
        storageCheckStore.set(parsed.check);
        break;
      }

      case 'rerollSeed': {
        // 0x23 (JGpatch-014): seed of a reroll the RND just performed (0x12) or replayed (0x1A).
        setTrackRerollSeed(parsed.track, parsed.seed);
        const isLoadingReroll = get(isPatchLoadingStore) || this.currentLoadingPatchId !== null;
        if (!isLoadingReroll) {
          markActivePatchDirty();
        }
        break;
      }

      case 'version': {
        this.stockProbeUntil = 0;
        const info: ConnectedFirmwareInfo = {
          detected: true,
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch,
          versionString: parsed.versionString,
          isUpToDate: parsed.patch === LATEST_FIRMWARE_PATCH,
          needsUpdate: parsed.patch !== LATEST_FIRMWARE_PATCH,
        };
        connectedFirmware.set(info);

        // Any JGpatch build other than the hosted one (older or newer): open the JG-RND Patcher once to prompt an update
        if (info.needsUpdate && !this.hasPromptedFirmwareUpdate) {
          this.hasPromptedFirmwareUpdate = true;
          isFirmwareModalOpen.set(true);
        }
        break;
      }

      default:
        break;
    }
  }

  // ================= OUTGOING COMMANDS =================

  /**
   * Hardware Trigger Button:
   * 1. Sends Seed Generation SysEx (0x10 empty: F0 6F 62 78 10 F7) to trigger TRNG patch generation on the RND.
   * 2. Small 30ms delay for synth engine initialization.
   * 3. Sends Trigger / Dump SysEx (0x18: F0 6F 62 78 18 F7) to request the synth to dump the new patch over MIDI.
   */
  public async triggerHardware(): Promise<void> {
    // Always re-assert TYPES TO GENERATE (CC 14) before triggering seed generation
    const mask = get(typesToGenerateMask);
    await this.setTypesToGenerate(mask);

    const genMsg = buildGenerateSeedSysEx();
    await this.rawSend(genMsg);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const dumpMsg = buildTriggerSysEx();
    await this.rawSend(dumpMsg);
  }

  /**
   * Resets all BLUE / modified controls to their pristine randomized seed state.
   * Restores:
   *  - Procedural mixer & DSP reverb levels (calculated from seed)
   *  - Master Volume to 100
   *  - Master Reverb to 64
   * Resets active patch controls back to their pristine randomised seed states without saving the patch.
   * This allows the user to audition the randomised seed state, while preserving the saved patch
   * and its altered control settings in the library so that the user can re-click it to restore them.
   */
  public resetPatchRecordToRandomizedBaseline(
    patch?: PatchRecord,
    seed?: number,
    proceduralLevels?: import('./procedural').ProceduralPatchLevels
  ): void {
    const targetPatch = patch || get(patchesStore).find((p) => p.id === get(selectedPatchId));
    const targetSeed = seed ?? targetPatch?.seed ?? get(activePatchBaseline)?.seed ?? 0;
    const procedural = proceduralLevels || calculateProceduralLevels(targetSeed);

    // 1. Reset procedural levels (CH 1-4 Volumes to 100, CH 1-4 Reverbs to seed values, 6 DSP Reverb knobs to seed values)
    applyProceduralPatchLevels(procedural);
    masterVolumeStore.set(100);
    reverbDecayKnobStore.set(procedural.decayCC);

    // 2. Clear reroll glows
    clearRerolledTracks();

    // 3. Reset Global Settings in the editor to randomized original values
    const base = get(activePatchBaseline);
    const origG = targetPatch?.originalGlobalSettings || {
      type: targetPatch?.globalSettings?.type ?? 0,
      bpm: base?.bpm ?? targetPatch?.globalSettings?.bpm ?? 120,
      root: base?.root ?? targetPatch?.globalSettings?.root ?? 0,
      octave: base?.octave ?? targetPatch?.globalSettings?.octave ?? 4,
      scale: base?.scale ?? targetPatch?.globalSettings?.scale ?? 0,
    };

    const cleanG: GlobalSettings = {
      type: origG.type ?? 0,
      bpm: origG.bpm ?? 120,
      root: origG.root ?? 0,
      octave: origG.octave ?? 4,
      scale: origG.scale ?? 0,
    };
    activeGlobalSettings.set(cleanG);

    // 4. Reset Track Configurations in the editor (original engines, unmuted, unsoloed)
    const rawOrigTracks = targetPatch?.originalTracks && targetPatch.originalTracks.length > 0
      ? targetPatch.originalTracks
      : (targetPatch?.tracks && targetPatch.tracks.length > 0 ? targetPatch.tracks : get(activeTracks));
    const cleanTracks = normalizeTracks(rawOrigTracks).map((t, idx) => {
      const origEngine = targetPatch?.originalTracks?.[idx]?.originalEngine
        || targetPatch?.originalTracks?.[idx]?.engine
        || base?.enginePerTrack?.[idx]
        || t.originalEngine
        || t.engine;
      return {
        ...t,
        engine: origEngine && origEngine !== '—' && origEngine !== '' ? origEngine : t.engine,
        originalEngine: origEngine && origEngine !== '—' && origEngine !== '' ? origEngine : t.engine,
        muted: false,
        soloed: false,
      };
    });
    activeTracks.set(cleanTracks);

    // 5. Update activePatchBaseline so that all controls on screen return to non-blue state
    activePatchBaseline.set({
      patchId: targetPatch?.id ?? null,
      seed: targetSeed,
      bpm: cleanG.bpm,
      root: cleanG.root,
      octave: cleanG.octave ?? 4,
      scale: cleanG.scale,
      enginePerTrack: cleanTracks.map((t) => t.engine),
    });

    // 6. Mark active patch in patchesStore as unsaved (isSaved: false) and clear altered controls
    // so that the save button enters the red flashing mode.
    // When the user clicks the SAVE button in the library row, the patch is cleanly persisted in its reset state!
    if (targetPatch) {
      patchesStore.update((list) =>
        list.map((p) => {
          if (p.id !== targetPatch.id) return p;
          return {
            ...p,
            altered: undefined,
            isSaved: false,
            globalSettings: { ...cleanG },
            tracks: cleanTracks.map((t) => ({ ...t })),
          };
        })
      );
    }
  }

  /**
   * Queries the synth hardware for its currently active seed and patch state without generating a new seed.
   * Sends Trigger / Dump SysEx (0x18: F0 6F 62 78 18 F7).
   * When the active seed is received from the RND, it is immediately re-sent back to reset the hardware patch,
   * and all BLUE controls in the web editor are reset to their randomised state.
   */
  public async getAndResetSeed(): Promise<void> {
    clearRerolledTracks();
    if (this.resetSeedTimer !== null) {
      clearTimeout(this.resetSeedTimer);
      this.resetSeedTimer = null;
    }

    if (!this.currentOutputPort) {
      // Disconnected / offline mode: immediately reset active patch to procedural baseline
      this.cancelResetSession();
      const currentActiveId = get(selectedPatchId);
      const currentActive = get(patchesStore).find((p) => p.id === currentActiveId);
      this.resetPatchRecordToRandomizedBaseline(currentActive);
      return;
    }

    this.isResetSeedPending = true;
    this.resetSeedSessionUntil = Date.now() + 2500;
    this.resetSeedTimer = window.setTimeout(() => {
      if (this.isResetSeedPending || Date.now() < this.resetSeedSessionUntil) {
        this.isResetSeedPending = false;
        this.resetSeedSessionUntil = 0;
        this.resetSeedTimer = null;
        // Offline / hardware timeout fallback:
        const currentActiveId = get(selectedPatchId);
        const currentActive = get(patchesStore).find((p) => p.id === currentActiveId);
        this.resetPatchRecordToRandomizedBaseline(currentActive);
      }
    }, 3000);

    const dumpMsg = buildTriggerSysEx();
    await this.rawSend(dumpMsg);
  }

  /**
   * Re-randomize Track (0x12) - Sent immediately on click.
   */
  public async rerollTrack(trackIndex: number): Promise<void> {
    const track = get(activeTracks)[trackIndex];
    if (!track?.active) return;
    const msg = buildRerollTrackSysEx(trackIndex);
    await this.rawSend(msg);
  }

  /**
   * Retrieves the full list of selectable engines for a track:
   * Combines role- and mode-compatible engines with the track's authentic original engine
   * and current engine, ensuring the original generated engine is never lost or excluded.
   */
  public getTrackSelectableEngines(trackIndex: number): string[] {
    const track = get(activeTracks)[trackIndex];
    if (!track) return [...SYNTH_ENGINES];

    const activeId = get(selectedPatchId);
    const curPatch = activeId ? get(patchesStore).find((p) => p.id === activeId) : undefined;
    const originalEngine = pickOriginalEngine(
      track.originalEngine,
      get(activePatchBaseline)?.enginePerTrack?.[trackIndex],
      curPatch?.originalTracks?.[trackIndex]?.originalEngine,
      curPatch?.originalTracks?.[trackIndex]?.engine,
    );
    const result = getSelectableEngines(track.role, track.mode, originalEngine, track.engine);
    return result.length > 0 ? result : [...SYNTH_ENGINES];
  }

  /**
   * Previous Synth Engine (◀ ENGINE button):
   * Cycles backward through the track's selectable engines using Direct Engine Select (SysEx 0x19).
   * Decoupled from procedural re-randomization and unified with dropdown selection.
   */
  public async prevEngineTrack(trackIndex: number): Promise<void> {
    const track = get(activeTracks)[trackIndex];
    if (!track?.active) return;

    const compatible = this.getTrackSelectableEngines(trackIndex);
    const curPos = compatible.indexOf(track.engine);
    const prevPos = curPos >= 0 ? (curPos - 1 + compatible.length) % compatible.length : 0;
    const prevEngine = compatible[prevPos] ?? track.engine;
    const prevHwIdx = resolveEngineIndex(prevEngine);

    await this.setTrackEngine(trackIndex, prevHwIdx, prevEngine);
  }

  /**
   * Next Synth Engine (ENGINE ▶ button):
   * Cycles forward through the track's selectable engines using Direct Engine Select (SysEx 0x19).
   * Decoupled from procedural re-randomization and unified with dropdown selection.
   */
  public async nextEngineTrack(trackIndex: number): Promise<void> {
    const track = get(activeTracks)[trackIndex];
    if (!track?.active) return;

    const compatible = this.getTrackSelectableEngines(trackIndex);
    const curPos = compatible.indexOf(track.engine);
    const nextPos = curPos >= 0 ? (curPos + 1) % compatible.length : 0;
    const nextEngine = compatible[nextPos] ?? track.engine;
    const nextHwIdx = resolveEngineIndex(nextEngine);

    await this.setTrackEngine(trackIndex, nextHwIdx, nextEngine);
  }

  /**
   * Track Engine Select from Dropdown:
   * Sets the track engine directly using SysEx 0x19 (Direct Engine Select).
   * Fully decoupled from procedural re-randomization in firmware (JGpatch-013),
   * ensuring voice timbre and sound parameters are NEVER re-rolled, while
   * avoiding intermediate circular stepping and audible audio scrolls.
   */
  public async setTrackEngine(trackIndex: number, targetIdx: number, targetName?: string): Promise<void> {
    const track = get(activeTracks)[trackIndex];
    if (!track?.active) return;

    const resolvedName = targetName ?? resolveEngineName(targetIdx);
    const resolvedHwIdx = resolveEngineIndex(resolvedName);
    const curIdx = resolveEngineIndex(track.engine);
    if (curIdx === resolvedHwIdx || resolvedHwIdx < 0) return;

    // Optimistically update the UI track engine, preserving originalEngine
    activeTracks.update((list) => {
      const copy = [...list];
      if (copy[trackIndex]) {
        copy[trackIndex] = {
          ...copy[trackIndex],
          engine: resolvedName,
          originalEngine: copy[trackIndex].originalEngine || track.engine,
        };
      }
      return copy;
    });

    const msg = buildDirectEngineSysEx(trackIndex, resolvedHwIdx);
    await this.rawSend(msg);

    markActivePatchDirty();
  }

  /**
   * Mute / Unmute Track (0x16) - Sent immediately on click.
   */
  public async muteTrack(trackIndex: number, muted: boolean): Promise<void> {
    const track = get(activeTracks)[trackIndex];
    if (!track?.active) return;

    activeTracks.update((list) => {
      const updated = [...list];
      if (updated[trackIndex]) {
        updated[trackIndex] = { ...updated[trackIndex], muted };
      }
      return updated;
    });

    const msg = buildMuteTrackSysEx(trackIndex, muted);
    // A patch load clears the queue (rejecting pending sends); that is expected, not an error
    await this.queue.enqueue(msg, `Mute Track ${trackIndex} = ${muted} (0x16)`).catch(() => {});
    markActivePatchDirty();
  }

  /**
   * Solo / Unsolo Track (0x17) - Sent immediately on click.
   */
  public async soloTrack(trackIndex: number, soloed: boolean): Promise<void> {
    const track = get(activeTracks)[trackIndex];
    if (!track?.active) return;

    activeTracks.update((list) => {
      const updated = [...list];
      if (updated[trackIndex]) {
        updated[trackIndex] = { ...updated[trackIndex], soloed };
      }
      return updated;
    });

    const msg = buildSoloTrackSysEx(trackIndex, soloed);
    await this.queue.enqueue(msg, `Solo Track ${trackIndex} = ${soloed} (0x17)`).catch(() => {});
    markActivePatchDirty();
  }

  /**
   * Transmit stored SysEx hex string from librarian row (e.g. 0x10 patch seed).
   */
  public async sendStoredSysEx(hexString: string): Promise<void> {
    const bytes = hexToBytes(hexString);
    await this.queue.enqueue(bytes, `Send Stored SysEx (${bytes.length} bytes)`);
  }

  // ================= MIDI CHANNEL 1 GLOBAL CONTROLS =================

  /**
   * Transmits standard 3-byte Channel Voice MIDI Message (CC, Note On/Off, etc.)
   */
  public async sendChannelMessage(status: number, data1: number, data2: number): Promise<void> {
    const bytes = new Uint8Array([status & 0xff, data1 & 0x7f, data2 & 0x7f]);
    await this.rawSend(bytes);
  }

  /**
   * Sends Control Change (CC) on a specified MIDI channel (1-16).
   */
  public async sendControlChange(channel: number, controller: number, value: number): Promise<void> {
    const ch = Math.max(0, Math.min(15, channel - 1));
    const status = 0xb0 | ch;
    await this.sendChannelMessage(status, controller, value);
  }

  /**
   * Momentarily plays a MIDI note on specified channel (1-16), held for durationMs.
   */
  public async sendMomentaryNote(
    channel: number,
    noteNumber: number,
    durationMs: number = 80,
    velocity: number = 100
  ): Promise<void> {
    const ch = Math.max(0, Math.min(15, channel - 1));
    const noteOn = 0x90 | ch;
    const noteOff = 0x80 | ch;

    await this.sendChannelMessage(noteOn, noteNumber, velocity);
    setTimeout(() => {
      this.sendChannelMessage(noteOff, noteNumber, 0);
    }, durationMs);
  }

  /**
   * Sends Scale Selection CC 9 on Channel 1 (corresponds to RND firmware 1.3 chart).
   */
  public async setMusicalScale(scaleIndex: number): Promise<void> {
    const ccVal = scaleIndexToCC9(scaleIndex);
    await this.sendControlChange(1, 9, ccVal);
    markActivePatchDirty();
  }

  /**
   * Momentarily sends tonic note on MIDI Channel 1 to change the RND synth's key root / transpose.
   * Combined with octave: (octave + 1) * 12 + rootIndex (e.g. F2 = 41, G3 = 55, C4 = 60).
   */
  public async setKeyRoot(rootIndex: number, octave: number = 4): Promise<void> {
    const noteNumber = Math.max(0, Math.min(127, (octave + 1) * 12 + (rootIndex % 12)));
    await this.sendMomentaryNote(1, noteNumber, 80, 100);
    markActivePatchDirty();
  }

  /**
   * Sets the tempo (BPM) by sending Global Settings SysEx (0x21) to the synthesizer.
   * Clamps BPM between 20 and 300 and updates activeGlobalSettings.
   */
  public async setBpm(bpm: number): Promise<void> {
    const currentGlobals = get(activeGlobalSettings);
    const clampedBpm = Math.max(20, Math.min(300, Math.round(bpm)));
    const updatedGlobals: GlobalSettings = {
      ...currentGlobals,
      bpm: clampedBpm,
    };
    activeGlobalSettings.set(updatedGlobals);
    const msg = buildGlobalSettingsSysEx(updatedGlobals);
    await this.rawSend(msg);
    markActivePatchDirty();
  }

  /**
   * Sends Master Volume CC 7 on Channel 1 (0-127).
   */
  public async setMasterVolume(value: number): Promise<void> {
    const val = Math.max(0, Math.min(127, Math.round(value)));
    masterVolumeStore.set(val);
    await this.sendControlChange(1, 7, val);
    markActivePatchDirty();
  }

  /**
   * MASTER REV MULT: CC 91 on Channel 1 (0-127, 64 = unity), scales every track's reverb send.
   */
  public async setMasterReverbMult(value: number): Promise<void> {
    const val = Math.max(0, Math.min(127, Math.round(value)));
    masterReverbMultStore.set(val);
    await this.sendControlChange(1, 91, val);
    markActivePatchDirty();
  }

  /**
   * Sends Channel Volume CC 7 on Channel 2-5 for CH 1-4 (0-127).
   */
  public async setChannelVolume(channelIndex: number, value: number): Promise<void> {
    const val = Math.max(0, Math.min(127, Math.round(value)));
    const midiChannel = channelIndex + 2; // CH 1 -> Ch 2, CH 2 -> Ch 3, CH 3 -> Ch 4, CH 4 -> Ch 5
    trackVolumesStore.update((vols) => {
      const next = [...vols];
      next[channelIndex] = val;
      return next;
    });
    await this.sendControlChange(midiChannel, 7, val);
    markActivePatchDirty();
  }

  /**
   * Sends Channel Reverb CC 91 on Channel 2-5 for CH 1-4 (0-127).
   */
  public async setChannelReverb(channelIndex: number, value: number): Promise<void> {
    const val = Math.max(0, Math.min(127, Math.round(value)));
    const midiChannel = channelIndex + 2; // CH 1 -> Ch 2, CH 2 -> Ch 3, CH 3 -> Ch 4, CH 4 -> Ch 5
    trackReverbsStore.update((revs) => {
      const next = [...revs];
      next[channelIndex] = val;
      return next;
    });
    await this.sendControlChange(midiChannel, 91, val);
    markActivePatchDirty();
  }

  /**
   * Sends one of the 6 REVERB CONTROLS (CC 85-90 on Channel 1, 0-127):
   * CC 85 PRE-DELAY, CC 86 TONE, CC 87 DIFFUSION 1, CC 88 DIFFUSION 2, CC 89 ROOM SIZE, CC 90 DECAY
   */
  public async setDspReverbParam(
    cc: number,
    value: number,
    options?: { skipDirty?: boolean; fromRamp?: boolean }
  ): Promise<void> {
    const val = Math.max(0, Math.min(127, Math.round(value)));
    // Any direct DECAY change cancels an in-progress release ramp
    if (cc === 90 && !options?.fromRamp) this.decayRampToken++;
    if (cc === 85) reverbPredelayStore.set(val);
    else if (cc === 86) reverbToneStore.set(val);
    else if (cc === 87) reverbDiffusion1Store.set(val);
    else if (cc === 88) reverbDiffusion2Store.set(val);
    else if (cc === 89) reverbRoomSizeStore.set(val);
    else if (cc === 90) reverbDecayStore.set(val);
    await this.sendControlChange(1, cc, val);
    if (!options?.skipDirty) {
      markActivePatchDirty();
    }
  }

  private decayRampToken = 0;

  /**
   * Glides DECAY (CC 90) from its current value to `to` instead of jumping, so releasing INF or
   * switching LATCH off does not cause an abrupt step in the reverb loop (audible pop).
   */
  public async rampReverbDecay(to: number, options?: { skipDirty?: boolean; durationMs?: number }): Promise<void> {
    const token = ++this.decayRampToken;
    const from = get(reverbDecayStore);
    const target = Math.max(0, Math.min(127, Math.round(to)));
    const durationMs = options?.durationMs ?? 250;
    const stepMs = 10;
    const steps = Math.max(1, Math.round(durationMs / stepMs));
    let lastSent = from;
    for (let i = 1; i <= steps; i++) {
      if (token !== this.decayRampToken) return;
      const v = Math.round(from + ((target - from) * i) / steps);
      if (v !== lastSent) {
        lastSent = v;
        await this.setDspReverbParam(90, v, { skipDirty: true, fromRamp: true });
      }
      if (i < steps) await new Promise((res) => setTimeout(res, stepMs));
    }
    if (token === this.decayRampToken && !options?.skipDirty) {
      markActivePatchDirty();
    }
  }

  /**
   * Sends TYPES TO GENERATE to the RND (CC 14 on Channel 1).
   * Mask bits: 1 = Looping, 2 = Drone, 4 = Jingle (1 to 7, default 7 = all).
   */
  public async setTypesToGenerate(mask: number): Promise<void> {
    const val = Math.max(1, Math.min(7, Math.round(mask) || 7));
    await this.sendControlChange(1, 14, val);
  }

}

export const midiManager = new MidiManager();
