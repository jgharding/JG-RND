<script lang="ts">
  import Navbar from "./lib/components/Navbar.svelte";
  import Librarian from "./lib/components/Librarian.svelte";
  import PatchEditor from "./lib/components/PatchEditor.svelte";
  import FirmwareModal from "./lib/components/FirmwareModal.svelte";
  import {
    midiStore,
    midiActivityStore,
    connectedFirmware,
    isFirmwareModalOpen,
  } from "./lib/stores";
  import { LATEST_FIRMWARE_FILE, LATEST_FIRMWARE_STRING } from "./lib/types";
</script>

<div class="app-layout">
  <!-- Top Control Toolbar -->
  <Navbar />

  <!-- Main Split Workstation -->
  <main class="workbench">
    <!-- Left Panel: Librarian -->
    <aside class="panel-left">
      <Librarian />
    </aside>

    <!-- Right Panel: Patch Editor & Hardware Controls -->
    <section class="panel-right">
      <PatchEditor />
    </section>
  </main>


  <!-- Industrial Chassis Footer / Status Bar -->
  <footer class="status-bar">
    <div class="status-left">
      <span class="status-tag"
        >IN CONVERSATION, WE SAVE SERENDIPITY FROM THE VOID</span
      >
      <span class="status-meta">
        <a
          href="https://www.hardingmal.com"
          target="_blank"
          rel="noopener noreferrer"
          class="status-link">hardingmal.com</a
        >
      </span>
    </div>

    <div class="status-center">
      <div class="telemetry">
        <div class="led-block" title="Transmission (TX)">
          <span class="led-label">TX</span>
          <span class="led led-tx" class:active={$midiActivityStore.tx}></span>
        </div>

        <div class="led-block" title="Reception (RX)">
          <span class="led-label">RX</span>
          <span class="led led-rx" class:active={$midiActivityStore.rx}></span>
        </div>

        <div class="connection-status">
          <span
            class="status-dot"
            class:connected={$midiStore.selectedInputId && $midiStore.selectedOutputId}
          ></span>
          <span class="status-text">{$midiStore.statusText}</span>
        </div>
      </div>
    </div>

    <div class="status-right">
      {#if $connectedFirmware}
        {#if $connectedFirmware.needsUpdate}
          <button
            type="button"
            class="status-update-btn"
            onclick={() => isFirmwareModalOpen.set(true)}
            title="Open JG-RND Patcher"
          >
            <span class="pulse-dot"></span>
            UPDATE AVAILABLE: {$connectedFirmware.versionString} → {LATEST_FIRMWARE_STRING}
          </button>
        {:else}
          <span class="status-info"
            >FIRMWARE: {$connectedFirmware.versionString} (LATEST)</span
          >
        {/if}
      {:else}
        <span class="status-info"
          >JG-RND v1.0 - FOR FIRMWARE VERSION: {LATEST_FIRMWARE_FILE}</span
        >
      {/if}
    </div>
  </footer>

  <!-- JG-RND Patcher (opened by clicking the orange chassis surround of the big button) -->
  <FirmwareModal />
</div>

<style>
  .app-layout {
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: var(--bg-app);
  }

  .workbench {
    flex: 1;
    display: grid;
    grid-template-columns: 510px 1fr;
    min-height: 0; /* Important for flex/grid overflow scrolling */
    background: var(--bg-workbench);
  }

  @media (max-width: 1180px) {
    .workbench {
      grid-template-columns: 460px 1fr;
    }
  }

  @media (max-width: 860px) {
    .workbench {
      grid-template-columns: 1fr;
      grid-template-rows: 350px 1fr;
    }
  }

  .panel-left {
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  .panel-right {
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }

  .status-bar {
    position: relative;
    height: 28px;
    background: var(--bg-app);
    border-top: 1px solid var(--border-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    color: #64748b;
    user-select: none;
    z-index: 40;
  }

  .status-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .status-tag {
    background: var(--bg-surface);
    color: var(--color-orange);
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 2px;
    font-size: 9px;
  }

  .status-link {
    color: #64748b;
    text-decoration: none;
    transition: color 0.15s ease;
  }

  .status-link:hover {
    color: var(--color-orange-text);
    text-decoration: underline;
  }

  .status-center {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .telemetry {
    display: flex;
    align-items: center;
    gap: 12px;
    background: #101216;
    padding: 2px 10px;
    border-radius: 4px;
    border: 1px solid #1f232b;
    height: 21px;
    box-sizing: border-box;
  }

  .led-block {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .led-label {
    font-family: "Chakra Petch", monospace;
    font-size: 9px;
    font-weight: 700;
    color: #64748b;
    line-height: 1;
  }

  .led {
    width: 6.5px;
    height: 6.5px;
    border-radius: 50%;
    background: #1e293b;
    border: 1px solid #334155;
    transition: all 0.08s ease;
  }

  .led-tx.active {
    background: var(--color-orange);
    border-color: var(--color-orange-light);
    box-shadow: 0 0 6px var(--color-orange-glow);
  }

  .led-rx.active {
    background: #00e676;
    border-color: #69f0ae;
    box-shadow: 0 0 6px #00e676;
  }

  .connection-status {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 8px;
    border-left: 1px solid #22262d;
  }

  .status-dot {
    width: 6.5px;
    height: 6.5px;
    border-radius: 50%;
    background: #e53e3e;
    box-shadow: 0 0 5px #e53e3e;
  }

  .status-dot.connected {
    background: #00e676;
    box-shadow: 0 0 6px rgba(0, 230, 118, 0.6);
  }


  .status-text {
    font-family: "JetBrains Mono", monospace;
    font-size: 9.5px;
    font-weight: 600;
    color: #94a3b8;
    letter-spacing: 0.5px;
    line-height: 1;
  }

  .status-right {
    color: #475569;
  }


  /* Firmware Update Badge */
  .status-update-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 152, 0, 0.15);
    border: 1px solid #ff9800;
    color: #ff9800;
    font-family: var(--font-mono);
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .status-update-btn:hover {
    background: #ff9800;
    color: #000;
  }

  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ff9800;
    animation: pulse 1.5s infinite;
  }

  @keyframes pulse {
    0% {
      opacity: 0.4;
      transform: scale(0.9);
    }
    50% {
      opacity: 1;
      transform: scale(1.2);
    }
    100% {
      opacity: 0.4;
      transform: scale(0.9);
    }
  }
</style>
