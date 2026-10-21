<script lang="ts">
  import {
    activeTracks,
    selectedPatch,
    activePatchBaseline,
    rerolledTracksStore,
    markTrackRerolled,
    markActivePatchDirty,
    isSeedDumpPendingStore,
  } from "../stores";
  import { midiManager } from "../midi/midiManager";
  import {
    TRACK_ROLES,
    VOICE_MODES,
    getSelectableEngines,
    pickOriginalEngine,
    resolveEngineIndex,
    getRerollCount,
  } from "../types";
  import Icon from "./Icon.svelte";

  interface Props {
    trackIndex: number;
  }

  let { trackIndex }: Props = $props();

  const track = $derived(
    $activeTracks[trackIndex] ?? {
      track: trackIndex,
      active: true,
      role: trackIndex,
      mode: 0,
      engine: "FM",
      muted: false,
      soloed: false,
    },
  );

  const isRerolled = $derived(getRerollCount($rerolledTracksStore[trackIndex]) > 0);

  // Until a recalled patch's seed dump confirms its engines, only a saved engine change or a reroll
  // shows blue, so stale stored engines don't flash as edits.
  const isEngineChanged = $derived(
    ($isSeedDumpPendingStore
      ? isRerolled || $selectedPatch?.altered?.engines?.[trackIndex] !== undefined
      : true) &&
      $activePatchBaseline?.enginePerTrack?.[trackIndex] !== undefined &&
      track.active &&
      track.engine !== "—" &&
      $activePatchBaseline.enginePerTrack[trackIndex] !== "" &&
      $activePatchBaseline.enginePerTrack[trackIndex] !== "—" &&
      resolveEngineIndex(track.engine) !== resolveEngineIndex($activePatchBaseline.enginePerTrack[trackIndex]),
  );

  const originalEngine = $derived(
    pickOriginalEngine(
      track.originalEngine,
      $activePatchBaseline?.enginePerTrack?.[trackIndex],
      $selectedPatch?.originalTracks?.[trackIndex]?.originalEngine,
      $selectedPatch?.originalTracks?.[trackIndex]?.engine,
    ),
  );

  const compatibleEngines = $derived(
    getSelectableEngines(track.role, track.mode, originalEngine, track.engine),
  );

  // Live actions (transmitted immediately on click). Marking the patch dirty also copies the
  // live track state into the selected patch; midiManager does this for engine, mute and solo.
  async function handleReroll() {
    if (!track.active) return;
    markTrackRerolled(trackIndex);
    await midiManager.rerollTrack(trackIndex);
    markActivePatchDirty();
  }

  async function handlePrevEngine() {
    if (!track.active) return;
    await midiManager.prevEngineTrack(trackIndex);
  }

  async function handleNextEngine() {
    if (!track.active) return;
    await midiManager.nextEngineTrack(trackIndex);
  }

  async function handleSelectEngine(e: Event) {
    if (!track.active) return;
    const target = e.target as HTMLSelectElement;
    const engName = target.value;
    const engIdx = resolveEngineIndex(engName);
    if (engIdx >= 0) {
      await midiManager.setTrackEngine(trackIndex, engIdx, engName);
    }
  }

  async function handleToggleMute() {
    if (!track.active) return;
    await midiManager.muteTrack(trackIndex, !track.muted);
  }

  async function handleToggleSolo() {
    if (!track.active) return;
    await midiManager.soloTrack(trackIndex, !track.soloed);
  }
</script>

<div
  class="track-strip"
  class:inactive={!track.active}
  class:muted={track.muted}
  class:soloed={track.soloed}
  class:rerolled={isRerolled}
