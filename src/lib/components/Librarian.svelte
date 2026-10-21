<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import {
    patchesStore,
    selectedPatchId,
    selectedPatch,
    activeGlobalSettings,
    activeTracks,
    normalizeTracks,
    applyProceduralPatchLevels,
    applyAlteredControls,
    collectCurrentAlteredControls,
    setPatchBaseline,
    activePatchBaseline,
    clearRerolledTracks,
    rerolledTracksStore,
    rerollSeedsStore,
    seedEditorOpenStore,
  } from "../stores";
  import { calculateProceduralLevels } from "../midi/procedural";
  import {
    getAllStoredPatches,
    savePatchToDb,
    deletePatchFromDb,
    getPatchFromDb,
    updatePatchSortOrdersInDb,
  } from "../db/database";
  import { midiManager, formatDefaultPatchName } from "../midi/midiManager";
  import type { PatchRecord } from "../types";
  import {
    hasAlteredControls,
    shouldFlagAlteredControls,
    getDetailedAlteredList,
    syncFlatFieldsFromAltered,
    getRerollCount,
    getRerollSeed,
    topSortOrders,
  } from "../types";
  import { exportPatchesToCsv, importPatchesFromCsv } from "../db/csv";
  import Icon from "./Icon.svelte";

  let searchQuery = $state("");

  // Five 2-character hex boxes for the current seed bytes (b0..b4)
  let seedBytes = $state<string[]>(["00", "00", "00", "00", "00"]);
  let isEditingSeed = false;
  let isCommitting = false;

  // Sync display with currently selected patch seed when user is not actively typing
  $effect(() => {
    if (isEditingSeed) return;
    if ($selectedPatch?.sysexHex) {
      const clean = $selectedPatch.sysexHex.replace(/[\s,]/g, "").toUpperCase();
      if (clean.startsWith("F06F627810") && clean.length >= 22) {
        seedBytes = [
          clean.slice(10, 12),
          clean.slice(12, 14),
          clean.slice(14, 16),
          clean.slice(16, 18),
          clean.slice(18, 20),
        ];
      }
    }
  });

  function handleByteFocus(idx: number) {
    isEditingSeed = true;
    setTimeout(() => {
      const input = document.getElementById(
        `seed-byte-${idx}`,
      ) as HTMLInputElement;
      input?.select();
    }, 10);
  }

  function handleByteInput(idx: number, e: Event) {
    isEditingSeed = true;
    const input = e.target as HTMLInputElement;
    let val = input.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (val.length > 2) {
      val = val.slice(0, 2);
    }
    input.value = val;
    seedBytes[idx] = val;

    // Auto-advance to next byte box on 2 characters typed
    if (val.length === 2 && idx < 4) {
      const next = document.getElementById(
        `seed-byte-${idx + 1}`,
      ) as HTMLInputElement;
      if (next) {
        next.focus();
        next.select();
      }
    }
  }

  function handleByteKeyDown(idx: number, e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitSeedChange();
    } else if (
      e.key === "ArrowRight" &&
      (e.target as HTMLInputElement).selectionStart ===
        (e.target as HTMLInputElement).value.length
    ) {
      if (idx < 4) {
        e.preventDefault();
        const next = document.getElementById(
          `seed-byte-${idx + 1}`,
        ) as HTMLInputElement;
        next?.focus();
        next?.select();
      }
    } else if (
      e.key === "ArrowLeft" &&
      (e.target as HTMLInputElement).selectionStart === 0
    ) {
      if (idx > 0) {
        e.preventDefault();
        const prev = document.getElementById(
          `seed-byte-${idx - 1}`,
        ) as HTMLInputElement;
        prev?.focus();
        prev?.select();
      }
    }
  }

  function handleByteBlur(e: FocusEvent) {
    // If focus moved to another seed byte box in the same row, don't commit yet
    const related = e.relatedTarget as HTMLElement | null;
    if (related && related.classList.contains("seed-byte-input")) {
      return;
    }

    commitSeedChange();
  }

  async function commitSeedChange() {
    if (isCommitting) return;
    isCommitting = true;
    isEditingSeed = false;

    try {
      // Normalize each box to 2 valid hex chars and valid 7-bit MIDI range
      const b0Num = Math.min(parseInt(seedBytes[0] || "0", 16) || 0, 0x7f);
      const b1Num = Math.min(parseInt(seedBytes[1] || "0", 16) || 0, 0x7f);
      const b2Num = Math.min(parseInt(seedBytes[2] || "0", 16) || 0, 0x7f);
      const b3Num = Math.min(parseInt(seedBytes[3] || "0", 16) || 0, 0x7f);
      const b4Num = Math.min(parseInt(seedBytes[4] || "0", 16) || 0, 0x0f);

      const b0Hex = b0Num.toString(16).padStart(2, "0").toUpperCase();
      const b1Hex = b1Num.toString(16).padStart(2, "0").toUpperCase();
      const b2Hex = b2Num.toString(16).padStart(2, "0").toUpperCase();
      const b3Hex = b3Num.toString(16).padStart(2, "0").toUpperCase();
      const b4Hex = b4Num.toString(16).padStart(2, "0").toUpperCase();

      seedBytes = [b0Hex, b1Hex, b2Hex, b3Hex, b4Hex];
      const fullHex = `F06F627810${b0Hex}${b1Hex}${b2Hex}${b3Hex}${b4Hex}F7`;
      const seed =
        (b0Num |
          (b1Num << 7) |
          (b2Num << 14) |
          (b3Num << 21) |
          (b4Num << 28)) >>>
        0;

      // If identical to currently selected patch, don't do anything redundant
      if (
        $selectedPatch?.sysexHex.replace(/[\s,]/g, "").toUpperCase() === fullHex
      ) {
        return;
      }

      // Check if patch with this hex or seed already exists in the librarian
      const currentPatches = get(patchesStore);
      const existing = currentPatches.find(
        (p) =>
          p.sysexHex.replace(/[\s,]/g, "").toUpperCase() === fullHex ||
          p.seed === seed,
      );

      let targetPatch: PatchRecord;
      if (existing) {
        targetPatch = existing;
        selectPatch(existing);
      } else {
        targetPatch = {
          id: crypto.randomUUID(),
          name: formatDefaultPatchName(),
          sysexHex: fullHex,
          seed,
          createdAt: Date.now(),
          sortOrder: topSortOrders(get(patchesStore))[0],
          isSaved: false,
          globalSettings: { ...get(activeGlobalSettings) },
          tracks: get(activeTracks).map((t) => ({ ...t })),
        };
        patchesStore.update((list) => [targetPatch, ...list]);
        selectPatch(targetPatch);
      }

      // Transmit the new full phrase to the RND synth
      await midiManager.sendStoredSysEx(fullHex);
    } catch (err) {
      console.error("Error committing manual seed change:", err);
    } finally {
      setTimeout(() => (isCommitting = false), 150);
    }
  }

  onMount(async () => {
    const stored = await getAllStoredPatches();
    if (stored.length > 0) {
      patchesStore.set(stored);
      selectPatch(stored[0]);
    }
  });

  const filteredPatches = $derived(
    $patchesStore.filter((p) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.sysexHex.toLowerCase().includes(q) ||
        p.seed.toString().includes(q)
      );
    }),
  );

  let activeAlteredModalPatch: PatchRecord | null = $state(null);

  function handleOpenAlteredModal(e: MouseEvent, patch: PatchRecord) {
    e.stopPropagation();
    activeAlteredModalPatch = patch;
  }

  function handleCloseAlteredModal() {
    activeAlteredModalPatch = null;
  }

  function selectPatch(patch: PatchRecord) {
    if (patch.altered?.rerolls) {
      rerolledTracksStore.set(
        patch.altered.rerolls.map((r) => getRerollCount(r)),
      );
      rerollSeedsStore.set(
        [0, 1, 2, 3].map(
          (i) => getRerollSeed(patch.altered?.rerollSeeds?.[i]) ?? null,
        ),
      );
    } else {
      clearRerolledTracks();
    }
    selectedPatchId.set(patch.id);
    setPatchBaseline(patch);

    // Calculate procedural levels from seed using MT19937 PRNG simulation
    const procedural = calculateProceduralLevels(patch.seed);
    applyProceduralPatchLevels(procedural);

    // Populate Right Panel editor controls with this patch's stored parameters or fallback defaults
    const g = patch.globalSettings || {
      bpm: 120,
      root: 0,
      octave: 4,
      scale: 0,
      type: 0,
    };
    activeGlobalSettings.set({ octave: 4, ...g });

    const trks =
      patch.tracks && patch.tracks.length > 0
        ? patch.tracks
        : [
            {
              track: 0,
              active: true,
              role: 0,
              mode: 0,
              engine: "FM",
              muted: false,
              soloed: false,
            },
            {
              track: 1,
              active: true,
              role: 1,
              mode: 0,
              engine: "Acid (303)",
              muted: false,
              soloed: false,
            },
            {
              track: 2,
              active: true,
              role: 2,
              mode: 1,
              engine: "Harmonic",
              muted: false,
              soloed: false,
            },
            {
              track: 3,
              active: true,
              role: 3,
              mode: 0,
              engine: "Noise",
              muted: false,
              soloed: false,
            },
          ];
    const base = get(activePatchBaseline);
    activeTracks.set(
      normalizeTracks(trks).map((t, idx) => ({
        ...t,
        originalEngine:
          t.originalEngine ||
          patch.originalTracks?.[idx]?.originalEngine ||
          patch.originalTracks?.[idx]?.engine ||
          base?.enginePerTrack?.[idx] ||
          t.engine,
      })),
    );

    // If the patch has saved altered controls, apply them
    if (patch.altered) {
      applyAlteredControls(patch.altered);
    }
  }

  async function handleRowClick(patch: PatchRecord) {
    let target = patch;
    if (typeof window !== "undefined" && typeof indexedDB !== "undefined") {
      try {
        const saved = await getPatchFromDb(patch.id);
        if (saved) {
          target = saved;
          patchesStore.update((list) =>
            list.map((p) => (p.id === saved.id ? saved : p)),
          );
        }
      } catch (e) {
        console.error("Error loading saved patch from IndexedDB:", e);
      }
    }
    selectPatch(target);
    await midiManager.loadPatchWithOverrides(target);
  }

  async function handleSaveRow(e: MouseEvent, patch: PatchRecord) {
    e.stopPropagation();
    try {
      let current = $patchesStore.find((p) => p.id === patch.id) || patch;
      if ($selectedPatchId === patch.id) {
        const altered = collectCurrentAlteredControls();
        const base = get(activePatchBaseline);
        const origGlobals =
          current.originalGlobalSettings ||
          (base && !base.provisional
            ? {
                bpm: base.bpm ?? 120,
                root: base.root ?? 0,
                octave: base.octave ?? 4,
                scale: base.scale ?? 0,
                type: get(activeGlobalSettings).type ?? 0,
              }
            : undefined);

        const liveTracks = get(activeTracks);
        const origTracks =
          current.originalTracks ||
          (base?.enginePerTrack
            ? base.enginePerTrack.map((eng, idx) => ({
                track: idx,
                active: liveTracks[idx]?.active ?? false,
                role: idx,
                mode: 0,
                engine: eng || "FM",
                originalEngine: eng || "FM",
              }))
            : undefined);

        current = {
          ...current,
          altered: hasAlteredControls(altered) ? altered : undefined,
          globalSettings: { ...get(activeGlobalSettings) },
          originalGlobalSettings: origGlobals,
          originalTracks: origTracks,
          tracks: get(activeTracks).map((t) => ({ ...t })),
        };
      }
      const updated = syncFlatFieldsFromAltered({ ...current, isSaved: true });
      await savePatchToDb(updated);
      patchesStore.update((list) =>
        list.map((p) => (p.id === patch.id ? updated : p)),
      );
    } catch (err) {
      console.error("Error saving patch to IndexedDB:", err);
    }
  }

  // ===== Drag & drop reordering =====
  // A row only becomes draggable when the press starts outside the name field / buttons,
  // so renaming and text selection keep working.
  let dragArmedId = $state<string | null>(null);
  let draggingId = $state<string | null>(null);
  let dropTarget = $state<{ id: string; after: boolean } | null>(null);

  function handleRowPointerDown(e: PointerEvent, patch: PatchRecord) {
    const t = e.target as HTMLElement;
    dragArmedId = t.closest("input, button") ? null : patch.id;
  }

  function handleDragStart(e: DragEvent, patch: PatchRecord) {
    draggingId = patch.id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", patch.id);
    }
  }

  function handleDragOver(e: DragEvent, patch: PatchRecord) {
    if (!draggingId || draggingId === patch.id) {
      dropTarget = null;
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropTarget = {
      id: patch.id,
      after: e.clientY > rect.top + rect.height / 2,
    };
  }

  async function handleDrop(e: DragEvent, patch: PatchRecord) {
    e.preventDefault();
    const fromId = draggingId;
    const after = dropTarget?.id === patch.id ? dropTarget.after : false;
    handleDragEnd();
    if (!fromId || fromId === patch.id) return;

    // Reorder the full library (works with a search filter active, as rows are matched by id)
    const list = [...$patchesStore];
    const fromIdx = list.findIndex((p) => p.id === fromId);
    if (fromIdx < 0) return;
    const [moved] = list.splice(fromIdx, 1);
    let toIdx = list.findIndex((p) => p.id === patch.id);
    if (toIdx < 0) return;
    if (after) toIdx++;
    list.splice(toIdx, 0, moved);

    const renumbered = list.map((p, i) => ({ ...p, sortOrder: i }));
    patchesStore.set(renumbered);
    try {
      await updatePatchSortOrdersInDb(
        renumbered.map((p) => ({ id: p.id, sortOrder: p.sortOrder })),
      );
    } catch (err) {
      console.error("Error saving library order to IndexedDB:", err);
    }
  }

  function handleDragEnd() {
    draggingId = null;
    dragArmedId = null;
    dropTarget = null;
    stopAutoScroll();
  }

  // Auto-scroll while dragging near the top or bottom edge of the list. Speed ramps up
  // towards the edge; dragover fires only every ~50 ms, so a frame loop does the scrolling.
  const AUTO_SCROLL_ZONE = 64; // px from the edge where scrolling starts
  const AUTO_SCROLL_MAX_SPEED = 18; // px per frame at the very edge
  let tableWrapper = $state<HTMLDivElement | null>(null);
  let autoScrollSpeed = 0;
  let autoScrollFrame: number | null = null;

  function handleListDragOver(e: DragEvent) {
    if (!draggingId || !tableWrapper) return;
    const rect = tableWrapper.getBoundingClientRect();
    const fromTop = e.clientY - rect.top;
    const fromBottom = rect.bottom - e.clientY;
    if (fromTop < AUTO_SCROLL_ZONE) {
      autoScrollSpeed = -AUTO_SCROLL_MAX_SPEED * (1 - Math.max(fromTop, 0) / AUTO_SCROLL_ZONE);
    } else if (fromBottom < AUTO_SCROLL_ZONE) {
      autoScrollSpeed = AUTO_SCROLL_MAX_SPEED * (1 - Math.max(fromBottom, 0) / AUTO_SCROLL_ZONE);
    } else {
      autoScrollSpeed = 0;
    }
    if (autoScrollSpeed !== 0 && autoScrollFrame === null) {
      autoScrollFrame = requestAnimationFrame(autoScrollStep);
    }
  }

  function autoScrollStep() {
    if (!tableWrapper || autoScrollSpeed === 0 || !draggingId) {
      autoScrollFrame = null;
      return;
    }
    tableWrapper.scrollTop += autoScrollSpeed;
    autoScrollFrame = requestAnimationFrame(autoScrollStep);
  }

  function stopAutoScroll() {
    autoScrollSpeed = 0;
    if (autoScrollFrame !== null) {
      cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = null;
    }
  }

  function handleListDragLeave(e: DragEvent) {
    // Leaving the list entirely (not just moving between rows) stops scrolling
    if (!tableWrapper?.contains(e.relatedTarget as Node | null)) stopAutoScroll();
  }

  async function handleDeleteRow(e: MouseEvent, patch: PatchRecord) {
    e.stopPropagation();
    try {
      const wasPlaying = $selectedPatchId === patch.id;
      // Neighbour in the list as displayed: the row below, or the row above if it was the bottom row
      const visible = filteredPatches;
      const idx = visible.findIndex((p) => p.id === patch.id);
      const neighbour =
        idx >= 0 ? (visible[idx + 1] ?? visible[idx - 1]) : undefined;

      await deletePatchFromDb(patch.id);
      patchesStore.update((list) => list.filter((p) => p.id !== patch.id));

      if (wasPlaying) {
        const next = neighbour ?? $patchesStore[0];
        if (next) {
          // Send the next patch (with its saved overrides) to the RND
          await handleRowClick(next);
        } else {
          // Library is now empty: generate a fresh patch on the RND (same as the hardware button)
          selectedPatchId.set(null);
          await midiManager.triggerHardware();
        }
      }
    } catch (err) {
      console.error("Error deleting patch from IndexedDB:", err);
    }
  }

  function handleNameInput(patch: PatchRecord, currentVal: string) {
    const trimmed = currentVal.trim();
    if (patch.isSaved && trimmed !== patch.name) {
      patchesStore.update((list) =>
        list.map((p) => (p.id === patch.id ? { ...p, isSaved: false } : p)),
      );
    } else if (!patch.isSaved && trimmed === patch.name) {
      patchesStore.update((list) =>
        list.map((p) => (p.id === patch.id ? { ...p, isSaved: true } : p)),
      );
    }
  }

  async function handleNameCommit(
    patch: PatchRecord,
    currentVal: string,
    inputEl?: HTMLInputElement,
  ) {
    const trimmed = currentVal.trim();
    const finalName = trimmed || patch.name;

    if (inputEl && !trimmed) {
      inputEl.value = patch.name;
    }

    const current = $patchesStore.find((p) => p.id === patch.id) || patch;
    if (current.isSaved && finalName === patch.name) return;

    const updated: PatchRecord = syncFlatFieldsFromAltered({
      ...current,
      name: finalName,
      isSaved: true,
    });
    patchesStore.update((list) =>
      list.map((p) => (p.id === patch.id ? updated : p)),
    );

    try {
      await savePatchToDb(updated);
    } catch (err) {
      console.error("Error saving patch to IndexedDB on commit:", err);
    }
  }

  function handleNameKeyDown(e: KeyboardEvent, patch: PatchRecord) {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      const input = e.target as HTMLInputElement;
      input.value = patch.name;
      input.blur();
    }
  }

  let fileInput: HTMLInputElement;
  let showImportModal = $state(false);
  let pendingImportMode = $state<"append" | "replace">("append");

  function handleExportCsv() {
    exportPatchesToCsv($patchesStore);
  }

  function handleGetResetSeed(e?: Event) {
    if (e) e.stopPropagation();
    activeAlteredModalPatch = null;
    clearRerolledTracks();
    midiManager.getAndResetSeed();
  }

  function handleTriggerImport() {
    showImportModal = true;
  }

  function handleCloseModal() {
    showImportModal = false;
  }

  function handleSelectMode(mode: "append" | "replace") {
    pendingImportMode = mode;
    showImportModal = false;
    // Synchronously open native file picker from this user gesture
    fileInput?.click();
  }

  function handleWindowKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (activeAlteredModalPatch) {
        handleCloseAlteredModal();
      } else if (showImportModal) {
        showImportModal = false;
      }
    }
  }

  async function handleFileSelected(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      await importPatchesFromCsv(text, pendingImportMode);
    } catch (err: any) {
      console.error("Import error:", err);
    } finally {
      target.value = "";
    }
  }
