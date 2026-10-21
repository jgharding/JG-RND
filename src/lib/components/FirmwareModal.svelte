<script lang="ts">
  import {
    isFirmwareModalOpen,
    connectedFirmware,
    storageCheckStore,
  } from "../stores";
  import { midiManager } from "../midi/midiManager";
  import {
    describeTypeMask,
    FIRMWARE_PERMISSION_SWITCH,
    LATEST_FIRMWARE_FILE,
    LATEST_FIRMWARE_STRING,
    STOCK_FIRMWARE_FILE,
    STOCK_FIRMWARE_URL,
  } from "../types";
  import { flasherService, type FlasherState } from "../flasher/flasherService";
  import { onDestroy, onMount } from "svelte";

  let flasherState: FlasherState = $state({
    status: "idle",
    stepText: "Ready to connect",
    eraseProgress: 0,
    flashProgress: 0,
    bytesSent: 0,
    totalBytes: 0,
    error: null,
    targetInterfaceName: null,
    log: [],
  });

  let customFile: File | null = $state(null);
  let customBuffer: ArrayBuffer | null = $state(null);
  let customFileName = $state("");
  let isWebUsb = $state(true);
  let showTerminal = $state(false);

  // Patcher mode (FIRMWARE_PERMISSION_SWITCH = false): the user's stock file, patched and verified
  let stockFileName = $state("");
  let patchedBuffer: ArrayBuffer | null = $state(null);
  let patchStatus: "none" | "verifying" | "ok" | "error" = $state("none");
  let patchError = $state("");

  let unsubscribe: (() => void) | null = null;

  onMount(() => {
    isWebUsb = flasherService.isWebUsbSupported();
    unsubscribe = flasherService.subscribe((state) => {
      flasherState = state;
    });

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $isFirmwareModalOpen) closeModal();
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  });

  onDestroy(() => {
    if (unsubscribe) unsubscribe();
  });

  // Connecting through manifesting: the device is in use, so the patcher must stay open
  const isBusy = $derived(
    ["connecting", "connected", "erasing", "flashing", "manifesting"].includes(
      flasherState.status,
    ),
  );

  // Something flashable is ready: the hosted .bin, a custom file, or a verified patched stock file
  const canFlash = $derived(
    FIRMWARE_PERMISSION_SWITCH || !!customBuffer || !!patchedBuffer,
  );

  function closeModal() {
    if (isBusy) return;
    isFirmwareModalOpen.set(false);
    flasherService.resetState();
    customFile = null;
    customBuffer = null;
    customFileName = "";
    clearStockFile();
  }

  async function handleConnectClick() {
    if (isBusy || !canFlash) return;
    if (customBuffer) {
      await flasherService.startFlashProcess(customBuffer);
    } else if (patchedBuffer) {
      await flasherService.startFlashProcess(
        patchedBuffer,
        `patched firmware ${LATEST_FIRMWARE_STRING}`,
      );
    } else {
      await flasherService.startFlashProcess();
    }
  }

  async function handleStockFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    stockFileName = file.name;
    patchedBuffer = null;
    patchStatus = "verifying";
    patchError = "";
    try {
      patchedBuffer = await flasherService.patchStockFirmware(
        await file.arrayBuffer(),
      );
      patchStatus = "ok";
    } catch (err) {
      patchStatus = "error";
      patchError = err instanceof Error ? err.message : String(err);
    }
  }

  function clearStockFile() {
    stockFileName = "";
    patchedBuffer = null;
    patchStatus = "none";
    patchError = "";
  }

  function handleCustomFileChange(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      customFile = input.files[0];
      customFileName = customFile.name;
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          customBuffer = reader.result;
        }
      };
      reader.readAsArrayBuffer(customFile);
    }
  }

  function clearCustomFile() {
    customFile = null;
    customBuffer = null;
    customFileName = "";
  }
</script>

