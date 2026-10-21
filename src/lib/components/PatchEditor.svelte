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
  import { onMount } from "svelte";

  // Top row layout by editor width (knobs never shrink):
  //  - full: trigger button + all five mixer boxes on one row, reverb controls below
  //  - MASTER drops into the space left of REVERB CONTROLS, button still full height
  //  - narrower still: smaller button, knob groups wrap freely
  // The widths each layout needs are measured from the rendered row (button + gap + knobs
  // box), so a layout only changes when the row really stops fitting. These are only the
  // starting values used before the first measurement.
  const ROW_GAP = 10; // .master-row gap
  let fullRowWidth = $state(1173); // editor px the full top row needs
  let droppedRowWidth = $state(1056); // editor px the top row needs with MASTER dropped
  let editorEl: HTMLDivElement;
  let triggerPanelEl: HTMLDivElement;
  let knobsSectionEl: HTMLElement;
  let editorScaleEl: HTMLDivElement;
  let mixerAreaEl: HTMLDivElement;
  let lowerRowEl: HTMLDivElement;
  let editorWidth = $state(0);
  // The trigger button is a square as tall as the knobs box (set explicitly: deriving its
  // width from a stretched height is unreliable and collapsed it to 0 px wide)
  let knobsBoxHeight = $state(0);

  // Wider than the default 1920 x 1080 window, the WHOLE app (librarian, editor, header,
  // status bar) scales up together as one piece, blending two things:
  //  - it scales up evenly (x and y), but only as far as the window height allows, so the
  //    editor content still fits without scrolling (never beyond what the width alone gives);
  //  - any width left over widens the editor, up to MAX_LAYOUT_STRETCH x its 1920 width;
  //    past that the editor content is centred rather than stretched further.
  // The scale is applied as --app-scale on the root (see app.css), on top of --ui-scale.
  const DEFAULT_WINDOW_WIDTH = 1920;
  const MAX_LAYOUT_STRETCH = 1.35;
  let uiScale = 1; // --ui-scale from app.css
  let appliedScale = 1; // --app-scale currently on the root
  let windowWidth = $state(DEFAULT_WINDOW_WIDTH);
  let windowHeight = $state(1080);
  // Height of the standard full editor layout (unscaled), the reference for the height limit.
  // Only re-measured while unscaled in the full layout, so the scale can't feed back into it
  // (that loop made some window sizes flicker). 852 px is the measured value.
  let referenceHeight = $state(852);
  // Height around the editor content (header, status bar, padding) in unscaled px; constant
  let chromeHeight = $state(0);
  const appScale = $derived.by(() => {
    if (windowWidth <= DEFAULT_WINDOW_WIDTH || chromeHeight <= 0) return 1;
    const widthScale = windowWidth / DEFAULT_WINDOW_WIDTH;
    const heightScale = windowHeight / (uiScale * (referenceHeight * 1.01 + chromeHeight)); // 1%: rounding margin
    // Rounded down (never overshoots the height) so re-layout can't make it hunt
    return Math.floor(Math.min(widthScale, Math.max(1, heightScale)) * 100) / 100;
  });
  $effect(() => {
    appliedScale = appScale;
    document.documentElement.style.setProperty("--app-scale", String(appScale));
  });
  // Editor width at the default 1920 px window: every extra (unscaled) px goes to the editor
  const baseWidth = $derived(
    editorWidth -
      Math.max(0, windowWidth / (uiScale * appScale) - DEFAULT_WINDOW_WIDTH / uiScale),
  );
  // Widest the editor content is laid out; beyond it, it is centred
  const maxLayoutWidth = $derived(
    windowWidth > DEFAULT_WINDOW_WIDTH && baseWidth > 0
      ? Math.round(baseWidth * MAX_LAYOUT_STRETCH)
      : null,
  );
  // Width the editor's content is laid out in
  const layoutWidth = $derived(Math.min(editorWidth, maxLayoutWidth ?? Infinity));

  const masterDropped = $derived(
    layoutWidth > 0 && layoutWidth < fullRowWidth && layoutWidth >= droppedRowWidth,
  );
  const masterWrapped = $derived(layoutWidth > 0 && layoutWidth < droppedRowWidth);

  // In the full and dropped layouts the knobs box keeps its natural width, so the row's
  // needed width can be read straight off the elements (the wrapped layout is flexible).
  // The knobs box stretches to the row width, so its natural width is rebuilt from its
  // content: the wider of the mixer row and the lower row, plus the box's padding and border.
  const KNOBS_BOX_GAP = 6; // .controls-mixer-area / .lower-row gap
  const contentRowWidth = (row: HTMLElement) => {
    const items = Array.from(row.children) as HTMLElement[];
    return (
      items.reduce((sum, el) => sum + el.offsetWidth, 0) +
      KNOBS_BOX_GAP * Math.max(0, items.length - 1)
    );
  };

  function measureTopRow() {
    if (masterWrapped || !triggerPanelEl || !knobsSectionEl) return;
    const box = getComputedStyle(knobsSectionEl);
    const boxFrame =
      parseFloat(box.paddingLeft) +
      parseFloat(box.paddingRight) +
      parseFloat(box.borderLeftWidth) +
      parseFloat(box.borderRightWidth);
    const knobsNatural =
      boxFrame + Math.max(contentRowWidth(mixerAreaEl), contentRowWidth(lowerRowEl));
    const needed = Math.ceil(triggerPanelEl.offsetWidth + ROW_GAP + knobsNatural);
    if (masterDropped) droppedRowWidth = needed;
    else fullRowWidth = needed;
  }

  $effect(() => {
    void editorWidth;
    void masterDropped;
    void masterWrapped;
    measureTopRow();
  });

  onMount(() => {
    uiScale =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"),
      ) || 1;
    const observer = new ResizeObserver(([entry]) => {
      windowWidth = window.innerWidth;
      windowHeight = window.innerHeight;
      editorWidth = entry.contentRect.width;
      // Everything above and below the editor content, in unscaled px
      chromeHeight =
        window.innerHeight / (uiScale * appliedScale) - entry.contentRect.height;
    });
    observer.observe(editorEl);
    const knobsObserver = new ResizeObserver(() => {
      knobsBoxHeight = knobsSectionEl.offsetHeight;
    });
    knobsObserver.observe(knobsSectionEl);
    const contentObserver = new ResizeObserver(() => {
      if (appScale === 1 && !masterDropped && !masterWrapped) {
        referenceHeight = editorScaleEl.offsetHeight;
      }
    });
    contentObserver.observe(editorScaleEl);
    document.fonts?.ready.then(measureTopRow);
    return () => {
      observer.disconnect();
      knobsObserver.disconnect();
      contentObserver.disconnect();
    };
  });

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

