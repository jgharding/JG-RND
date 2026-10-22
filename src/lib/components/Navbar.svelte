<script lang="ts">
  import { onMount } from "svelte";
  import {
    midiStore,
    selectedPatch,
    ignoreOsScalingStore,
    isFirmwareModalOpen,
    uiZoomStore,
    UI_ZOOM_DEFAULT,
    UI_ZOOM_MIN,
    UI_ZOOM_MAX,
  } from "../stores";
  import { midiManager } from "../midi/midiManager";
  import Icon from "./Icon.svelte";

  onMount(() => {
    midiManager.initMidi();
  });

  function handleInputSelect(e: Event) {
    const target = e.target as HTMLSelectElement;
    midiManager.selectInput(target.value);
  }

  function handleOutputSelect(e: Event) {
    const target = e.target as HTMLSelectElement;
    midiManager.selectOutput(target.value);
  }

  function handleRefreshMidi() {
    midiManager.rescanPorts();
  }

  // Main options menu, opened from the JG-RND badge
  let optionsOpen = $state(false);
  let brandEl: HTMLDivElement;
  // OS display scaling x browser zoom, read when the menu opens
  let detectedScale = $state(100);
  const finePointer = window.matchMedia?.("(pointer: fine)").matches ?? true;

  function toggleOptions() {
    optionsOpen = !optionsOpen;
    if (optionsOpen) detectedScale = Math.round((window.devicePixelRatio || 1) * 100);
  }

  // Web version (GitHub Pages) and desktop apps (GitHub Releases) link to each other
  const isDesktopApp = navigator.userAgent.includes("Electron");
  const RELEASES_URL = "https://github.com/jgharding/JG-RND/releases/latest";
  const WEB_APP_URL = "https://jgharding.github.io/JG-RND/";

  // App zoom slider (percent). Snaps to common values when within ZOOM_SNAP_RANGE of them,
  // any whole percent in between is allowed. Double-click resets, the readout can be typed in.
  const ZOOM_SNAP_POINTS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
  const ZOOM_SNAP_RANGE = 2;
  const zoomPercent = $derived(Math.round($uiZoomStore * 100));
  let zoomText = $state("");
  let zoomEditing = $state(false);
  // While the slider is dragged its value is only previewed, and applied on release: zooming
  // live would resize the slider under the pointer and make the drag jump.
  let zoomDragValue = $state<number | null>(null);
  const shownZoomPercent = $derived(zoomDragValue ?? zoomPercent);

  function clampZoomPercent(percent: number, snap: boolean) {
    let value = Math.round(
      Math.min(UI_ZOOM_MAX * 100, Math.max(UI_ZOOM_MIN * 100, percent)),
    );
    if (snap) {
      const near = ZOOM_SNAP_POINTS.find((p) => Math.abs(p - value) <= ZOOM_SNAP_RANGE);
      if (near !== undefined) value = near;
    }
    return value;
  }

  function handleZoomSliderInput(e: Event) {
    zoomDragValue = clampZoomPercent(Number((e.target as HTMLInputElement).value), true);
  }

  function handleZoomSliderChange() {
    if (zoomDragValue !== null) uiZoomStore.set(zoomDragValue / 100);
    zoomDragValue = null;
  }

  function resetZoom() {
    uiZoomStore.set(UI_ZOOM_DEFAULT);
  }

  function startZoomEdit(e: FocusEvent) {
    zoomEditing = true;
    zoomText = String(zoomPercent);
    // Select after Svelte has written the text in
    requestAnimationFrame(() => (e.target as HTMLInputElement).select());
  }

  function commitZoomEdit() {
    const typed = parseFloat(zoomText);
    if (Number.isFinite(typed)) uiZoomStore.set(clampZoomPercent(typed, false) / 100);
    zoomEditing = false;
  }

  function handleZoomKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    else if (e.key === "Escape") {
      e.stopPropagation(); // cancel the edit only, keep the menu open
      zoomEditing = false;
      (e.target as HTMLInputElement).blur();
    }
  }

  function openFirmwareUpdate() {
    optionsOpen = false;
    isFirmwareModalOpen.set(true);
  }

  function handleWindowPointerDown(e: PointerEvent) {
    if (optionsOpen && !brandEl.contains(e.target as Node)) optionsOpen = false;
  }

  function handleWindowKeydown(e: KeyboardEvent) {
    if (optionsOpen && e.key === "Escape" && !zoomEditing) optionsOpen = false;
  }
</script>

<svelte:window
  onpointerdown={handleWindowPointerDown}
  onkeydown={handleWindowKeydown}
/>

