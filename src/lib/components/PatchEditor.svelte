<script lang="ts">
  import {
    masterVolumeStore,
    masterReverbMultStore,
    trackVolumesStore,
    trackReverbsStore,
    reverbPredelayStore,
    reverbToneStore,
    reverbDiffusion1Store,
    reverbDiffusion2Store,
    reverbDecayStore,
    reverbDecayKnobStore,
    reverbRoomSizeStore,
    activeProceduralLevels,
    activeTracks,
  } from "../stores";
  import { midiManager } from "../midi/midiManager";
  import HardwareButton from "./HardwareButton.svelte";
  import GlobalEditor from "./GlobalEditor.svelte";
  import TrackEditor from "./TrackEditor.svelte";
  import Knob from "./Knob.svelte";

  function handleMasterVolumeChange(val: number) {
    midiManager.setMasterVolume(val);
  }

  function handleMasterReverbMultChange(val: number) {
    midiManager.setMasterReverbMult(val);
  }

  function handleChannelVolumeChange(chIdx: number, val: number) {
    midiManager.setChannelVolume(chIdx, val);
  }

  function handleChannelReverbChange(chIdx: number, val: number) {
    midiManager.setChannelReverb(chIdx, val);
  }

  function handlePredelayChange(val: number) {
    midiManager.setDspReverbParam(85, val);
  }

  function handleToneChange(val: number) {
    midiManager.setDspReverbParam(86, val);
  }

  function handleDiffusion1Change(val: number) {
    midiManager.setDspReverbParam(87, val);
  }

  function handleDiffusion2Change(val: number) {
    midiManager.setDspReverbParam(88, val);
  }

  function handleRoomSizeChange(val: number) {
    midiManager.setDspReverbParam(89, val);
  }

  function handleDecayChange(val: number) {
    if (val < 127 && isDecayLatched) {
      isDecayLatched = false;
    }
    if (!isDecayLatched && !isInfActive) {
      preInfDecay = val;
    }
    reverbDecayStore.set(val);
    reverbDecayKnobStore.set(val);
    midiManager.setDspReverbParam(90, val);
  }

  let isInfActive = $state(false);
  let isDecayLatched = $state(false);
  let preInfDecay = $state(83);

  $effect(() => {
    if ($activeProceduralLevels) {
      isDecayLatched = false;
      isInfActive = false;
      preInfDecay = $reverbDecayKnobStore;
    }
  });

  function handleInfPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement)?.setPointerCapture(e.pointerId);
    } catch {}
    if (!isInfActive) {
      if (!isDecayLatched) {
        preInfDecay = $reverbDecayKnobStore;
      }
      isInfActive = true;
      midiManager.setDspReverbParam(90, 127, { skipDirty: true });
    }
  }

  function handleInfPointerUp(e: PointerEvent) {
    if (isInfActive) {
      isInfActive = false;
      if (!isDecayLatched) {
        midiManager.rampReverbDecay(preInfDecay, { skipDirty: true });
      }
    }
  }

  function handleLatchToggle() {
    if (isDecayLatched) {
      isDecayLatched = false;
      if (!isInfActive) {
        midiManager.rampReverbDecay(preInfDecay, { skipDirty: true });
      }
    } else {
      if (!isInfActive) {
        preInfDecay = $reverbDecayKnobStore;
      }
      isDecayLatched = true;
      midiManager.setDspReverbParam(90, 127, { skipDirty: true });
    }
  }
</script>

