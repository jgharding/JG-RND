<script lang="ts">
  import { get } from "svelte/store";
  import {
    activeGlobalSettings,
    selectedPatch,
    typesToGenerateStore,
    typesToGenerateMask,
    activePatchBaseline,
  } from "../stores";
  import { ROOT_NOTES, SCALES, PATCH_TYPES } from "../types";
  import { midiManager } from "../midi/midiManager";

  const TYPE_LABELS = ["LOOPING", "DRONE", "JINGLE"] as const;

  const isBpmChanged = $derived(
    $activePatchBaseline?.bpm !== undefined &&
      $activeGlobalSettings.bpm !== $activePatchBaseline.bpm,
  );

  const isRootChanged = $derived(
    $activePatchBaseline?.root !== undefined &&
      $activeGlobalSettings.root !== $activePatchBaseline.root,
  );

  const isOctaveChanged = $derived(
    $activePatchBaseline?.octave !== undefined &&
      ($activeGlobalSettings.octave ?? 4) !== $activePatchBaseline.octave,
  );

  const isScaleChanged = $derived(
    $activePatchBaseline?.scale !== undefined &&
      $activeGlobalSettings.scale !== $activePatchBaseline.scale,
  );

  function handleToggleType(idx: number) {
    typesToGenerateStore.toggle(idx);
    const newMask = get(typesToGenerateMask);
    midiManager.setTypesToGenerate(newMask);
  }

  function handleRootChange(e: Event) {
    // Only send MIDI note if the user directly and interactively changed the dropdown
    if (!e.isTrusted) return;

    const target = e.target as HTMLSelectElement;
    const val = Number(target.value);
    target.blur();

    if (val === $activeGlobalSettings.root) return;

    const currentOctave = $activeGlobalSettings.octave ?? 4;
    activeGlobalSettings.update((s) => ({ ...s, root: val }));
    // Momentarily send note over MIDI channel 1 to instruct RND to change tonic root note & octave
    midiManager.setKeyRoot(val, currentOctave);
  }

  function handleOctaveChange(e: Event) {
    // Only send MIDI note if the user directly and interactively changed the dropdown
    if (!e.isTrusted) return;

    const target = e.target as HTMLSelectElement;
    const oct = Number(target.value);
    target.blur();

    if (oct === ($activeGlobalSettings.octave ?? 4)) return;

    activeGlobalSettings.update((s) => ({ ...s, octave: oct }));
    // Momentarily send note over MIDI channel 1 to instruct RND to change tonic root note & octave
    midiManager.setKeyRoot($activeGlobalSettings.root, oct);
  }

  function handleScaleChange(e: Event) {
    // Only send CC 9 if the user directly and interactively changed the dropdown
    if (!e.isTrusted) return;

    const target = e.target as HTMLSelectElement;
    const val = Number(target.value);
    target.blur();

    if (val === $activeGlobalSettings.scale) return;

    activeGlobalSettings.update((s) => ({ ...s, scale: val }));
    // Send scale selection over MIDI CC 9 on Channel 1
    midiManager.setMusicalScale(val);
  }

  let bpmThrottleTimer: number | null = null;
  let pendingBpm: number | null = null;

  function handleBpmInput(e: Event) {
    if (!e.isTrusted) return;
    const target = e.target as HTMLInputElement;
    const val = Number(target.value);
    if (val === $activeGlobalSettings.bpm) return;

    activeGlobalSettings.update((s) => ({ ...s, bpm: val }));

    pendingBpm = val;
    if (bpmThrottleTimer === null) {
      midiManager.setBpm(val);
      bpmThrottleTimer = window.setTimeout(() => {
        if (pendingBpm !== null && pendingBpm !== val) {
          midiManager.setBpm(pendingBpm);
        }
        bpmThrottleTimer = null;
        pendingBpm = null;
      }, 35);
    }
  }

  function handleBpmChange(e: Event) {
    if (!e.isTrusted) return;
    const target = e.target as HTMLInputElement;
    const val = Number(target.value);
    activeGlobalSettings.update((s) => ({ ...s, bpm: val }));
    midiManager.setBpm(val);
  }

  function handleBpmReset() {
    const targetBpm =
      $activePatchBaseline?.bpm ??
      $selectedPatch?.originalGlobalSettings?.bpm ??
      $selectedPatch?.globalSettings?.bpm ??
      120;

    if (bpmThrottleTimer !== null) {
      clearTimeout(bpmThrottleTimer);
      bpmThrottleTimer = null;
    }
    pendingBpm = null;

    if ($activeGlobalSettings.bpm === targetBpm) return;

    activeGlobalSettings.update((s) => ({ ...s, bpm: targetBpm }));
    midiManager.setBpm(targetBpm);
  }