</script>

<div class="librarian-container">
  <!-- Librarian Header -->
  <div class="librarian-header">
    <div class="title-row">
      <div class="header-left">
        <Icon name="disk" size={16} color="var(--color-orange-text)" />
        <h2 class="panel-title">PATCH LIBRARIAN</h2>
      </div>
      <div class="patch-count-badge">
        <span>{$patchesStore.length} TOTAL</span>
        <span class="count-divider">|</span>
        <span class="saved-count">
          {$patchesStore.filter((p) => p.isSaved).length} SAVED
        </span>
      </div>
    </div>

    <!-- Search Input -->
    <div class="search-box">
      <Icon name="search" size={13} color="#64748B" />
      <input
        type="text"
        placeholder="Search name, SysEx hex, or seed..."
        bind:value={searchQuery}
        class="search-input"
      />
      {#if searchQuery}
        <button class="clear-search" onclick={() => (searchQuery = "")}
          >×</button
        >
      {/if}
    </div>

    <!-- Manual Seed Hex Editor (5 Evenly Spaced Two-Character Boxes) -->
    <div class="seed-hex-editor" class:open={$seedEditorOpenStore}>
      <button
        type="button"
        class="seed-editor-header"
        onclick={() => seedEditorOpenStore.update((open) => !open)}
        aria-expanded={$seedEditorOpenStore}
        aria-controls="seed-editor-body"
        title={$seedEditorOpenStore
          ? "Hide seed hex editor"
          : "Show seed hex editor"}
      >
        <span class="seed-header-title">
          <span class="seed-chevron" aria-hidden="true">▸</span>
          CURRENT SEED HEX
        </span>
        {#if $seedEditorOpenStore}
          <span class="seed-header-sub">F0 6F 62 78 10 [BYTES 0–4] F7</span>
        {:else}
          <span class="seed-header-compact">{seedBytes.join(" ")}</span>
        {/if}
      </button>
      <div class="seed-editor-slide" id="seed-editor-body">
        <div class="seed-editor-body" inert={!$seedEditorOpenStore}>
          <div class="seed-boxes-row">
            {#each seedBytes as byteVal, idx}
              <div class="seed-box-col">
                <span class="seed-byte-num">B{idx}</span>
                <input
                  id="seed-byte-{idx}"
                  type="text"
                  maxlength="2"
                  class="seed-byte-input"
                  value={byteVal}
                  onfocus={() => handleByteFocus(idx)}
                  oninput={(e) => handleByteInput(idx, e)}
                  onkeydown={(e) => handleByteKeyDown(idx, e)}
                  onblur={handleByteBlur}
                  title="Byte {idx} (00–{idx === 4
                    ? '0F'
                    : '7F'}). Press Enter or click away to send to RND & add to librarian."
                  spellcheck="false"
                  autocomplete="off"
                />
              </div>
            {/each}
          </div>

          <!-- Telemetry Info Row: 32-BIT SEED & FULL PATCH SysEx HEX -->
          <div class="seed-telemetry-row">
            <div class="seed-telem-item">
              <span class="seed-telem-label">32-BIT SEED</span>
              <span class="seed-telem-val seed-val">
                {$selectedPatch
                  ? `0x${$selectedPatch.seed.toString(16).toUpperCase().padStart(8, "0")} (${$selectedPatch.seed})`
                  : "—"}
              </span>
            </div>

            <div class="seed-telem-item right-item">
              <span class="seed-telem-label">FULL PATCH SysEx HEX</span>
              <span class="seed-telem-val hex-val">
                {$selectedPatch
                  ? $selectedPatch.sysexHex
                  : "Waiting for hardware transmission..."}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Action Buttons: IMPORT PATCHES, EXPORT PATCHES, GET & RESET SEED -->
    <div class="csv-actions-row">
      <button
        type="button"
        class="csv-btn import-btn"
        onclick={handleTriggerImport}
        title="Import patches from CSV file"
      >
        <Icon name="download" size={13} />
        <span>IMPORT PATCHES</span>
      </button>

      <button
        type="button"
        class="csv-btn export-btn"
        onclick={handleExportCsv}
        disabled={$patchesStore.length === 0}
        title="Export library to CSV"
      >
        <Icon name="upload" size={13} />
        <span>EXPORT PATCHES</span>
      </button>

      <button
        type="button"
        class="csv-btn get-reset-seed-btn"
        onclick={handleGetResetSeed}
        title="Query active seed from RND hardware (SysEx 0x18) and immediately re-send to reset"
      >
        <Icon name="refresh" size={13} />
        <span>GET + RESET SEED</span>
      </button>
    </div>
  </div>

  <!-- Table Body / List -->
  <div
    class="table-wrapper"
    bind:this={tableWrapper}
    ondragover={handleListDragOver}
    ondragleave={handleListDragLeave}
    role="presentation"
  >
    {#if filteredPatches.length === 0}
      <div class="empty-state">
        <div class="empty-icon-ring">
          <Icon name="pulse" size={28} color="var(--color-orange-text)" />
        </div>
        <h4>NO PATCHES IN LIBRARY</h4>
        <p>
          Press the physical black Trigger button above, or import a CSV file to
          capture patches.
        </p>
      </div>
    {:else}
      <table class="librarian-table">
        <thead>
          <tr>
            <th class="col-sysex">SYSEX STRING (0x10)</th>
            <th class="col-name">PATCH NAME</th>
            <th class="col-actions">ACTIONS</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredPatches as patch (patch.id)}
            <tr
              class="patch-row"
              class:selected={$selectedPatchId === patch.id}
              class:dragging={draggingId === patch.id}
              class:drop-above={dropTarget?.id === patch.id &&
                !dropTarget.after}
              class:drop-below={dropTarget?.id === patch.id && dropTarget.after}
              draggable={dragArmedId === patch.id}
              onpointerdown={(e) => handleRowPointerDown(e, patch)}
              ondragstart={(e) => handleDragStart(e, patch)}
              ondragover={(e) => handleDragOver(e, patch)}
              ondrop={(e) => handleDrop(e, patch)}
              ondragend={handleDragEnd}
              onclick={() => handleRowClick(patch)}
            >
              <!-- 1. SysEx String Column -->
              <td class="col-sysex">
                <span class="sysex-code" title={patch.sysexHex}>
                  {patch.sysexHex}
                </span>
              </td>

              <!-- 2. Patch Name Column (Editable) -->
              <td class="col-name">
                <input
                  type="text"
                  value={patch.name}
                  oninput={(e) =>
                    handleNameInput(
                      patch,
                      (e.target as HTMLInputElement).value,
                    )}
                  onkeydown={(e) => handleNameKeyDown(e, patch)}
                  onblur={(e) =>
                    handleNameCommit(
                      patch,
                      (e.target as HTMLInputElement).value,
                      e.target as HTMLInputElement,
                    )}
                  onclick={(e) => e.stopPropagation()}
                  class="name-input"
                  title="Click to rename (Enter or click away to save)"
                />
              </td>

              <!-- 3. Actions: Save (Disk), Delete (Trash) -->
              <td class="col-actions">
                <div class="actions-group">
                  {#if shouldFlagAlteredControls(patch.altered)}
                    <!-- Non-flashing blue icon directly to the left of the save button -->
                    <button
                      type="button"
                      class="row-btn altered-btn"
                      title="View altered controls for this patch"
                      onclick={(e) => handleOpenAlteredModal(e, patch)}
                    >
                      <Icon name="sliders" size={13} />
                    </button>
                  {/if}

                  <!-- Save (Disk) -->
                  <button
                    class="row-btn save-btn"
                    class:is-saved={patch.isSaved}
                    title={patch.isSaved
                      ? "Saved in IndexedDB"
                      : "Save to IndexedDB"}
                    onclick={(e) => handleSaveRow(e, patch)}
                  >
                    <Icon name={patch.isSaved ? "check" : "disk"} size={13} />
                  </button>

                  <!-- Delete (Trash) -->
                  <button
                    class="row-btn delete-btn"
                    title="Delete patch"
                    onclick={(e) => handleDeleteRow(e, patch)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  <input
    type="file"
    bind:this={fileInput}
    accept=".csv,text/csv"
    onchange={handleFileSelected}
    style="display: none;"
  />
</div>

<svelte:window onkeydown={handleWindowKeyDown} />

{#if showImportModal}
  <div class="modal-backdrop">
    <button
      type="button"
      class="modal-backdrop-hit"
      onclick={handleCloseModal}
      aria-label="Dismiss dialog"
      tabindex="-1"
    ></button>
    <div
      class="modal-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-modal-title"
    >
      <div class="modal-header">
        <div class="modal-title-group">
          <Icon name="upload" size={15} color="var(--color-orange-text)" />
          <h3 id="import-modal-title" class="modal-title">
            Import Patches // SELECT MODE
          </h3>
        </div>
        <button
          type="button"
          class="modal-close-btn"
          onclick={handleCloseModal}
          title="Cancel">×</button
        >
      </div>

      <div class="modal-body">
        <p class="modal-description">
          Choose how you would like to import the CSV file into the patch
          library:
        </p>

        <div class="modal-options">
          <button
            type="button"
            class="modal-mode-btn append-mode"
            onclick={() => handleSelectMode("append")}
          >
            <div class="mode-icon-circle append">
              <span>＋</span>
            </div>
            <div class="mode-text">
              <span class="mode-title">APPEND</span>
              <span class="mode-desc"
                >Keep current patches and add the CSV patches to the library</span
              >
            </div>
          </button>

          <button
            type="button"
            class="modal-mode-btn replace-mode"
            onclick={() => handleSelectMode("replace")}
          >
            <div class="mode-icon-circle replace">
              <span>⟳</span>
            </div>
            <div class="mode-text">
              <span class="mode-title">REPLACE</span>
              <span class="mode-desc"
                >Clear the entire library first, then import the new CSV patches</span
              >
            </div>
          </button>
        </div>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn-cancel" onclick={handleCloseModal}
          >CANCEL</button
        >
      </div>
    </div>
  </div>
{/if}

{#if activeAlteredModalPatch}
  <div class="modal-backdrop">
    <button
      type="button"
      class="modal-backdrop-hit"
      onclick={handleCloseAlteredModal}
      aria-label="Dismiss dialog"
      tabindex="-1"
    ></button>
    <div
      class="modal-card altered-modal-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="altered-modal-title"
    >
      <div class="modal-header">
        <div class="modal-title-group">
          <Icon name="sliders" size={15} color="#38bdf8" />
          <h3 id="altered-modal-title" class="modal-title">
            ALTERED CONTROLS // {activeAlteredModalPatch.name}
          </h3>
        </div>
        <button
          type="button"
          class="modal-close-btn"
          onclick={handleCloseAlteredModal}
          title="Close">×</button
        >
      </div>

      <div class="modal-body altered-modal-body">
        {#if activeAlteredModalPatch.altered && hasAlteredControls(activeAlteredModalPatch.altered)}
          <table class="altered-table">
            <thead>
              <tr>
                <th>SECTION</th>
                <th>CONTROL</th>
                <th>MODIFIED VALUE</th>
              </tr>
            </thead>
            <tbody>
              {#each getDetailedAlteredList(activeAlteredModalPatch.altered) as item}
                <tr>
                  <td class="altered-cat">{item.category}</td>
                  <td class="altered-param">{item.name}</td>
                  <td class="altered-val">{item.value}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <div class="no-altered-state">
            <p>
              No modified controls found for this patch. All parameters match
              seed baseline.
            </p>
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        <button
          type="button"
          class="btn-cancel"
          onclick={handleCloseAlteredModal}>DONE</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .librarian-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-workbench);
    border-right: 2px solid var(--border-box);
    user-select: none;
    overflow: hidden;
  }

  .librarian-header {
    --header-gap: 8px; /* space between the header blocks */
    --search-to-seed-gap: 0px; /* space between the search bar and CURRENT SEED HEX */
    padding: 14px 16px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--header-gap);
  }

  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .panel-title {
    margin: 0;
    font-family: "Chakra Petch", monospace;
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 1.5px;
    color: #f8fafc;
  }

  .patch-count-badge {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    background: var(--bg-sub-box);
    padding: 3px 8px;
    border-radius: 3px;
    border: 1px solid var(--border-subtle);
    display: flex;
    align-items: center;
    gap: 6px;
    color: #94a3b8;
  }

  .count-divider {
    color: #334155;
  }

  .saved-count {
    color: #00e676;
    font-weight: 700;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 6px 10px;
  }

  .search-box:focus-within {
    border-color: var(--color-orange);
  }

  .search-input {
    background: transparent;
    border: none;
    outline: none;
    color: #e2e8f0;
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    width: 100%;
  }

  .search-input::placeholder {
    color: #475569;
  }

  .clear-search {
    background: transparent;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 14px;
    padding: 0 2px;
  }

  .clear-search:hover {
    color: #e2e8f0;
  }

  /* Manual Seed Hex Editor (5 Evenly Spaced Boxes) */
  .seed-hex-editor {
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 6px 10px;
    display: flex;
    flex-direction: column;
    /* Replaces the header gap above this panel with --search-to-seed-gap */
    margin-top: calc(var(--search-to-seed-gap) - var(--header-gap));
  }

  .seed-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }

  .seed-header-title {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: "Chakra Petch", monospace;
    font-size: 9.5px;
    font-weight: 700;
    color: #94a3b8;
    letter-spacing: 0.8px;
  }

  .seed-editor-header:hover .seed-header-title,
  .seed-editor-header:focus-visible .seed-header-title {
    color: var(--color-orange);
  }

  .seed-chevron {
    display: inline-block;
    color: var(--color-orange);
    font-size: 10px;
    transition: transform 0.2s ease;
  }

  .seed-hex-editor.open .seed-chevron {
    transform: rotate(90deg);
  }

  .seed-header-compact {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    font-weight: 700;
    color: var(--color-orange);
    letter-spacing: 1px;
  }

  /* Slides the editor open and closed (grid row 0fr <-> 1fr animates to the content height) */
  .seed-editor-slide {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.22s ease;
  }

  .seed-hex-editor.open .seed-editor-slide {
    grid-template-rows: 1fr;
  }

  .seed-editor-body {
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .seed-hex-editor.open .seed-editor-body {
    padding-top: 6px;
  }

  @media (prefers-reduced-motion: reduce) {
    .seed-editor-slide,
    .seed-chevron {
      transition: none;
    }
  }

  .seed-header-sub {
    font-family: "JetBrains Mono", monospace;
    font-size: 8px;
    font-weight: 600;
    color: #64748b;
    letter-spacing: 0.4px;
  }

  .seed-boxes-row {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    width: 100%;
  }

  .seed-box-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }

  .seed-byte-num {
    font-family: "JetBrains Mono", monospace;
    font-size: 8px;
    font-weight: 700;
    color: #64748b;
    letter-spacing: 0.5px;
  }

  .seed-byte-input {
    width: 100%;
    height: 52px;
    background: var(--bg-surface);
    border: 1.5px solid var(--border-box);
    border-radius: 4px;
    color: var(--color-orange);
    font-family: "Chakra Petch", "JetBrains Mono", monospace;
    font-size: 38px;
    font-weight: 800;
    text-align: center;
    line-height: 1;
    padding: 0;
    outline: none;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
    transition: all 0.12s ease;
    caret-color: var(--color-orange);
  }

  .seed-byte-input:focus {
    border-color: var(--color-orange);
    background: var(--bg-surface-hover);
    box-shadow:
      0 0 12px var(--color-orange-glow),
      inset 0 2px 4px rgba(0, 0, 0, 0.4);
  }

  .seed-byte-input:hover:not(:focus) {
    border-color: var(--border-hover);
  }

  /* Telemetry Info Row inside CURRENT SEED HEX box */
  .seed-telemetry-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-top: 6px;
    border-top: 1px solid var(--border-subtle);
    margin-top: 2px;
  }

  .seed-telem-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-shrink: 0;
  }

  .seed-telem-item.right-item {
    justify-content: flex-end;
  }

  .seed-telem-label {
    font-family: "Chakra Petch", monospace;
    font-size: 8.5px;
    font-weight: 700;
    color: #64748b;
    letter-spacing: 0.6px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .seed-telem-val {
    font-family: "JetBrains Mono", monospace;
    font-size: 9.5px;
    color: #cbd5e1;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .seed-telem-val.seed-val {
    color: #94a3b8;
    font-weight: 700;
  }

  .seed-telem-val.hex-val {
    color: #cbd5e1;
    font-size: 9px;
  }

  /* Table Container */
  .table-wrapper {
    flex: 1;
    overflow-y: auto;
    position: relative;
  }

  .librarian-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    table-layout: fixed;
  }

  .librarian-table thead th {
    position: sticky;
    top: 0;
    background: var(--bg-surface);
    color: #64748b;
    font-family: "Chakra Petch", monospace;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.8px;
    padding: 8px 10px;
    text-align: left;
    border-bottom: 1px solid var(--border-box);
    z-index: 10;
    white-space: nowrap;
  }

  .col-sysex {
    width: 36%;
    padding-left: 12px;
    padding-right: 4px;
  }

  .col-name {
    width: 47%;
    padding-left: 0;
    padding-right: 6px;
  }

  .col-actions {
    width: 17%;
    text-align: right;
    padding-right: 12px;
  }

  .patch-row {
    border-bottom: 1px solid var(--border-subtle);
    cursor: pointer;
    transition: background 0.1s ease;
  }

  .patch-row:hover {
    background: var(--bg-surface-hover);
  }

  .patch-row.dragging {
    opacity: 0.4;
  }

  .patch-row.drop-above {
    box-shadow: inset 0 2px 0 var(--color-orange);
  }

  .patch-row.drop-below {
    box-shadow: inset 0 -2px 0 var(--color-orange);
  }

  .patch-row.selected {
    background: hsla(
      var(--accent-hue),
      var(--accent-sat),
      var(--accent-brightness),
      0.12
    );
    border-left: 3px solid var(--color-orange);
  }

  .sysex-code {
    display: block;
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    color: #94a3b8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .patch-row.selected .sysex-code {
    color: var(--color-orange);
    font-weight: 700;
  }

  .name-input {
    background: transparent;
    border: 1px solid transparent;
    color: #e2e8f0;
    font-family: "Space Grotesk", system-ui, sans-serif;
    font-size: 11px;
    font-weight: 500;
    padding: 4px 6px;
    border-radius: 3px;
    width: 100%;
    box-sizing: border-box;
    outline: none;
    transition: all 0.12s ease;
  }

  .name-input:focus {
    background: #0d0e12;
    border-color: var(--color-orange);
  }

  .actions-group {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    flex-shrink: 0;
  }

  .row-btn {
    background: #181b22;
    border: 1px solid #272c37;
    color: #94a3b8;
    padding: 4px 6px;
    border-radius: 3px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.12s ease;
  }

  .row-btn:hover {
    border-color: #64748b;
    color: #f8fafc;
  }

  .altered-btn {
    color: #38bdf8;
    border-color: rgba(56, 189, 248, 0.45);
    background: rgba(56, 189, 248, 0.08);
  }

  .altered-btn:hover {
    color: #ffffff;
    border-color: #38bdf8;
    background: #0284c7;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.4);
  }

  .save-btn:not(.is-saved) {
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.5);
    background: rgba(239, 68, 68, 0.12);
    box-shadow: 0 0 6px rgba(239, 68, 68, 0.25);
    animation: flash-red-disk 1.1s infinite ease-in-out;
  }

  @keyframes flash-red-disk {
    0%,
    100% {
      color: #ef4444;
      border-color: rgba(239, 68, 68, 0.35);
      background: rgba(239, 68, 68, 0.08);
      box-shadow: 0 0 3px rgba(239, 68, 68, 0.15);
      opacity: 0.75;
    }
    50% {
      color: #ff3333;
      border-color: #ff3333;
      background: rgba(255, 51, 51, 0.3);
      box-shadow: 0 0 12px rgba(255, 51, 51, 0.8);
      opacity: 1;
    }
  }

  .save-btn:not(.is-saved):hover {
    color: #ffffff;
    border-color: #ef4444;
    background: #ef4444;
    box-shadow: 0 0 12px rgba(239, 68, 68, 0.6);
    animation: none;
    opacity: 1;
  }

  .save-btn.is-saved {
    color: #00e676;
    border-color: rgba(0, 230, 118, 0.4);
    background: rgba(0, 230, 118, 0.08);
  }

  .save-btn.is-saved:hover {
    color: #ffffff;
    border-color: #00e676;
    background: #00e676;
  }

  .delete-btn:hover {
    color: #ef4444;
    border-color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 40px 20px;
    color: #64748b;
    gap: 12px;
  }

  .empty-icon-ring {
    width: 54px;
    height: 54px;
    border-radius: 50%;
    background: #171920;
    border: 1px solid #232833;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .empty-state h4 {
    margin: 0;
    font-family: "Chakra Petch", monospace;
    font-size: 13px;
    color: #94a3b8;
    letter-spacing: 1px;
  }

  .empty-state p {
    margin: 0;
    font-size: 11px;
    max-width: 260px;
    line-height: 1.4;
  }

  /* Action Buttons: Get/Reset Seed, Import, Export */
  .csv-actions-row {
    display: flex;
    align-items: center;
    gap: 8px;
    position: relative;
    width: 100%;
  }

  .csv-btn {
    flex: 1;
    min-width: 0;
    background: var(--bg-surface);
    border: 1px solid var(--border-box);
    color: #e2e8f0;
    padding: 6px 6px;
    border-radius: 4px;
    font-family: "Chakra Petch", monospace;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.5px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    transition: all 0.15s ease;
    user-select: none;
    white-space: nowrap;
  }

  .csv-btn:hover:not(:disabled) {
    background: #ffffff;
    border-color: #ffffff;
    color: #0b0d10;
  }

  .get-reset-seed-btn {
    border-color: var(--color-orange);
    color: #0b0d10;
    background: var(--color-orange);
    box-shadow: none;
  }

  .get-reset-seed-btn:hover:not(:disabled) {
    background: #ffffff;
    border-color: #ffffff;
    color: #0b0d10;
    box-shadow: none;
  }

  .get-reset-seed-btn:active:not(:disabled) {
    background: #e2e8f0;
    border-color: #e2e8f0;
    color: #0b0d10;
    transform: translateY(1px);
  }

  .csv-btn:active:not(:disabled) {
    transform: translateY(1px);
  }

  .csv-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Import Modal Dialog */
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(5, 7, 10, 0.78);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    animation: modalFade 0.15s ease-out;
  }

  .modal-backdrop-hit {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    border: none;
    cursor: default;
    padding: 0;
    margin: 0;
  }

  .modal-card {
    position: relative;
    z-index: 1;
    background: #11141b;
    border: 1px solid #28303f;
    border-radius: 6px;
    width: 440px;
    max-width: 90vw;
    box-shadow:
      0 16px 40px rgba(0, 0, 0, 0.7),
      0 0 0 1px rgba(255, 95, 31, 0.15);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: modalPop 0.15s ease-out;
  }

  @keyframes modalFade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes modalPop {
    from {
      transform: scale(0.96);
      opacity: 0;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: #141822;
    border-bottom: 1px solid #202735;
  }

  .modal-title-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .modal-title {
    margin: 0;
    font-family: "Chakra Petch", monospace;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.8px;
    color: #f1f5f9;
  }

  .modal-close-btn {
    background: transparent;
    border: none;
    color: #64748b;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    transition: all 0.1s ease;
  }

  .modal-close-btn:hover {
    color: #f1f5f9;
    background: rgba(255, 255, 255, 0.08);
  }

  .modal-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .modal-description {
    margin: 0;
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    color: #94a3b8;
    line-height: 1.5;
  }

  .modal-options {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 4px;
  }

  .modal-mode-btn {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    background: #151922;
    border: 1.5px solid #252d3c;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
  }

  .modal-mode-btn:hover {
    background: #1c222f;
    border-color: #3b4557;
    transform: translateY(-1px);
  }

  .modal-mode-btn.append-mode:hover {
    border-color: #00e676;
    box-shadow: 0 0 12px rgba(0, 230, 118, 0.15);
  }

  .modal-mode-btn.replace-mode:hover {
    border-color: var(--color-orange);
    box-shadow: 0 0 12px var(--color-orange-glow);
  }

  .mode-icon-circle {
    width: 34px;
    height: 34px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 800;
    flex-shrink: 0;
  }

  .mode-icon-circle.append {
    background: rgba(0, 230, 118, 0.12);
    color: #00e676;
    border: 1px solid rgba(0, 230, 118, 0.3);
  }

  .mode-icon-circle.replace {
    background: hsla(
      var(--accent-hue),
      var(--accent-sat),
      var(--accent-brightness),
      0.12
    );
    color: var(--color-orange-text);
    border: 1px solid
      hsla(var(--accent-hue), var(--accent-sat), var(--accent-brightness), 0.3);
  }

  .mode-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .mode-title {
    font-family: "Chakra Petch", monospace;
    font-size: 13px;
    font-weight: 800;
    letter-spacing: 0.8px;
    color: #f1f5f9;
  }

  .append-mode .mode-title {
    color: #00e676;
  }

  .replace-mode .mode-title {
    color: var(--color-orange-text);
  }

  .mode-desc {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    color: #64748b;
    line-height: 1.3;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    padding: 10px 16px;
    background: #141822;
    border-top: 1px solid #202735;
  }

  .btn-cancel {
    background: transparent;
    border: 1px solid #28303f;
    color: #94a3b8;
    padding: 6px 14px;
    border-radius: 3px;
    font-family: "Chakra Petch", monospace;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.6px;
    cursor: pointer;
    transition: all 0.12s ease;
  }

  .btn-cancel:hover {
    color: #f1f5f9;
    border-color: #475569;
    background: rgba(255, 255, 255, 0.04);
  }

  .altered-modal-card {
    max-width: 500px;
    border-color: rgba(56, 189, 248, 0.3);
    box-shadow:
      0 16px 36px rgba(0, 0, 0, 0.8),
      0 0 16px rgba(56, 189, 248, 0.15);
  }

  .altered-modal-body {
    max-height: 55vh;
    overflow-y: auto;
    padding: 12px 18px;
  }

  .altered-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    margin-top: 4px;
  }

  .altered-table th {
    text-align: left;
    color: #64748b;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 6px 8px;
    border-bottom: 1px solid #202735;
    text-transform: uppercase;
    font-family: "Chakra Petch", monospace;
  }

  .altered-table td {
    padding: 7px 8px;
    border-bottom: 1px solid #181d27;
  }

  .altered-cat {
    font-weight: 700;
    color: #38bdf8;
    font-family: "Chakra Petch", monospace;
    font-size: 11px;
    white-space: nowrap;
  }

  .altered-param {
    color: #cbd5e1;
    font-weight: 500;
  }

  .altered-val {
    font-family: "JetBrains Mono", monospace;
    color: #f8fafc;
    font-weight: 600;
  }

  .no-altered-state {
    padding: 24px 0;
    text-align: center;
    color: #64748b;
    font-size: 12px;
  }
</style>