<div class="patch-editor-container">
  <!-- Top Master Row: Big Button Setup + Knobs Container Box -->
  <div class="master-row">
    <!-- Big Button Setup (Outside the knobs container) -->
    <div class="hardware-trigger-panel">
      <HardwareButton />
    </div>

    <!-- Knobs Container Box (Containing all channel and reverb knobs) -->
    <section class="master-knobs-section">
      <!-- Upper Row: Mixer Controls (CH 1 - CH 4 & MASTER) -->
      <div class="controls-mixer-area">
        {#each [0, 1, 2, 3] as idx}
          {@const isChannelActive = $activeTracks[idx]?.active ?? true}
          <div
            class="knobs-box"
            class:inactive={!isChannelActive}
            inert={!isChannelActive}
          >
            <div class="box-header">
              <span class="box-title">CH {idx + 1}</span>
              <span class="box-sub">MIDI CH {idx + 2}</span>
            </div>
            <div class="box-knobs">
              <Knob
                label="VOLUME"
                cc={7}
                value={$trackVolumesStore[idx]}
                defaultValue={100}
                onchange={(v) => handleChannelVolumeChange(idx, v)}
              />
              <Knob
                label="REVERB"
                cc={91}
                value={$trackReverbsStore[idx]}
                defaultValue={$activeProceduralLevels?.trackReverbsCC?.[idx] ??
                  64}
                onchange={(v) => handleChannelReverbChange(idx, v)}
              />
            </div>
          </div>
        {/each}

        <!-- MASTER Box -->
        <div class="knobs-box master-box">
          <div class="box-header">
            <span class="box-title master-title">MASTER</span>
            <span class="box-sub">MIDI CH 1</span>
          </div>
          <div class="box-knobs">
            <Knob
              label="VOLUME"
              cc={7}
              value={$masterVolumeStore}
              defaultValue={100}
              onchange={handleMasterVolumeChange}
            />
            <Knob
              label="REV MULT"
              cc={91}
              value={$masterReverbMultStore}
              defaultValue={64}
              formatValue={(val) =>
                (val <= 64 ? val / 64 : 1 + (val - 64) / 63).toFixed(2)}
              onchange={handleMasterReverbMultChange}
            />
          </div>
        </div>
      </div>

      <!-- Lower Row: REVERB CONTROLS (CC 85-90) -->
      <div class="reverb-dsp-panel">
        <div class="reverb-panel-header">
          <div class="reverb-title-row">
            <span class="reverb-box-title">REVERB CONTROLS</span>
          </div>
        </div>

        <div class="reverb-knobs-row">
          <Knob
            label="PRE-DELAY"
            cc={85}
            value={$reverbPredelayStore}
            defaultValue={$activeProceduralLevels?.predelayCC ?? 0}
            onchange={handlePredelayChange}
          />
          <Knob
            label="TONE"
            cc={86}
            value={$reverbToneStore}
            defaultValue={$activeProceduralLevels?.toneCC ?? 64}
            onchange={handleToneChange}
          />
          <Knob
            label="DIFFUSION 1"
            cc={87}
            value={$reverbDiffusion1Store}
            defaultValue={$activeProceduralLevels?.diffusion1CC ?? 64}
            onchange={handleDiffusion1Change}
          />
          <Knob
            label="DIFFUSION 2"
            cc={88}
            value={$reverbDiffusion2Store}
            defaultValue={$activeProceduralLevels?.diffusion2CC ?? 64}
            onchange={handleDiffusion2Change}
          />
          <Knob
            label="ROOM SIZE"
            cc={89}
            value={$reverbRoomSizeStore}
            defaultValue={$activeProceduralLevels?.roomSizeCC ?? 64}
            onchange={handleRoomSizeChange}
          />
          <!-- DECAY knob + INF / LATCH -->
          <div
            class="decay-composite-box"
            class:active={isInfActive || isDecayLatched}
            title="Reverb DECAY with INF / LATCH infinite decay (CC 90)"
          >
            <div class="composite-knob-col">
              <Knob
                label="DECAY"
                cc={90}
                value={$reverbDecayKnobStore}
                defaultValue={$activeProceduralLevels?.decayCC ?? 83}
                borderless={true}
                onchange={handleDecayChange}
              />
            </div>
            <div class="composite-divider"></div>
            <div class="composite-buttons">
              <button
                type="button"
                class="inf-btn"
                class:active={isInfActive}
                onpointerdown={handleInfPointerDown}
                onpointerup={handleInfPointerUp}
                onpointercancel={handleInfPointerUp}
                title="INF: momentary infinite decay (hold for 100% decay)"
              >
                <span class="btn-text">INF</span>
                <span class="btn-sub">HOLD</span>
              </button>
              <button
                type="button"
                class="latch-btn"
                class:latched={isDecayLatched}
                onclick={handleLatchToggle}
                title="LATCH: toggle infinite decay on / off"
              >
                <span class="btn-text">LATCH</span>
                <span class="btn-sub">{isDecayLatched ? "ON" : "OFF"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>

  <!-- Global Settings Section -->
  <section class="editor-section">
    <GlobalEditor />
  </section>

  <!-- TRACK CONTROLS (CH 1 - CH 4) -->
  <section class="tracks-section">
    <div class="tracks-header">
      <div class="tracks-title-group">
        <h3 class="section-title">TRACK CONTROLS & PATCH DATA</h3>
      </div>
    </div>

    <div class="tracks-grid">
      {#each [0, 1, 2, 3] as trackIdx}
        <TrackEditor trackIndex={trackIdx} />
      {/each}
    </div>
  </section>
</div>

<style>
  .patch-editor-container {
    display: flex;
    flex-direction: column;
    gap: 16px;
    height: 100%;
    overflow-y: auto;
    padding: 16px;
    background: var(--bg-workbench);
  }

  /* Master Row: Hardware Button Setup + Knobs Container Box */
  .master-row {
    display: flex;
    align-items: stretch;
    gap: 16px;
    flex-wrap: nowrap;
  }

  .hardware-trigger-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  /* Knobs Container Box: Holds all mixer and reverb knobs */
  .master-knobs-section {
    background: var(--bg-panel);
    border: 1px solid var(--border-box);
    border-radius: 8px;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
    box-shadow: var(--box-shadow-panel);
    flex-shrink: 0;
  }

  @media (max-width: 1200px) {
    .master-row {
      flex-wrap: wrap;
    }
  }

  .controls-mixer-area {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: nowrap;
    justify-content: flex-end;
  }

  .reverb-dsp-panel {
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    box-shadow: var(--box-shadow-inset-box);
    align-self: flex-end;
    width: fit-content;
  }

  .reverb-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 2px 4px 2px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .reverb-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .reverb-box-title {
    font-family: "Chakra Petch", monospace;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.8px;
    color: #94a3b8;
  }

  .reverb-knobs-row {
    display: flex;
    align-items: stretch;
    justify-content: flex-end;
    gap: 6px;
  }

  .decay-composite-box {
    display: flex;
    align-items: stretch;
    padding: 0;
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    box-sizing: border-box;
    overflow: hidden;
    box-shadow: var(--box-shadow-inset-box);
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }

  .decay-composite-box:hover {
    border-color: var(--border-hover);
  }

  .decay-composite-box.active {
    border-color: rgba(56, 189, 248, 0.65);
    box-shadow:
      0 0 12px rgba(56, 189, 248, 0.25),
      var(--box-shadow-inset-box);
  }

  .composite-knob-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 68px;
    min-width: 68px;
    max-width: 68px;
    padding: 6px 8px;
    box-sizing: border-box;
  }

  .composite-divider {
    width: 1px;
    background: rgba(255, 255, 255, 0.08);
    align-self: stretch;
  }

  .composite-buttons {
    display: flex;
    flex-direction: column;
    width: 68px;
    min-width: 68px;
    max-width: 68px;
    padding: 6px 6px;
    gap: 4px;
    align-self: stretch;
    box-sizing: border-box;
  }

  .inf-btn,
  .latch-btn {
    width: 100%;
    flex: 1 1 0;
    min-height: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    border-radius: 4px;
    border: 1px solid var(--color-orange);
    background: var(--bg-surface);
    color: var(--color-orange-text);
    cursor: pointer;
    user-select: none;
    transition: all 0.12s ease;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 1px 3px rgba(0, 0, 0, 0.4);
    outline: none;
    padding: 0 6px;
  }

  .inf-btn .btn-text,
  .latch-btn .btn-text {
    font-family: "Chakra Petch", monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.8px;
    line-height: 1;
    color: var(--color-orange-text);
  }

  .inf-btn .btn-sub,
  .latch-btn .btn-sub {
    font-family: "JetBrains Mono", monospace;
    font-size: 7px;
    font-weight: 600;
    letter-spacing: 0.3px;
    color: var(--color-orange-text-light);
    line-height: 1;
  }

  .inf-btn:hover:not(.active),
  .latch-btn:hover:not(.latched) {
    background: var(--color-orange);
    border-color: var(--color-orange);
    color: #0b0d10;
    box-shadow: 0 0 8px var(--color-orange-glow);
  }

  .inf-btn:hover:not(.active) .btn-text,
  .latch-btn:hover:not(.latched) .btn-text,
  .inf-btn:hover:not(.active) .btn-sub,
  .latch-btn:hover:not(.latched) .btn-sub {
    color: #0b0d10;
  }

  .latch-btn:active:not(.latched) {
    background: var(--color-orange-dark);
    border-color: var(--color-orange-dark);
    color: #0b0d10;
  }

  .inf-btn:active,
  .inf-btn.active {
    background: linear-gradient(180deg, #38bdf8 0%, #0284c7 100%);
    border-color: #bae6fd;
    color: #ffffff;
    box-shadow:
      0 0 12px rgba(56, 189, 248, 0.6),
      inset 0 1px 2px rgba(255, 255, 255, 0.4);
    transform: translateY(1px);
    transition: none;
  }

  .inf-btn:active .btn-text,
  .inf-btn.active .btn-text {
    color: #ffffff;
  }

  .inf-btn:active .btn-sub,
  .inf-btn.active .btn-sub {
    color: rgba(255, 255, 255, 0.95);
  }

  .latch-btn.latched {
    background: linear-gradient(180deg, #0ea5e9 0%, #0369a1 100%);
    border-color: #7dd3fc;
    color: #ffffff;
    box-shadow:
      0 0 12px rgba(14, 165, 233, 0.55),
      inset 0 1px 2px rgba(255, 255, 255, 0.35);
  }

  .latch-btn.latched .btn-sub {
    color: #ffffff;
    font-weight: 700;
  }

  .knobs-box {
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    box-shadow: var(--box-shadow-inset-box);
  }

  .knobs-box.inactive {
    opacity: 0.35;
    filter: grayscale(1);
    border-color: #1a1e26;
    box-shadow: none;
  }

  .knobs-box.master-box {
    border-color: var(--color-orange-glow);
    background: hsla(
      var(--accent-hue),
      var(--accent-sat),
      var(--accent-brightness),
      0.04
    );
  }

  .box-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0 2px;
  }

  .box-title {
    font-family: "Chakra Petch", monospace;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.8px;
    color: #94a3b8;
  }

  .box-title.master-title {
    color: var(--color-orange-text);
  }

  .box-sub {
    font-family: "JetBrains Mono", monospace;
    font-size: 7.5px;
    color: #64748b;
    letter-spacing: 0.3px;
  }

  .box-knobs {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Tracks Section */
  .tracks-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .tracks-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px;
  }

  .tracks-title-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .section-title {
    margin: 0;
    font-family: "Chakra Petch", monospace;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1px;
    color: #f1f5f9;
  }

  .tracks-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }

  @media (max-width: 1280px) {
    .tracks-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 680px) {
    .tracks-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