{#if $isFirmwareModalOpen}
  <div
    class="modal-backdrop"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeModal();
    }}
    role="presentation"
  >
    <!-- Modal Dialog Window -->
    <div
      class="modal-window"
      role="dialog"
      tabindex="-1"
      aria-labelledby="patcher-title"
      aria-modal="true"
    >
      <!-- Top Window Chrome / Header -->
      <div class="modal-header">
        <div class="header-left">
          <h2 id="patcher-title" class="modal-title">
            CYMA FORMA RND - AUTOMATIC JG-RND PATCHER
          </h2>
        </div>
        <button
          type="button"
          class="close-btn"
          onclick={closeModal}
          title="Close JG-RND Patcher"
          aria-label="Close"
          disabled={isBusy}
        >
          &times;
        </button>
      </div>

      <!-- Instructions Section -->
      <div class="modal-body">
        {#if $connectedFirmware}
          <div
            class="firmware-alert-banner"
            class:alert-warning={$connectedFirmware.needsUpdate}
            class:alert-success={$connectedFirmware.isUpToDate}
          >
            <div class="alert-icon">
              {#if $connectedFirmware.needsUpdate}
                ⚠️
              {:else}
                ✓
              {/if}
            </div>
            <div class="alert-content">
              {#if $connectedFirmware.needsUpdate}
                <div class="alert-title">FIRMWARE UPDATE RECOMMENDED</div>
                <div class="alert-desc">
                  Your RND synthesizer is currently running <strong
                    >{$connectedFirmware.versionString}</strong
                  >. Update to <strong>{LATEST_FIRMWARE_STRING}</strong> to enable
                  full function.
                </div>
              {:else}
                <div class="alert-title">FIRMWARE UP TO DATE</div>
                <div class="alert-desc">
                  Your RND synthesizer is currently running <strong
                    >{$connectedFirmware.versionString}</strong
                  >. All latest features are active.
                </div>
              {/if}
            </div>
          </div>
        {/if}

        {#if $connectedFirmware && $connectedFirmware.patch >= 19}
          <div class="instructions-panel storage-check-panel">
            <div class="storage-check-header">
              <div class="instructions-heading">
                RND STORAGE CHECK (TYPES TO GENERATE)
              </div>
              <button
                type="button"
                class="storage-check-btn"
                onclick={() => midiManager.requestStorageCheck()}
              >
                READ RND STORAGE
              </button>
            </div>
            {#if $storageCheckStore}
              {@const d = $storageCheckStore}
              <table class="storage-check-table">
                <tbody>
                  <tr
                    ><td>Types in use now (RAM)</td><td
                      >{describeTypeMask(d.ramMask)}</td
                    ></tr
                  >
                  <tr
                    ><td>Types restored at power-on</td><td
                      >{describeTypeMask(d.bootRestoredMask)}</td
                    ></tr
                  >
                  <tr
                    ><td>Types in newest saved record (flash)</td><td
                      >{describeTypeMask(
                        d.latestRecordMask,
                      )}{d.latestRecordValid ? "" : " — record not valid"}</td
                    ></tr
                  >
                  <tr
                    ><td>Types last saved / restored</td><td
                      >{describeTypeMask(d.savedMask)}</td
                    ></tr
                  >
                  <tr
                    ><td>Types used by last generation</td><td
                      >{describeTypeMask(d.lastGenerationMask)}</td
                    ></tr
                  >
                  <tr
                    ><td>Saved records in flash</td><td>{d.recordCount}</td></tr
                  >
                  <tr
                    ><td>Type changes since power-on</td><td
                      >{d.cc14SaveRequests ?? "none"}</td
                    ></tr
                  >
                  <tr
                    ><td>Flash writes since power-on</td><td
                      >{d.recordWrites ?? "none"}</td
                    ></tr
                  >
                  <tr
                    ><td>Save pending</td><td
                      >{d.saveRequested ? "yes" : "no"}</td
                    ></tr
                  >
                  <tr
                    ><td>Valid record loaded</td><td
                      >{d.validRecordLoaded ? "yes" : "no"}</td
                    ></tr
                  >
                  <tr
                    ><td>Flash saving disabled (error)</td><td
                      >{d.flashError ? "YES" : "no"}</td
                    ></tr
                  >
                </tbody>
              </table>
            {:else}
              <div class="storage-check-empty">
                Press READ RND STORAGE to see what the RND has stored.
              </div>
            {/if}
          </div>
        {/if}

        <div class="instructions-panel">
          {#if FIRMWARE_PERMISSION_SWITCH}
            <div class="instructions-heading">
              THSI CUSTOM FIRMWARE IS BASED ON THE <a
                href={STOCK_FIRMWARE_URL}
                >ORIGINAL CYMA FORMA RND FIRMWARE</a
              >, WHICH IS USED WITH KIND PERMISSION FROM CYMA FORMA
            </div>
          {:else}
            <div class="instructions-heading">
              THIS PATCHER ADDS THE JG-RND CHANGES TO YOUR OWN COPY OF THE <a
                href={STOCK_FIRMWARE_URL}
                target="_blank"
                rel="noopener">ORIGINAL CYMA FORMA RND FIRMWARE</a
              >. NO CYMA FORMA FIRMWARE IS HOSTED HERE.
            </div>
          {/if}
          <div class="instructions-heading">Instructions:</div>
          <ol class="instructions-list">
            <li>
              This utility needs a browser with WebUSB support: an up-to-date
              Google Chrome, Microsoft Edge or Opera on desktop. It will not
              work in Firefox or Safari.
            </li>
            {#if !FIRMWARE_PERMISSION_SWITCH}
              <li>
                Download the official <strong>{STOCK_FIRMWARE_FILE}</strong>
                from <a href={STOCK_FIRMWARE_URL} target="_blank" rel="noopener"
                  >Cyma Forma</a
                >, then choose it in the programming section below. It is checked
                and patched to {LATEST_FIRMWARE_STRING} in your browser.
              </li>
            {/if}
            <li>
              Locate the <strong>BOOT</strong> button of the RND synth. It is on
              the edge of the circuit board, on the opposite side from the connectors.
            </li>
            <li>
              Enter boot mode by holding down the <strong>BOOT</strong> button
              while connecting the RND synth to your computer. Release the
              <strong>BOOT</strong> button once the synth is plugged in. You are
              in boot mode when the power LED is static and the tempo LED is off.
            </li>
            <li>
              Click the orange <strong>"CONNECT"</strong> button in the programming
              section below.
            </li>
            <li>If necessary, grant the browser permission to use WebUSB.</li>
            <li>
              In the dialog that pops up, select <strong
                >"DFU in FS Mode"</strong
              > and connect.
            </li>
            <li>
              The latest <strong>JG-RND</strong> firmware will be installed.
            </li>
          </ol>
        </div>

        <!-- Programming & Configuration Section -->
        <div class="programming-section">
          <div class="section-title">Programming Section</div>

          <!-- Firmware Target Badge -->
          <div class="firmware-target-box">
            <div class="target-label">Target Firmware Binary:</div>
            <div class="target-value">
              {#if customFileName}
                <span class="custom-tag">CUSTOM FILE:</span>
                {customFileName} ({customBuffer
                  ? (customBuffer.byteLength / 1024).toFixed(1)
                  : 0} KB)
                <button
                  type="button"
                  class="reset-file-btn"
                  onclick={clearCustomFile}
                  title="Reset to default JG-RND firmware"
                  >Reset to Default</button
                >
              {:else if FIRMWARE_PERMISSION_SWITCH}
                <span class="default-tag">LATEST JG-RND FIRMWARE</span>
                {LATEST_FIRMWARE_FILE}
                <label class="custom-file-label">
                  Choose Custom .bin
                  <input
                    type="file"
                    accept=".bin"
                    onchange={handleCustomFileChange}
                    class="hidden-file-input"
                  />
                </label>
              {:else}
                {#if patchStatus === "ok"}
                  <span class="default-tag">✓ VERIFIED</span>
                  {stockFileName} → {LATEST_FIRMWARE_STRING}
                {:else if patchStatus === "verifying"}
                  <span class="custom-tag">CHECKING:</span>
                  {stockFileName}...
                {:else}
                  <span class="custom-tag">STEP 1:</span>
                  <a href={STOCK_FIRMWARE_URL} target="_blank" rel="noopener"
                    >Download {STOCK_FIRMWARE_FILE}</a
                  >
                {/if}
                <label class="custom-file-label stock-file-label">
                  {patchStatus === "ok" ? "Change" : "Choose"}
                  {STOCK_FIRMWARE_FILE}
                  <input
                    type="file"
                    accept=".bin"
                    onchange={handleStockFileChange}
                    class="hidden-file-input"
                  />
                </label>
                <label class="custom-file-label">
                  Choose Custom .bin
                  <input
                    type="file"
                    accept=".bin"
                    onchange={handleCustomFileChange}
                    class="hidden-file-input"
                  />
                </label>
              {/if}
            </div>
            {#if !FIRMWARE_PERMISSION_SWITCH && !customFileName && patchStatus === "error"}
              <div class="patch-error">&cross; {stockFileName}: {patchError}</div>
            {/if}
          </div>

          <!-- Browser Compatibility Notice -->
          {#if !isWebUsb}
            <div class="browser-warning">
              &excl; WebUSB is not supported in this browser. Please open this
              app in Chrome, Edge or Opera on desktop to flash firmware.
            </div>
          {/if}

          <!-- Connection & Action Row -->
          <div class="connect-action-row">
            {#if flasherState.status === "idle" || flasherState.status === "ready" || flasherState.status === "error"}
              <button
                type="button"
                class="orange-connect-btn"
                onclick={handleConnectClick}
                disabled={!isWebUsb || !canFlash}
                title={canFlash ? undefined : `Choose ${STOCK_FIRMWARE_FILE} first`}
              >
                CONNECT
              </button>
            {:else if flasherState.status === "connecting"}
              <button type="button" class="orange-connect-btn busy" disabled>
                <span class="spinner"></span> CONNECTING...
              </button>
            {:else if flasherState.status === "connected"}
              <button type="button" class="orange-connect-btn busy" disabled>
                INITIALIZING...
              </button>
            {:else if flasherState.status === "erasing" || flasherState.status === "flashing" || flasherState.status === "manifesting"}
              <button type="button" class="orange-connect-btn busy" disabled>
                <span class="spinner"></span> FLASHING...
              </button>
            {:else if flasherState.status === "complete"}
              <button
                type="button"
                class="orange-connect-btn complete-btn"
                onclick={closeModal}
              >
                CLOSE UPDATER
              </button>
            {/if}

            <div class="status-summary">
              <span class="status-label">STATUS:</span>
              <span
                class="status-text"
                class:status-complete={flasherState.status === "complete"}
                class:status-err={flasherState.status === "error"}
              >
                {flasherState.stepText}
              </span>
            </div>
          </div>

          <!-- Completion Banner in BLUE -->
          {#if flasherState.status === "complete"}
            <div class="update-complete-banner">
              <div class="complete-text">UPDATE COMPLETE</div>
              <div class="complete-subtext">
                The synth has been successfully flashed with the latest JG-RND
                firmware and reset.
              </div>
            </div>
          {/if}

          <!-- Hardware DFU Configuration Details (when active/connected) -->
          {#if flasherState.targetInterfaceName || flasherState.status === "erasing" || flasherState.status === "flashing" || flasherState.status === "manifesting" || flasherState.status === "complete"}
            <div class="dfu-details-box">
              <div class="detail-row">
                <span class="detail-key">TARGET INTERFACE:</span>
                <span class="detail-val highlight"
                  >{flasherState.targetInterfaceName ||
                    'DFU: cfg=1, intf=0, alt=0, name="@Internal Flash /0x08000000/16*128Kg"'}</span
                >
              </div>
              <div class="detail-grid">
                <div>
                  <span class="detail-key">TRANSFER SIZE:</span>
                  <span class="detail-val">1024</span>
                </div>
                <div>
                  <span class="detail-key">START ADDRESS:</span>
                  <span class="detail-val">0x08000000</span>
                </div>
                <div>
                  <span class="detail-key">UPLOAD SIZE:</span>
                  <span class="detail-val">2097152</span>
                </div>
                <div>
                  <span class="detail-key">OPTION BYTES:</span>
                  <span class="detail-val muted">SKIPPED (alt=1 safe)</span>
                </div>
              </div>
            </div>
          {/if}

          <!-- Dual Progress Bars for Erasing & Flashing -->
          {#if flasherState.status === "erasing" || flasherState.status === "flashing" || flasherState.status === "manifesting" || flasherState.status === "complete"}
            <div class="progress-container">
              <!-- Erase Progress -->
              <div class="progress-group">
                <div class="progress-labels">
                  <span class="p-title">1. FLASH MEMORY ERASE</span>
                  <span class="p-val">{flasherState.eraseProgress}%</span>
                </div>
                <div class="progress-track">
                  <div
                    class="progress-fill erase-fill"
                    style="width: {flasherState.eraseProgress}%;"
                  ></div>
                </div>
              </div>

              <!-- Flash Progress -->
              <div class="progress-group">
                <div class="progress-labels">
                  <span class="p-title">2. FIRMWARE WRITE</span>
                  <span class="p-val"
                    >{flasherState.flashProgress}% {#if flasherState.totalBytes > 0}({Math.round(
                        flasherState.bytesSent / 1024,
                      )} KB / {Math.round(flasherState.totalBytes / 1024)} KB){/if}</span
                  >
                </div>
                <div class="progress-track">
                  <div
                    class="progress-fill write-fill"
                    style="width: {flasherState.flashProgress}%;"
                  ></div>
                </div>
              </div>
            </div>
          {/if}

          <!-- Error Box -->
          {#if flasherState.error}
            <div class="error-banner">
              <div class="err-title">&cross; Flash Error:</div>
              <div class="err-body">{flasherState.error}</div>
            </div>
          {/if}

          <!-- Terminal Log Toggle -->
          <div class="terminal-toggle-row">
            <button
              type="button"
              class="terminal-toggle-btn"
              onclick={() => (showTerminal = !showTerminal)}
            >
              {showTerminal ? "▼ Hide Console Log" : "► Show Console Log"} ({flasherState
                .log.length} events)
            </button>
          </div>

          {#if showTerminal}
            <div class="terminal-log">
              {#each flasherState.log as entry}
                <div class="log-line">{entry}</div>
              {/each}
              {#if flasherState.log.length === 0}
                <div class="log-line muted">
                  No activity recorded yet. Click CONNECT to begin.
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(8, 10, 14, 0.82);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    padding: 16px;
    user-select: none;
  }

  .modal-window {
    background: #15181e;
    border: 1px solid #2e3440;
    border-radius: 12px;
    box-shadow:
      0 20px 50px rgba(0, 0, 0, 0.8),
      0 0 0 1px rgba(255, 255, 255, 0.05);
    width: 100%;
    max-width: 680px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: #e2e8f0;
    font-family:
      "Space Grotesk",
      -apple-system,
      BlinkMacSystemFont,
      sans-serif;
  }

  /* Header */
  .modal-header {
    background: #1a1e26;
    border-bottom: 1px solid #2e3440;
    padding: 14px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-left {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .modal-title {
    margin: 0;
    font-family: "Chakra Petch", sans-serif;
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #f8fafc;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
    transition: color 0.15s ease;
  }

  .close-btn:hover:not(:disabled) {
    color: #ffffff;
  }

  .close-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  /* Body */
  .modal-body {
    padding: 20px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  /* Instructions */
  .instructions-panel {
    background: #111318;
    border: 1px solid #222730;
    border-radius: 8px;
    padding: 14px 18px;
  }

  .storage-check-panel {
    margin-bottom: 12px;
  }

  .storage-check-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .storage-check-btn {
    font-family: "Chakra Petch", sans-serif;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #e2e8f0;
    background: #1a1e26;
    border: 1px solid #334155;
    border-radius: 4px;
    padding: 4px 10px;
    cursor: pointer;
  }

  .storage-check-btn:hover {
    border-color: #64748b;
  }

  .storage-check-table {
    width: 100%;
    border-collapse: collapse;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.75rem;
    color: #cbd5e1;
  }

  .storage-check-table td {
    padding: 3px 0;
    border-bottom: 1px solid #1e232c;
  }

  .storage-check-table td:last-child {
    text-align: right;
    color: #e2e8f0;
  }

  .storage-check-empty {
    font-size: 0.75rem;
    color: #64748b;
  }

  .instructions-heading {
    font-family: "Chakra Petch", sans-serif;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #94a3b8;
    margin-bottom: 8px;
  }

  .instructions-list {
    margin: 0;
    padding-left: 20px;
    font-size: 0.82rem;
    line-height: 1.5;
    color: #cbd5e1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .instructions-list li {
    padding-left: 4px;
  }

  .instructions-list strong {
    color: #ff9800;
  }

  /* Programming Section */
  .programming-section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .section-title {
    font-family: "Chakra Petch", sans-serif;
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #f1f5f9;
    border-bottom: 1px solid #2e3440;
    padding-bottom: 6px;
  }

  /* Target Firmware */
  .firmware-target-box {
    background: #111419;
    border: 1px solid #262c37;
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .target-label {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.7rem;
    color: #64748b;
    text-transform: uppercase;
  }

  .target-value {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-family: "JetBrains Mono", monospace;
    color: #e2e8f0;
  }

  .default-tag {
    color: #10b981;
    font-weight: 700;
    font-size: 0.7rem;
  }

  .custom-tag {
    color: #f59e0b;
    font-weight: 700;
    font-size: 0.7rem;
  }

  .custom-file-label {
    margin-left: auto;
    font-size: 0.72rem;
    color: #94a3b8;
    background: #1e2430;
    border: 1px solid #333d4f;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .custom-file-label:hover {
    background: #2a3344;
    color: #ffffff;
  }

  .hidden-file-input {
    display: none;
  }

  .stock-file-label {
    color: #ff9800;
    border-color: rgba(255, 152, 0, 0.45);
  }

  .stock-file-label + .custom-file-label {
    margin-left: 0;
  }

  .target-value a {
    color: #38bdf8;
  }

  .patch-error {
    color: #f87171;
    font-size: 0.75rem;
  }

  .reset-file-btn {
    margin-left: auto;
    font-size: 0.72rem;
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.25);
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  .browser-warning {
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #fca5a5;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 500;
  }

  /* Connect Action Row */
  .connect-action-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 4px;
  }

  .orange-connect-btn {
    background: linear-gradient(180deg, #ff7a1a 0%, #e65c00 100%);
    color: #ffffff;
    font-family: "Chakra Petch", sans-serif;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    border: 1px solid #ff9240;
    border-radius: 8px;
    padding: 12px 28px;
    cursor: pointer;
    box-shadow:
      0 4px 14px rgba(230, 92, 0, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);
    transition:
      transform 0.08s ease,
      filter 0.15s ease;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .orange-connect-btn:hover:not(:disabled) {
    filter: brightness(1.1);
    transform: translateY(-1px);
  }

  .orange-connect-btn:active:not(:disabled) {
    transform: translateY(1px);
    filter: brightness(0.95);
  }

  .orange-connect-btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
    box-shadow: none;
  }

  .orange-connect-btn.complete-btn {
    background: linear-gradient(180deg, #0284c7 0%, #0369a1 100%);
    border-color: #38bdf8;
    box-shadow: 0 4px 14px rgba(2, 132, 199, 0.4);
  }

  .status-summary {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .status-label {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.65rem;
    color: #64748b;
    letter-spacing: 0.05em;
  }

  .status-text {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.85rem;
    font-weight: 600;
    color: #cbd5e1;
  }

  .status-text.status-complete {
    color: #38bdf8;
    font-weight: 700;
  }

  .status-text.status-err {
    color: #f87171;
  }

  /* UPDATE COMPLETE Banner in Blue */
  .update-complete-banner {
    background: rgba(14, 165, 233, 0.12);
    border: 2px solid #0284c7;
    border-radius: 8px;
    padding: 16px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    animation: pulseGlow 2s infinite ease-in-out;
  }

  .complete-text {
    font-family: "Chakra Petch", sans-serif;
    font-size: 1.5rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    color: #38bdf8;
    text-shadow: 0 0 15px rgba(56, 189, 248, 0.6);
  }

  .complete-subtext {
    font-size: 0.82rem;
    color: #bae6fd;
    max-width: 460px;
    line-height: 1.4;
  }

  @keyframes pulseGlow {
    0%,
    100% {
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.2);
    }
    50% {
      box-shadow: 0 0 22px rgba(56, 189, 248, 0.5);
    }
  }

  /* DFU Details */
  .dfu-details-box {
    background: #0d0f14;
    border: 1px solid #1f2530;
    border-radius: 6px;
    padding: 10px 14px;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .detail-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .detail-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 6px 12px;
  }

  .detail-key {
    color: #64748b;
  }

  .detail-val {
    color: #cbd5e1;
  }

  .detail-val.highlight {
    color: #38bdf8;
    word-break: break-all;
  }

  .detail-val.muted {
    color: #475569;
  }

  /* Dual Progress Bars */
  .progress-container {
    background: #111419;
    border: 1px solid #232936;
    border-radius: 8px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .progress-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .progress-labels {
    display: flex;
    justify-content: space-between;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
  }

  .p-title {
    color: #94a3b8;
    font-weight: 600;
  }

  .p-val {
    color: #f1f5f9;
  }

  .progress-track {
    height: 10px;
    background: #090b0e;
    border: 1px solid #1e2430;
    border-radius: 5px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    transition: width 0.15s ease;
  }

  .erase-fill {
    background: linear-gradient(90deg, #f59e0b, #eab308);
  }

  .write-fill {
    background: linear-gradient(90deg, #0284c7, #38bdf8);
  }

  /* Error Banner */
  .error-banner {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid #ef4444;
    border-radius: 6px;
    padding: 12px;
    color: #fca5a5;
    font-size: 0.8rem;
  }

  .err-title {
    font-weight: 700;
    margin-bottom: 4px;
  }

  /* Terminal Log */
  .terminal-toggle-row {
    display: flex;
    justify-content: flex-end;
  }

  .terminal-toggle-btn {
    background: transparent;
    border: none;
    color: #64748b;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.72rem;
    cursor: pointer;
    padding: 0;
  }

  .terminal-toggle-btn:hover {
    color: #94a3b8;
  }

  .terminal-log {
    background: #090b0e;
    border: 1px solid #1a202c;
    border-radius: 6px;
    padding: 10px;
    max-height: 120px;
    overflow-y: auto;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .log-line {
    color: #94a3b8;
    line-height: 1.3;
  }

  .log-line.muted {
    color: #475569;
  }

  /* Spinner */
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #ffffff;
    border-radius: 50%;
    display: inline-block;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Firmware Detection Alert Banner */
  .firmware-alert-banner {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
    border-radius: 6px;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .firmware-alert-banner.alert-warning {
    background: rgba(255, 152, 0, 0.12);
    border: 1px solid rgba(255, 152, 0, 0.4);
    color: #ffb74d;
  }

  .firmware-alert-banner.alert-success {
    background: rgba(34, 197, 94, 0.12);
    border: 1px solid rgba(34, 197, 94, 0.4);
    color: #86efac;
  }

  .alert-icon {
    font-size: 1.2rem;
    line-height: 1;
    flex-shrink: 0;
  }

  .alert-content {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .alert-title {
    font-family: "Chakra Petch", sans-serif;
    font-weight: 700;
    letter-spacing: 0.05em;
    font-size: 0.9rem;
  }

  .alert-desc {
    color: #cbd5e1;
    font-size: 0.8rem;
  }

  .alert-desc strong {
    color: #fff;
  }
</style>
