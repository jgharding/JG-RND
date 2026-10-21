<script lang="ts">
  import { onMount } from "svelte";
  import { midiStore, selectedPatch } from "../stores";
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
</script>

<header class="navbar">
  <!-- Brand / Title -->
  <div class="brand">
    <div class="brand-badge">JG-RND</div>
    <div class="brand-text">
      <span class="brand-title">CYMA FORMA RND by CYMA FORMA & BAMBOUNOU</span>
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