<header class="navbar">
  <!-- Brand / Title -->
  <div class="brand" bind:this={brandEl}>
    <button
      class="brand-badge"
      class:open={optionsOpen}
      title="Options"
      aria-haspopup="true"
      aria-expanded={optionsOpen}
      onclick={toggleOptions}
    >
      JG-RND
    </button>
    {#if optionsOpen}
      <div class="options-menu" role="menu">
        <div class="options-heading">OPTIONS</div>
        <div class="options-section">
          <div class="options-section-title">DISPLAY</div>
          <label class="option-row" class:disabled={!finePointer}>
            <input
              type="checkbox"
              bind:checked={$ignoreOsScalingStore}
              disabled={!finePointer}
            />
            <span class="option-text">
              <span class="option-label">Ignore Windows display scaling</span>
              <span class="option-hint">
                {#if finePointer}
                  Sizes the app by the monitor's real pixels, as on a 100% scaled
                  display. Also cancels browser zoom while on. Detected scale: {detectedScale}%.
                {:else}
                  Desktop only.
                {/if}
              </span>
            </span>
          </label>
          <div class="zoom-row">
            <div class="zoom-header">
              <label class="option-label" for="app-zoom-slider">App zoom</label>
              <input
                class="zoom-value"
                type="text"
                inputmode="decimal"
                aria-label="App zoom percent"
                title="Click to type a zoom percent"
                value={zoomEditing ? zoomText : `${shownZoomPercent}%`}
                oninput={(e) => (zoomText = (e.target as HTMLInputElement).value)}
                onfocus={startZoomEdit}
                onblur={commitZoomEdit}
                onkeydown={handleZoomKeydown}
              />
            </div>
            <input
              id="app-zoom-slider"
              class="zoom-slider"
              type="range"
              min={UI_ZOOM_MIN * 100}
              max={UI_ZOOM_MAX * 100}
              step="1"
              value={shownZoomPercent}
              title="Double-click to reset to {Math.round(UI_ZOOM_DEFAULT * 100)}%"
              oninput={handleZoomSliderInput}
              onchange={handleZoomSliderChange}
              ondblclick={resetZoom}
            />
            <span class="option-hint">
              Snaps to common sizes. Double-click to reset to {Math.round(
                UI_ZOOM_DEFAULT * 100,
              )}%.
            </span>
          </div>
        </div>
        <div class="options-section">
          <div class="options-section-title">APP</div>
          {#if isDesktopApp}
            <a class="option-link" href={RELEASES_URL} target="_blank" rel="noopener">
              Check for a new version
            </a>
            <a class="option-link" href={WEB_APP_URL} target="_blank" rel="noopener">
              Open the web version
            </a>
          {:else}
            <a class="option-link" href={RELEASES_URL} target="_blank" rel="noopener">
              Download the desktop app
            </a>
            <span class="option-hint">Windows, macOS and Linux.</span>
          {/if}
        </div>
        <button type="button" class="firmware-btn" onclick={openFirmwareUpdate}>
          UPDATE FIRMWARE
        </button>
      </div>
    {/if}
    <div class="brand-text">
      <span class="brand-title">RND by CYMA FORMA & BAMBOUNOU</span>
      <span class="brand-sub">PATCH LIBRARIAN & EDITOR</span>
    </div>
  </div>

  <!-- Center: Large Patch Name -->
  <div class="navbar-center-patch">
    <h2 class="patch-heading">
      {$selectedPatch
        ? $selectedPatch.name
        : "No Patch Selected (Press Trigger or Row)"}
    </h2>
  </div>

  <!-- Furthest right & right-justified: MIDI Device Selectors -->
  <div
    class="midi-selectors"
    class:unconnected={!$midiStore.selectedInputId ||
      !$midiStore.selectedOutputId}
  >
    <!-- Input Selector -->
    <div class="selector-group">
      <label for="midi-in-select">MIDI IN</label>
      <select
        id="midi-in-select"
        value={$midiStore.selectedInputId}
        onchange={handleInputSelect}
      >
        <option value="">(None)</option>
        {#each $midiStore.inputPorts as port}
          <option value={port.id}>{port.name}</option>
        {/each}
      </select>
    </div>

    <!-- Output Selector -->
    <div class="selector-group">
      <label for="midi-out-select">MIDI OUT</label>
      <select
        id="midi-out-select"
        value={$midiStore.selectedOutputId}
        onchange={handleOutputSelect}
      >
        <option value="">(None)</option>
        {#each $midiStore.outputPorts as port}
          <option value={port.id}>{port.name}</option>
        {/each}
      </select>
    </div>

    <!-- Refresh Ports Button -->
    <button
      class="icon-btn"
      title="Rescan MIDI Ports (retries MIDI permission if it was denied)"
      onclick={handleRefreshMidi}
    >
      <Icon name="refresh" size={14} />
    </button>
  </div>
</header>

<style>
  .navbar {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    background: var(--bg-panel);
    border-bottom: 2px solid var(--border-box);
    padding: 7px 20px;
    color: #e2e8f0;
    font-family: "Space Grotesk", system-ui, sans-serif;
    user-select: none;
    box-shadow: var(--box-shadow-panel);
    z-index: 50;
  }

  .brand {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-badge {
    background: var(--color-orange);
    color: #0b0c0e;
    font-family: "Chakra Petch", monospace;
    font-weight: 800;
    font-size: 15px;
    padding: 3px 8px;
    border-radius: 3px;
    letter-spacing: 1px;
    height: 26px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease;
  }

  .brand-badge:hover,
  .brand-badge.open {
    background: #ffffff;
    color: #000000;
  }

  .options-menu {
    position: absolute;
    top: calc(100% + 10px);
    left: 0;
    width: 300px;
    background: var(--bg-panel);
    border: 1px solid var(--color-orange);
    border-radius: 4px;
    box-shadow:
      var(--box-shadow-panel),
      0 8px 24px rgba(0, 0, 0, 0.5);
    padding: 12px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .options-heading {
    font-family: "Chakra Petch", monospace;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 1.5px;
    color: var(--color-orange-text);
  }

  .options-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 8px 10px;
  }

  .options-section-title {
    font-family: "Chakra Petch", monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 1px;
    color: #718096;
  }

  .option-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    cursor: pointer;
  }

  .option-row.disabled {
    cursor: default;
    opacity: 0.5;
  }

  .option-row input {
    margin: 2px 0 0;
    accent-color: var(--color-orange);
    cursor: inherit;
  }

  .option-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .option-label {
    font-size: 12px;
    font-weight: 600;
    color: #e2e8f0;
  }

  .zoom-row {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px solid var(--border-subtle);
  }

  .zoom-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .zoom-value {
    width: 56px;
    background: var(--bg-surface);
    color: var(--color-orange-text);
    border: 1px solid var(--border-box);
    border-radius: 3px;
    padding: 2px 6px;
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    text-align: right;
    outline: none;
    cursor: text;
  }

  .zoom-value:focus {
    border-color: var(--color-orange);
  }

  .zoom-slider {
    width: 100%;
    margin: 0;
    accent-color: var(--color-orange);
    cursor: pointer;
  }

  .firmware-btn {
    background: var(--color-orange);
    color: #0b0c0e;
    border: none;
    border-radius: 4px;
    padding: 8px 10px;
    font-family: "Chakra Petch", monospace;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 1px;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease;
  }

  .firmware-btn:hover {
    background: #ffffff;
    color: #000000;
  }

  .option-link {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-orange-text);
    text-decoration: none;
  }

  .option-link:hover {
    text-decoration: underline;
  }

  .option-hint {
    font-size: 10px;
    line-height: 1.4;
    color: #a0aec0;
  }

  .brand-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .brand-title {
    font-family: "Chakra Petch", monospace;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 1.5px;
    color: #ffffff;
  }

  .brand-sub {
    font-size: 10px;
    color: #718096;
    letter-spacing: 0.8px;
    font-weight: 500;
  }

  .midi-selectors {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--bg-sub-box);
    padding: 6px 12px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    transition: all 0.2s ease;
    margin-left: auto;
    flex-shrink: 0;
  }

  .midi-selectors.unconnected {
    border-color: var(--color-orange);
    box-shadow: 0 0 10px var(--color-orange-glow);
    animation: midi-warning-pulse 2.2s infinite ease-in-out;
  }

  @keyframes midi-warning-pulse {
    0%,
    100% {
      border-color: var(--color-orange);
      box-shadow: 0 0 6px var(--color-orange-glow);
    }
    50% {
      border-color: var(--color-orange-light);
      box-shadow: 0 0 14px var(--color-orange-glow);
    }
  }

  .selector-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .selector-group label {
    font-family: "Chakra Petch", monospace;
    font-size: 11px;
    font-weight: 700;
    color: var(--color-orange-text);
    letter-spacing: 0.5px;
    transition: color 0.15s ease;
  }

  .selector-group select {
    background: var(--bg-surface);
    color: #cbd5e1;
    border: 1px solid var(--border-box);
    padding: 4px 8px;
    font-size: 11px;
    font-family: "JetBrains Mono", monospace;
    border-radius: 3px;
    max-width: 170px;
    outline: none;
    cursor: pointer;
  }

  .selector-group select:focus {
    border-color: var(--color-orange);
  }

  .icon-btn {
    background: var(--bg-surface);
    border: 1px solid var(--border-box);
    color: #a0aec0;
    border-radius: 3px;
    padding: 4px 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .icon-btn:hover:not(:disabled) {
    color: var(--color-orange-text);
    border-color: var(--color-orange);
  }

  .navbar-center-patch {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    max-width: calc(100% - 660px);
    min-width: 0;
    pointer-events: auto;
  }

  .patch-heading {
    margin: 0;
    font-family: "Chakra Petch", monospace;
    font-size: 32px;
    font-weight: 700;
    line-height: 36px;
    color: #f8fafc;
    letter-spacing: 0.8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