</script>

<div class="global-editor-section">
  <div class="panel-header">
    <div class="header-left">
      <h3 class="panel-title">GLOBAL PATCH PARAMETERS</h3>
      <span class="cmd-tag">SYSEX 0x21 DUMP</span>
    </div>
    <div class="header-right">
      <span class="staged-badge"></span>
    </div>
  </div>

  <div class="global-editor-panel">
    <div class="controls-grid">
      <!-- TYPES TO GENERATE -->
      <div class="control-box type-box">
        <div class="control-label">
          <div class="label-title-row">
            <span>TYPES TO GENERATE</span>
            <span class="cc-tag">CC 14 GEN FILTER</span>
          </div>
          <span class="value-badge"
            >{TYPE_LABELS[$activeGlobalSettings.type] ??
              `TYPE #${$activeGlobalSettings.type}`}</span
          >
        </div>
        <div class="type-button-group">
          {#each PATCH_TYPES as typeName, idx}
            {@const isEnabled = $typesToGenerateStore[idx]}
            {@const isCurrent = $activeGlobalSettings.type === idx}
            <button
              type="button"
              class="type-btn"
              class:state-off={!isEnabled}
              class:state-enabled={isEnabled && !isCurrent}
              class:state-current={isEnabled && isCurrent}
              onclick={() => handleToggleType(idx)}
              title={isEnabled
                ? `Click to disable ${typeName} in generation filter`
                : `Click to enable ${typeName} in generation filter`}
            >
              <!-- Checkbox Indicator -->
              <span class="type-checkbox" class:checked={isEnabled}>
                {#if isEnabled}
                  <svg viewBox="0 0 12 12" class="check-icon">
                    <path
                      d="M2.5 6.5L4.8 8.8L9.5 3.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                {/if}
              </span>
              <span class="type-num">0{idx}</span>
              <span class="type-name">{typeName}</span>
              {#if isCurrent}
                <span class="active-badge">CURRENT PATCH</span>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      <!-- Tempo / BPM -->
      <div class="control-box bpm-box">
        <label class="control-label" for="bpm-slider">
          <div class="label-title-row">
            <span>TEMPO / BPM</span>
            <span class="cc-tag">SYSEX 0x21</span>
          </div>
          <button
            type="button"
            class="value-badge bpm-val"
            class:is-changed={isBpmChanged}
            ondblclick={handleBpmReset}
            title="Double-click to reset to patch BPM"
          >
            {$activeGlobalSettings.bpm} BPM
          </button>
        </label>
        <div class="slider-wrapper">
          <input
            id="bpm-slider"
            type="range"
            min="50"
            max="200"
            step="1"
            value={$activeGlobalSettings.bpm}
            oninput={handleBpmInput}
            onchange={handleBpmChange}
            ondblclick={handleBpmReset}
            class="industrial-slider"
            class:is-changed={isBpmChanged}
            title="Double-click to reset to patch BPM"
          />
          <div class="slider-ticks">
            <span>50</span>
            <span>100</span>
            <span>120</span>
            <span>150</span>
            <span>200</span>
          </div>
        </div>
      </div>

      <!-- Root Note & Octave -->
      <div class="control-box select-box">
        <label class="control-label" for="root-select">
          <div class="label-title-row">
            <span>KEY ROOT</span>
            <span class="cc-tag">NOTE CH 1</span>
          </div>
          <span
            class="value-badge"
            class:is-changed={isRootChanged || isOctaveChanged}
            >{ROOT_NOTES[
              $activeGlobalSettings.root
            ]}{$activeGlobalSettings.octave ?? 4}</span
          >
        </label>
        <div class="root-selects-row">
          <select
            id="root-select"
            value={$activeGlobalSettings.root}
            onchange={handleRootChange}
            class="industrial-select select-note"
            class:is-changed={isRootChanged}
            title="Select Key Root Note"
          >
            {#each ROOT_NOTES as note, idx}
              <option value={idx}>{note}</option>
            {/each}
          </select>
          <select
            id="octave-select"
            value={$activeGlobalSettings.octave ?? 4}
            onchange={handleOctaveChange}
            class="industrial-select select-octave"
            class:is-changed={isOctaveChanged}
            title="Select Octave"
          >
            {#each [0, 1, 2, 3, 4, 5, 6, 7, 8] as oct}
              <option value={oct}>Oct {oct}</option>
            {/each}
          </select>
        </div>
      </div>

      <!-- Scale -->
      <div class="control-box select-box">
        <label class="control-label" for="scale-select">
          <div class="label-title-row">
            <span>MUSICAL SCALE</span>
            <span class="cc-tag">CC 9</span>
          </div>
          <span
            class="value-badge scale-badge"
            class:is-changed={isScaleChanged}
            >{SCALES[$activeGlobalSettings.scale]?.toUpperCase()}</span
          >
        </label>
        <select
          id="scale-select"
          value={$activeGlobalSettings.scale}
          onchange={handleScaleChange}
          class="industrial-select"
          class:is-changed={isScaleChanged}
        >
          {#each SCALES as scaleName, idx}
            <option value={idx}>
              {idx < 10 ? `0${idx}` : idx}. {scaleName}
            </option>
          {/each}
        </select>
      </div>
    </div>
  </div>
</div>

<style>
  .global-editor-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .global-editor-panel {
    background: var(--bg-panel);
    border: 1px solid var(--border-box);
    border-radius: 6px;
    padding: 8px 10px;
    box-shadow: var(--box-shadow-panel);
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .panel-title {
    margin: 0;
    font-family: "Chakra Petch", monospace;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1px;
    color: #f1f5f9;
  }

  .cmd-tag {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    color: #64748b;
    background: var(--bg-sub-box);
    padding: 2px 6px;
    border-radius: 2px;
    border: 1px solid var(--border-subtle);
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .staged-badge {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    color: var(--color-orange-text);
    letter-spacing: 0.5px;
    font-weight: 600;
  }

  .controls-grid {
    display: grid;
    grid-template-columns: 1.4fr 1.2fr 1fr 1.2fr;
    gap: 12px;
  }

  @media (max-width: 1024px) {
    .controls-grid {
      grid-template-columns: 1fr 1fr;
    }
  }

  .control-box {
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .control-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-family: "Chakra Petch", monospace;
    font-size: 10.5px;
    font-weight: 700;
    color: #94a3b8;
    margin-bottom: 8px;
    letter-spacing: 0.5px;
  }

  .label-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cc-tag {
    font-family: "JetBrains Mono", monospace;
    font-size: 8px;
    font-weight: 700;
    color: #64748b;
    background: var(--bg-sub-box);
    padding: 0 4px;
    border-radius: 2px;
    border: 1px solid var(--border-subtle);
    letter-spacing: 0.5px;
  }

  .value-badge {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    color: var(--color-orange);
    background: var(--bg-surface);
    padding: 1px 5px;
    border-radius: 2px;
    border: none;
    line-height: inherit;
  }

  .scale-badge {
    text-transform: uppercase;
  }

  .value-badge.bpm-val {
    color: var(--color-orange);
    font-weight: 700;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
  }

  .value-badge.bpm-val:hover {
    filter: brightness(1.2);
  }

  .type-button-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .type-btn {
    padding: 6px 8px;
    border-radius: 4px;
    font-family: "Chakra Petch", monospace;
    font-size: 10.5px;
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
    user-select: none;
  }

  /* State 1: Grey if off (disabled for generation) */
  .type-btn.state-off {
    background: var(--bg-surface);
    border: 1px solid var(--border-box);
    color: #64748b;
  }

  .type-btn.state-off:hover {
    background: var(--bg-surface-hover);
    border-color: var(--border-hover);
    color: #94a3b8;
  }

  .type-btn.state-off .type-num {
    color: #475569;
  }

  .type-btn.state-off .type-checkbox {
    background: var(--bg-sub-box);
    border: 1px solid var(--border-box);
  }

  /* State 2 & 3: Enabled types (State 3 adds the CURRENT PATCH badge in markup) */
  .type-btn.state-enabled,
  .type-btn.state-current {
    background: var(--bg-surface);
    border: 1px solid var(--border-box);
    color: #ffffff;
  }

  .type-btn.state-enabled:hover,
  .type-btn.state-current:hover {
    background: var(--bg-surface-hover);
    border-color: var(--border-hover);
    color: #ffffff;
  }

  .type-btn.state-enabled .type-num,
  .type-btn.state-current .type-num {
    color: #94a3b8;
    font-weight: 700;
  }

  .type-btn.state-enabled .type-checkbox,
  .type-btn.state-current .type-checkbox {
    background: var(--color-orange);
    border: 1px solid var(--color-orange-light);
    color: #ffffff;
  }

  .type-checkbox {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.12s ease;
  }

  .check-icon {
    width: 10px;
    height: 10px;
  }

  .active-badge {
    margin-left: auto;
    font-family: "JetBrains Mono", monospace;
    font-size: 8px;
    font-weight: 800;
    background: var(--color-orange);
    color: #0b0c10;
    padding: 1px 4px;
    border-radius: 2px;
    letter-spacing: 0.5px;
  }

  .type-num {
    font-family: "JetBrains Mono", monospace;
    font-size: 9px;
    opacity: 0.8;
  }

  .slider-wrapper {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .industrial-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 6px;
    background: var(--bg-surface);
    border-radius: 3px;
    outline: none;
    cursor: pointer;
    border: 1px solid var(--border-box);
  }

  .industrial-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    background: var(--color-orange);
    box-shadow: 0 0 8px var(--color-orange-glow);
    cursor: pointer;
    border: 1px solid var(--color-orange-light);
    transition:
      background 0.15s ease,
      box-shadow 0.15s ease,
      border-color 0.15s ease;
  }

  .industrial-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    background: var(--color-orange);
    box-shadow: 0 0 8px var(--color-orange-glow);
    cursor: pointer;
    border: 1px solid var(--color-orange-light);
    transition:
      background 0.15s ease,
      box-shadow 0.15s ease,
      border-color 0.15s ease;
  }

  /* When BPM is changed from patch default: slider thumb turns electric blue (#38bdf8) */
  .industrial-slider.is-changed::-webkit-slider-thumb {
    background: #38bdf8;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.7);
    border: 1px solid #7dd3fc;
  }

  .industrial-slider.is-changed::-moz-range-thumb {
    background: #38bdf8;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.7);
    border: 1px solid #7dd3fc;
  }

  .industrial-slider:disabled {
    cursor: default;
    opacity: 0.6;
    pointer-events: none;
  }

  .industrial-slider:disabled::-webkit-slider-thumb {
    cursor: default;
    box-shadow: none;
  }

  .slider-ticks {
    display: flex;
    justify-content: space-between;
    font-family: "JetBrains Mono", monospace;
    font-size: 8px;
    color: #64748b;
  }

  .value-badge.is-changed {
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.15);
    border: 1px solid rgba(56, 189, 248, 0.4);
  }

  .industrial-select {
    width: 100%;
    background: var(--bg-surface);
    color: var(--color-orange-text);
    font-weight: 700;
    border: 1px solid var(--color-orange);
    border-radius: 3px;
    padding: 7px 10px;
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    outline: none;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .industrial-select option {
    background: #101216;
    color: var(--color-orange-text);
  }

  .industrial-select:focus {
    border-color: var(--color-orange);
    box-shadow: 0 0 6px var(--color-orange-glow);
  }

  /* Blue surround for dropdown boxes when changed from patch default */
  .industrial-select.is-changed {
    border-color: #38bdf8;
    outline: 1px solid #38bdf8;
    box-shadow:
      0 0 8px rgba(56, 189, 248, 0.45),
      inset 0 0 4px rgba(56, 189, 248, 0.12);
    background: #101622;
    color: #38bdf8;
  }

  .industrial-select.is-changed:focus {
    border-color: #7dd3fc;
    outline: 1px solid #7dd3fc;
    box-shadow: 0 0 10px rgba(56, 189, 248, 0.6);
  }

  .root-selects-row {
    display: flex;
    gap: 6px;
    align-items: center;
    width: 100%;
  }

  .select-note {
    flex: 1.3;
    min-width: 0;
  }

  .select-octave {
    flex: 1;
    min-width: 0;
    padding: 7px 6px;
  }
</style>
