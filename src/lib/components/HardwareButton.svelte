<script lang="ts">
  import { midiManager } from "../midi/midiManager";
  import { isFirmwareModalOpen } from "../stores";
  import rndChassis from "../../assets/rnd_chassis.png";
  import buttonNoise from "../../assets/button_noise.png";

  let isPressed = $state(false);

  function handleTrigger(e?: Event) {
    if (e) e.stopPropagation();
    isPressed = true;
    midiManager.triggerHardware();
    setTimeout(() => (isPressed = false), 150);
  }

  function handleChassisClick() {
    isFirmwareModalOpen.set(true);
  }
</script>

<div class="hardware-chassis-container">
  <!-- Orange Square Chassis: height matches the container box around the knobs, 1:1 aspect ratio -->
  <div
    class="chassis-square"
    style="background-image: url({rndChassis});"
    onclick={handleChassisClick}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleChassisClick();
      }
    }}
    role="button"
    tabindex="0"
    title="Click orange surround to open JG-RND Patcher"
    aria-label="RND Hardware Chassis (click surround to open JG-RND Patcher)"
  >
    <!-- Simple almost-flat, slightly concave circular button with noise texture (no ridge/lip) -->
    <button
      type="button"
      class="rnd-button"
      class:pressed={isPressed}
      onclick={handleTrigger}
      title="Generate New Seed / Trigger RND Synth"
      aria-label="RND Hardware Trigger Button"
    >
      <div
        class="button-noise"
        style="background-image: url({buttonNoise});"
      ></div>
      <div class="button-lighting"></div>
    </button>
  </div>
</div>

<style>
  .hardware-chassis-container {
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    height: 100%;
    min-height: 0;
  }

  /* Orange Square Chassis: height matches the container box around the knobs, 1:1 aspect ratio */
  .chassis-square {
    position: relative;
    height: 100%;
    aspect-ratio: 1 / 1;
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--box-shadow-chassis);
    overflow: hidden;
  }

  /* Simple circular button: proportional to chassis (~38.2%), almost flat, very slightly concave, NO ridge or lip */
  .rnd-button {
    width: 38.2%;
    height: 38.2%;
    border-radius: 50%;
    position: relative;

    /* --- POSITION NUDGE CONTROLS --- */
    top: -2px; /* Vertical offset: positive numbers move DOWN, negative move UP */
    left: -1px; /* Horizontal offset: positive numbers move RIGHT, negative move LEFT */

    border: none;
    outline: none;
    cursor: pointer;
    padding: 0;
    overflow: hidden;
    /* Clean dark matte surface, very slightly concave with light bias toward left */
    background: radial-gradient(
      circle at 35% 50%,
      #4a4e58 0%,
      #343842 40%,
      #252830 70%,
      #1b1c22 100%
    );
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
    transition:
      transform 0.08s ease,
      filter 0.08s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 3;
  }

  .rnd-button:hover {
    filter: brightness(1.08);
  }

  .rnd-button:active,
  .rnd-button.pressed {
    transform: scale(0.98);
    filter: brightness(0.9);
  }

  /* Noise-like surface texture */
  .button-noise {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    /* --- NOISE SCALE ---
       Smaller (e.g. 32px 32px) = finer/denser grain
       Larger  (e.g. 96px 96px or 128px 128px) = coarser/larger grain */
    background-size: 128px 128px;
    background-repeat: repeat;
    mix-blend-mode: overlay;
    opacity: 0.42; /* Texture visibility / contrast */
    pointer-events: none;
    z-index: 1;
  }

  /* Directional lighting layer: light coming from the right illuminates the concave left face and texture */
  .button-lighting {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: linear-gradient(
      86deg,
      rgba(255, 255, 255, 0.28) 0%,
      rgba(255, 255, 255, 0.16) 28%,
      rgba(255, 255, 255, 0.03) 50%,
      rgba(0, 0, 0, 0.14) 70%,
      rgba(0, 0, 0, 0.45) 100%
    );
    pointer-events: none;
    z-index: 2;
  }
</style>