>
  <!-- Track Header / Channel Identification -->
  <div class="track-header">
    <div class="track-id-badge">
      <span class="track-num" class:inactive={!track.active}
        >CH {trackIndex + 1}</span
      >
      {#if isRerolled}
        <span class="ch-reroll-icon" title="Channel timbre rerolled">
          <Icon name="shuffle" size={12} />
        </span>
      {/if}
    </div>

    <!-- Live Track Buttons: Mute & Solo -->
    <div class="mute-solo-group">
      <button
        class="live-toggle-btn mute-btn"
        class:active={track.muted}
        class:inactive-btn={!track.active}
        disabled={!track.active}
        onclick={handleToggleMute}
        title={track.active
          ? "Live Mute / Unmute (SysEx 0x16) - Works instantly"
          : "Track inactive in current patch"}
      >
        <Icon name={track.muted ? "volume-mute" : "volume-high"} size={13} />
        <span>MUTE</span>
      </button>

      <button
        class="live-toggle-btn solo-btn"
        class:active={track.soloed}
        class:inactive-btn={!track.active}
        disabled={!track.active}
        onclick={handleToggleSolo}
        title={track.active
          ? "Live Solo / Unsolo (SysEx 0x17) - Works instantly"
          : "Track inactive in current patch"}
      >
        <Icon name="solo" size={13} />
        <span>SOLO</span>
      </button>
    </div>
  </div>

  <!-- Live Track Actions: REROLL, ◀ ENGINE, ENGINE ▶ -->
  <div class="live-action-row">
    <button
      class="live-action-btn reroll"
      class:inactive-btn={!track.active}
      disabled={!track.active}
      onclick={handleReroll}
      title={track.active
        ? "Re-randomize Timbre / Sound Params (SysEx 0x12) - Sent immediately"
        : "Track inactive in current patch"}
    >
      <Icon name="shuffle" size={12} />
      <span>REROLL</span>
    </button>

    <button
      class="live-action-btn engine-prev"
      class:inactive-btn={!track.active}
      disabled={!track.active}
      onclick={handlePrevEngine}
      title={track.active
        ? "Previous Synth Engine (Direct SysEx 0x19) - Sent immediately"
        : "Track inactive in current patch"}
    >
      <span>◀ ENGINE</span>
    </button>

    <button
      class="live-action-btn engine-next"
      class:inactive-btn={!track.active}
      disabled={!track.active}
      onclick={handleNextEngine}
      title={track.active
        ? "Next Synth Engine (Direct SysEx 0x19) - Sent immediately"
        : "Track inactive in current patch"}
    >
      <span>ENGINE ▶</span>
    </button>
  </div>

  <!-- Decoded Hardware Track Parameters (from 0x22 dump) -->
  <div class="armed-controls">
    <div class="armed-header">
      <span class="cmd-sub">0x22 DUMP</span>
    </div>

    <!-- Role Dropdown -->
    <div class="field-group">
      <label for="role-select-{trackIndex}">ROLE (R)</label>
      <select
        id="role-select-{trackIndex}"
        value={track.role}
        disabled
        class="track-select"
      >
        {#each TRACK_ROLES as roleName, idx}
          <option value={idx}>0{idx} - {roleName}</option>
        {/each}
      </select>
    </div>

    <!-- Voice Mode Dropdown -->
    <div class="field-group">
      <label for="mode-select-{trackIndex}">VOICE MODE (M)</label>
      <select
        id="mode-select-{trackIndex}"
        value={track.mode}
        disabled
        class="track-select"
      >
        {#each VOICE_MODES as modeName, idx}
          <option value={idx}>0{idx} - {modeName}</option>
        {/each}
      </select>
    </div>

    <!-- Engine Name Dropdown -->
    <div class="field-group">
      <label for="engine-select-{trackIndex}">SYNTH ENGINE</label>
      <select
        id="engine-select-{trackIndex}"
        value={track.engine}
        disabled={!track.active}
        onchange={handleSelectEngine}
        class="track-select engine-select"
        class:is-changed={isEngineChanged}
      >
        {#each compatibleEngines as eng}
          <option value={eng}>{eng}</option>
        {/each}
      </select>
    </div>
  </div>
</div>

<style>
  .track-strip {
    background: var(--bg-panel);
    border: 1px solid var(--border-box);
    border-radius: 6px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    position: relative;
    box-shadow: var(--box-shadow-panel);
    transition: all 0.15s ease;
  }

  .track-strip:hover {
    border-color: var(--border-hover);
  }

  .track-strip.inactive {
    opacity: 0.55;
    background: var(--bg-sub-box);
    border-color: var(--border-subtle);
  }

  .track-strip.inactive:hover {
    border-color: var(--border-subtle);
  }

  .track-strip.muted,
  .track-strip.soloed,
  .track-strip.rerolled {
    border-color: #38bdf8;
    box-shadow: 0 0 12px rgba(56, 189, 248, 0.25);
  }

  .track-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: 8px;
  }

  .track-id-badge {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .track-num {
    font-family: "Chakra Petch", monospace;
    font-weight: 800;
    font-size: 12px;
    color: #ffffffa1;
    letter-spacing: 0.8px;
    line-height: 1;
    transition: color 0.15s ease;
  }

  .track-num.inactive {
    color: #4b5563;
  }

  .ch-reroll-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #38bdf8;
    filter: drop-shadow(0 0 2px #38bdf8) drop-shadow(0 0 5.5px rgba(56, 189, 248, 0.85));
    animation: ch-reroll-pulse 2s infinite ease-in-out;
    line-height: 1;
  }

  @keyframes ch-reroll-pulse {
    0%,
    100% {
      filter: drop-shadow(0 0 2px #38bdf8) drop-shadow(0 0 5px rgba(56, 189, 248, 0.75));
      opacity: 0.9;
    }
    50% {
      filter: drop-shadow(0 0 3.5px #38bdf8) drop-shadow(0 0 8px rgba(56, 189, 248, 1));
      opacity: 1;
    }
  }

  .mute-solo-group {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .live-toggle-btn {
    background: var(--bg-surface);
    border: 1px solid var(--color-orange);
    color: var(--color-orange-text);
    padding: 4px 8px;
    border-radius: 3px;
    font-family: "Chakra Petch", monospace;
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: all 0.1s ease;
  }

  .live-toggle-btn:disabled,
  .live-toggle-btn.inactive-btn {
    opacity: 0.35;
    background: var(--bg-sub-box);
    border-color: #1a1e26;
    color: #4b5563;
    cursor: not-allowed;
    pointer-events: none;
    box-shadow: none;
  }

  .mute-btn:hover:not(:disabled):not(.active) {
    background: #ef4444;
    border-color: #ef4444;
    color: #0b0d10;
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.45);
  }

  .mute-btn.active {
    background: #dc2626;
    border-color: #ef4444;
    color: #ffffff;
    box-shadow: 0 0 8px rgba(220, 38, 38, 0.5);
  }

  .solo-btn:hover:not(:disabled):not(.active) {
    background: var(--color-orange);
    border-color: var(--color-orange);
    color: #0b0d10;
    box-shadow: 0 0 8px var(--color-orange-glow);
  }

  .solo-btn.active {
    background: linear-gradient(180deg, #38bdf8 0%, #0284c7 100%);
    border-color: #7dd3fc;
    color: #ffffff;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.55);
  }

  .live-action-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }

  .live-action-btn {
    background: var(--bg-surface);
    border: 1px solid var(--color-orange);
    color: var(--color-orange-text);
    padding: 6px 4px;
    border-radius: 3px;
    font-family: "Chakra Petch", monospace;
    font-size: 9.5px;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    white-space: nowrap;
    transition: all 0.12s ease;
  }

  .live-action-btn:hover:not(:disabled) {
    background: var(--color-orange);
    border-color: var(--color-orange);
    color: #0b0d10;
    box-shadow: 0 0 8px var(--color-orange-glow);
  }

  .live-action-btn:active:not(:disabled) {
    background: var(--color-orange-dark);
    transform: translateY(1px);
  }

  .live-action-btn:disabled,
  .live-action-btn.inactive-btn {
    opacity: 0.35;
    background: var(--bg-sub-box);
    border-color: var(--border-subtle);
    color: #4b5563;
    cursor: not-allowed;
    pointer-events: none;
    box-shadow: none;
    transform: none !important;
  }

  .armed-controls {
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .armed-header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-bottom: 2px;
  }

  .cmd-sub {
    font-family: "JetBrains Mono", monospace;
    font-size: 8.5px;
    color: #94a3b8;
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-group label {
    font-family: "Chakra Petch", monospace;
    font-size: 9.5px;
    font-weight: 700;
    color: #94a3b8;
    letter-spacing: 0.4px;
  }


  .track-select {
    width: 100%;
    background: var(--bg-surface);
    color: #e2e8f0;
    border: 1px solid var(--border-box);
    border-radius: 3px;
    padding: 5px 8px;
    font-family: "JetBrains Mono", monospace;
    font-size: 10.5px;
    outline: none;
    cursor: pointer;
  }

  .track-select:focus {
    border-color: var(--color-orange);
  }

  .track-select:disabled {
    cursor: default;
    pointer-events: none;
    opacity: 0.65;
    background: var(--bg-sub-box);
    border-color: var(--border-subtle);
    color: #cbd5e1;
    transition: all 0.15s ease;
  }

  .track-select.engine-select {
    color: var(--color-orange);
    font-weight: 700;
  }

  .track-select.engine-select:disabled {
    color: var(--color-orange);
    font-weight: 700;
    opacity: 0.95;
  }

  .track-select.engine-select.is-changed,
  .track-select:disabled.is-changed {
    outline: 1px solid #38bdf8 !important;
    border-color: #38bdf8 !important;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.45) !important;
    color: #38bdf8 !important;
    background: #111827 !important;
    opacity: 0.95 !important;
  }
</style>
