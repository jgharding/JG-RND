<script lang="ts">
  interface Props {
    label: string;
    cc?: number;
    value: number;
    defaultValue?: number;
    min?: number;
    max?: number;
    formatValue?: (val: number) => string | number;
    onchange?: (val: number) => void;
    borderless?: boolean;
  }

  let {
    label,
    cc,
    value = $bindable(100),
    defaultValue = 100,
    min = 0,
    max = 127,
    formatValue,
    onchange,
    borderless = false,
  }: Props = $props();

  let isDragging = $state(false);
  let startY = 0;
  let startVal = 0;

  // Calculate arc and pointer angle (-135deg to +135deg, total 270deg)
  const ratio = $derived(
    Math.max(0, Math.min(1, (value - min) / (max - min || 1))),
  );
  const angle = $derived(-135 + ratio * 270);

  // SVG circular arc dimensions (radius 22px in 56x56 viewport)
  // Circumference = 2 * PI * 22 = 138.23px
  // 270 degrees is 75% of full circle = 103.67px
  const arcLength = 103.67;
  const strokeDashoffset = $derived(arcLength * (1 - ratio));

  // Changed state: true if knob has deviated from its patch default
  const isChanged = $derived(
    defaultValue !== undefined && value !== defaultValue,
  );

  function updateValue(newVal: number) {
    const clamped = Math.max(min, Math.min(max, Math.round(newVal)));
    if (clamped !== value) {
      value = clamped;
      onchange?.(clamped);
    }
  }

  function handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    isDragging = true;
    startY = e.clientY;
    startVal = value;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaY = startY - moveEvent.clientY; // drag up increases
      const sensitivity = (max - min) / 120; // 120px drag covers full range
      updateValue(startVal + deltaY * sensitivity);
    };

    const onPointerUp = () => {
      isDragging = false;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const step = max - min > 50 ? 2 : 1;
    if (e.deltaY < 0) {
      updateValue(value + step);
    } else {
      updateValue(value - step);
    }
  }

  function handleDblClick() {
    updateValue(defaultValue);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      updateValue(value + 1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      updateValue(value - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      updateValue(min);
    } else if (e.key === "End") {
      e.preventDefault();
      updateValue(max);
    }
  }
</script>

<div
  class="knob-container"
  class:borderless
  class:dragging={isDragging}
  class:is-changed={isChanged || isDragging}
  role="slider"
  tabindex="0"
  aria-label="{label}{cc !== undefined ? ` (CC ${cc})` : ''}"
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  onpointerdown={handlePointerDown}
  onwheel={handleWheel}
  ondblclick={handleDblClick}
  onkeydown={handleKeyDown}
  title="{label}{cc !== undefined ? ` (MIDI CC ${cc})` : ''} - Drag up/down or scroll. Double-click to reset."
>
  <!-- Knob Header -->
  <div class="knob-header">
    <span class="knob-label">{label}</span>
    {#if cc !== undefined}
      <span class="knob-cc-badge">CC {cc}</span>
    {/if}
  </div>

  <!-- Rotary Dial Body -->
  <div class="dial-wrapper">
    <!-- SVG Circular Arc Track -->
    <svg class="dial-svg" viewBox="0 0 56 56">
      <!-- Background Arc Track (270 deg) -->
      <circle
        cx="28"
        cy="28"
        r="22"
        class="arc-bg"
        stroke-dasharray="103.67 138.23"
        stroke-dashoffset="0"
        transform="rotate(135 28 28)"
      />
      <!-- Active Value Arc -->
      <circle
        cx="28"
        cy="28"
        r="22"
        class="arc-val"
        stroke-dasharray="103.67 138.23"
        stroke-dashoffset={strokeDashoffset}
        transform="rotate(135 28 28)"
      />
    </svg>

    <!-- 3D Hollow Glass Energy Dome (Lit from right, fills from empty to glowing) -->
    <div class="glass-dome" style="--energy-ratio: {ratio};">
      <div class="dome-chamber"></div>
      <div class="dome-energy-fill"></div>
      <div class="dome-energy-core"></div>
      <div class="dome-energy-bloom"></div>
      <div class="dome-glass-shell"></div>
      <div class="dome-specular-right"></div>
      <div class="dome-specular-pin"></div>
    </div>
  </div>

  <!-- Knob Value Readout -->
  <div class="knob-value-badge">
    <span class="val-num">{formatValue ? formatValue(value) : value}</span>
  </div>
</div>

<style>
  .knob-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    background: var(--bg-sub-box);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    user-select: none;
    cursor: ns-resize;
    outline: none;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
    min-width: 68px;
  }

  .knob-container.borderless {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    padding: 0;
    min-width: unset;
  }

  .knob-container.borderless:hover,
  .knob-container.borderless:focus-visible {
    border-color: transparent;
    box-shadow: none;
  }

  .knob-container.borderless.dragging {
    border-color: transparent;
    box-shadow: none;
  }

  .knob-container:hover,
  .knob-container:focus-visible {
    border-color: var(--border-hover);
    box-shadow: 0 0 8px rgba(0, 0, 0, 0.4);
  }

  .knob-container.dragging {
    border-color: var(--color-orange);
    box-shadow: 0 0 10px var(--color-orange-glow);
  }

  /* Changed state: turns orange control accents to electric blue (#38bdf8) */
  .knob-container.is-changed:not(.borderless) {
    border-color: rgba(56, 189, 248, 0.4);
    box-shadow: 0 0 6px rgba(56, 189, 248, 0.15);
  }

  .knob-container.is-changed:not(.borderless):hover,
  .knob-container.is-changed:not(.borderless):focus-visible {
    border-color: #38bdf8;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
  }

  .knob-container.is-changed.dragging {
    border-color: #38bdf8;
    box-shadow: 0 0 10px rgba(56, 189, 248, 0.35);
  }

  .knob-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    line-height: 1;
    pointer-events: none;
  }

  .knob-label {
    font-family: "Chakra Petch", monospace;
    font-weight: 700;
    font-size: 8px;
    letter-spacing: 0.8px;
    color: #abb2bf;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .knob-cc-badge {
    font-family: "JetBrains Mono", monospace;
    font-size: 7px;
    font-weight: 700;
    color: #64748b;
    background: var(--bg-sub-box);
    padding: 0px 3px;
    border-radius: 2px;
    border: 1px solid var(--border-subtle);
    letter-spacing: 0.4px;
    transition: all 0.15s ease;
  }

  .knob-container.is-changed .knob-cc-badge {
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.15);
    border-color: rgba(56, 189, 248, 0.4);
  }

  .dial-wrapper {
    position: relative;
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .dial-svg {
    position: absolute;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .arc-bg {
    fill: none;
    stroke: var(--border-subtle);
    stroke-width: 3.5;
    stroke-linecap: round;
  }

  .arc-val {
    fill: none;
    stroke: var(--color-orange);
    stroke-width: 3.5;
    stroke-linecap: round;
    transition:
      stroke-dashoffset 0.05s linear,
      stroke 0.15s ease,
      filter 0.15s ease;
    filter: drop-shadow(0 0 2px var(--color-orange-glow));
  }

  .knob-container.is-changed .arc-val {
    stroke: #38bdf8;
    filter: drop-shadow(0 0 3px rgba(56, 189, 248, 0.7));
  }

  /* 3D Hollow Glass Energy Dome */
  .glass-dome {
    position: relative;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    pointer-events: none;
    background: #07090c;
    /* 3D socket depth with light from the right catching outer socket rim */
    box-shadow:
      0 2px 5px rgba(0, 0, 0, 0.8),
      inset 0 1px 2px rgba(0, 0, 0, 0.9),
      1px 0 2px rgba(255, 255, 255, 0.08),
      -1px 0 2px rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  /* Hollow chamber interior */
  .dome-chamber {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(
      circle at 60% 45%,
      #232a34 0%,
      #131820 60%,
      #090b0f 100%
    );
    box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.9);
  }

  /* Internal Energy Volume - spreads through the hollow dome */
  .dome-energy-fill {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    opacity: calc(0.3 + var(--energy-ratio, 0) * 0.7);
    transition: opacity 0.05s linear;
    background: radial-gradient(
      circle at 50% 50%,
      hsl(
          calc(var(--accent-hue) + 12),
          100%,
          calc(60% + var(--energy-ratio, 0) * 25%)
        )
        0%,
      hsl(
          var(--accent-hue),
          var(--accent-sat),
          calc(45% + var(--energy-ratio, 0) * 15%)
        )
        45%,
      hsla(
          var(--accent-hue),
          var(--accent-sat),
          var(--accent-brightness),
          calc(0.3 + var(--energy-ratio, 0) * 0.6)
        )
        75%,
      transparent 100%
    );
    filter: blur(calc(0.5px + (1 - var(--energy-ratio, 0)) * 1px));
  }

  /* Intense hot core at high energy */
  .dome-energy-core {
    position: absolute;
    width: calc(8px + var(--energy-ratio, 0) * 16px);
    height: calc(8px + var(--energy-ratio, 0) * 16px);
    border-radius: 50%;
    opacity: calc(var(--energy-ratio, 0) * 0.95);
    background: radial-gradient(
      circle at 50% 50%,
      #ffffff 0%,
      hsl(calc(var(--accent-hue) + 15), 100%, 80%) 35%,
      transparent 70%
    );
    filter: blur(1px);
    transition:
      opacity 0.05s linear,
      width 0.05s linear,
      height 0.05s linear;
  }

  /* Outer Energy Radiance (shining through the glass) */
  .dome-energy-bloom {
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    box-shadow: 0 0 calc(var(--energy-ratio, 0) * 10px)
      hsla(
        var(--accent-hue),
        var(--accent-sat),
        var(--accent-brightness),
        calc(var(--energy-ratio, 0) * 0.55)
      );
    opacity: calc(var(--energy-ratio, 0));
    transition: opacity 0.05s linear;
  }

  /* Blue mode (.is-changed) energy */
  .knob-container.is-changed .dome-energy-fill {
    background: radial-gradient(
      circle at 50% 50%,
      hsl(199, 100%, calc(70% + var(--energy-ratio, 0) * 20%)) 0%,
      hsl(199, 95%, calc(55% + var(--energy-ratio, 0) * 10%)) 45%,
      rgba(56, 189, 248, calc(0.3 + var(--energy-ratio, 0) * 0.6)) 75%,
      transparent 100%
    );
  }

  .knob-container.is-changed .dome-energy-core {
    background: radial-gradient(
      circle at 50% 50%,
      #ffffff 0%,
      #bae6fd 40%,
      transparent 75%
    );
  }

  .knob-container.is-changed .dome-energy-bloom {
    box-shadow: 0 0 calc(var(--energy-ratio, 0) * 10px)
      rgba(56, 189, 248, calc(var(--energy-ratio, 0) * 0.6));
  }

  /* 3D Glass Shell Surface with Light from the Right */
  .dome-glass-shell {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(
      circle at 72% 45%,
      rgba(255, 255, 255, 0.28) 0%,
      rgba(255, 255, 255, 0.08) 35%,
      rgba(0, 0, 0, 0.1) 60%,
      rgba(0, 0, 0, 0.5) 100%
    );
    box-shadow:
      inset -2px 0 3px rgba(255, 255, 255, 0.45),
      inset -1px -2px 4px rgba(255, 255, 255, 0.2),
      inset 3px 1px 5px rgba(0, 0, 0, 0.75),
      inset 1px 0 1px rgba(255, 255, 255, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.18);
  }

  /* Specular Highlight from the Right: Glass reflection crescent/oval */
  .dome-specular-right {
    position: absolute;
    top: 6px;
    right: 4px;
    width: 0px;
    height: 0px;
    border-radius: 50%;
    transform: rotate(20deg);
    background: radial-gradient(
      ellipse at 60% 45%,
      rgba(255, 255, 255, 0.85) 0%,
      rgba(255, 255, 255, 0.4) 30%,
      rgba(255, 255, 255, 0) 75%
    );
    filter: drop-shadow(0 0 1px rgba(255, 255, 255, 0.5));
  }

  /* Secondary micro-specular pin-point on lower-right edge */
  .dome-specular-pin {
    position: absolute;
    bottom: 6px;
    right: 6px;
    width: 0px;
    height: 0;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.7);
    filter: blur(0.3px);
  }

  .knob-value-badge {
    font-family: "JetBrains Mono", monospace;
    font-size: 9px;
    font-weight: 700;
    color: var(--color-orange-text);
    background: #0a0b0e;
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid #1a1e27;
    pointer-events: none;
    min-width: 28px;
    text-align: center;
  }

  .val-num {
    color: var(--color-orange-text);
  }
</style>