{#snippet masterBox()}
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
{/snippet}

<div class="patch-editor-container" bind:this={editorEl}>
  <div
    class="editor-scale"
    bind:this={editorScaleEl}
    style:max-width={maxLayoutWidth ? `${maxLayoutWidth}px` : null}
  >
  <!-- Top Master Row: Big Button Setup + Knobs Container Box -->
  <div class="master-row" class:wrapped={masterWrapped}>
    <!-- Big Button Setup (Outside the knobs container) -->
    <div
      class="hardware-trigger-panel"
      bind:this={triggerPanelEl}
      style:width={!masterWrapped && knobsBoxHeight ? `${knobsBoxHeight}px` : null}
      style:height={!masterWrapped && knobsBoxHeight ? `${knobsBoxHeight}px` : null}
    >
      <HardwareButton />
    </div>

    <!-- Knobs Container Box (Containing all channel and reverb knobs) -->
    <section class="master-knobs-section" bind:this={knobsSectionEl}>
      <!-- Upper Row: Mixer Controls (CH 1 - CH 4 & MASTER) -->
      <div class="controls-mixer-area" bind:this={mixerAreaEl}>
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

        {#if !masterDropped}
          {@render masterBox()}
        {/if}
      </div>

      <!-- Lower Row: REVERB CONTROLS (CC 85-90), with MASTER beside it when dropped -->
      <div class="lower-row" bind:this={lowerRowEl}>
      {#if masterDropped}
        {@render masterBox()}
      {/if}
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
</div>

<style>
  .patch-editor-container {
    height: 100%;
    overflow-y: auto;
    /* The scrollbar's space is always reserved, so it appearing can't change the width */
    scrollbar-gutter: stable;
    padding: 16px;
    background: var(--bg-workbench);
    /* Sections reflow on the editor's own width (the librarian takes the rest of the window) */
    container: editor / inline-size;
  }

  .editor-scale {
    margin: 0 auto; /* centred once the layout reaches its maximum width */
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  /* Master Row: Hardware Button Setup + Knobs Container Box */
  .master-row {
    display: flex;
    align-items: stretch;
    gap: 10px; /* keep ROW_GAP in the script in step */
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
    padding: 14px 12px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
    box-shadow: var(--box-shadow-panel);
    flex: 1 0 auto; /* fills the row (knob groups stay right-aligned), never shrinks */
  }

  .controls-mixer-area {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
    justify-content: flex-end;
  }

  .lower-row {
    display: flex;
    align-items: stretch;
    justify-content: flex-end;
    gap: 6px;
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
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  /* 1634 px (unscaled) window = 1092 px editor */
  @container editor (max-width: 1092px) {
    .tracks-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @container editor (max-width: 480px) {
    .tracks-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  /* Too narrow to scale: a smaller trigger button beside the knobs box, whose knob groups wrap */
  .master-row.wrapped .hardware-trigger-panel {
    align-self: flex-start;
    width: 220px;
    height: 220px;
  }

  .master-row.wrapped .master-knobs-section {
    flex: 1 1 0;
    min-width: 0;
  }

  .master-row.wrapped .controls-mixer-area {
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .master-row.wrapped .lower-row {
    justify-content: stretch;
  }

  .master-row.wrapped .reverb-dsp-panel {
    flex: 1;
    width: auto;
  }

  .master-row.wrapped .reverb-knobs-row {
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  /* Narrow editor: trigger button on top, knobs box full width below */
  @container editor (max-width: 760px) {
    .master-row.wrapped {
      flex-direction: column;
    }

    .master-row.wrapped .hardware-trigger-panel {
      align-self: center;
    }

    .master-row.wrapped .master-knobs-section {
      flex: none;
    }
  }
</style>
