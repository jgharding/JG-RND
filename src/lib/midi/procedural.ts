/**
 * Procedural Patch Simulation Engine for RND Synthesizer
 * Reverse-engineered from RNDsynth-v1.3 firmware.
 *
 * The procedural engine uses a 32-bit seed to initialize a standard
 * MT19937 Mersenne Twister PRNG (Knuth multiplier 1812433253 / 0x6c078965).
 *
 * During applySeed (0x080203dc), after initializing the 4 tracks, the synth draws 6 pseudo-random
 * values for the REVERB CONTROLS (note draws 4 and 5 map to CC 90 and CC 89):
 *   Draw 0 (0x080208b0): PRE-DELAY   (CC 85)  0.00 to 1.00
 *   Draw 1 (0x08020900): TONE        (CC 86)  0.50 to 0.98
 *   Draw 2 (0x0802094a): DIFFUSION 1 (CC 87)  0.00 to 1.00
 *   Draw 3 (0x08020996): DIFFUSION 2 (CC 88)  0.00 to 1.00
 *   Draw 4 (0x080209e4): DECAY       (CC 90)  0.30 to 0.95
 *   Draw 5 (0x08020a34): ROOM SIZE   (CC 89)  0.50 to 0.98
 */

class MT19937 {
  private mt = new Uint32Array(624);
  private mti = 624;

  constructor(seed: number) {
    this.init(seed);
  }

  public init(seed: number): void {
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, s) + i) >>> 0;
    }
    this.mti = 624;
  }

  private twist(): void {
    for (let i = 0; i < 624; i++) {
      const y = ((this.mt[i] & 0x80000000) >>> 0) | (this.mt[(i + 1) % 624] & 0x7fffffff);
      const mag01 = (y & 1) ? 0x9908b0df : 0;
      this.mt[i] = (this.mt[(i + 397) % 624] ^ (y >>> 1) ^ mag01) >>> 0;
    }
    this.mti = 0;
  }

  public extract(): number {
    if (this.mti >= 624) {
      this.twist();
    }
    let y = this.mt[this.mti++];
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y >>> 0;
  }
}

export interface ProceduralPatchLevels {
  seed: number;
  // REVERB CONTROLS seed defaults (0-127)
  predelayCC: number;    // PRE-DELAY   CC 85
  toneCC: number;        // TONE        CC 86
  diffusion1CC: number;  // DIFFUSION 1 CC 87
  diffusion2CC: number;  // DIFFUSION 2 CC 88
  roomSizeCC: number;    // ROOM SIZE   CC 89
  decayCC: number;       // DECAY       CC 90
  // Mixer defaults (calibrated to firmware mixer nominal gains)
  masterVolumeCC: number;   // MASTER VOLUME, 100 default
  masterReverbCC: number;   // MASTER REV MULT, 64 = unity (JGpatch-005 proportional trim)
  trackVolumesCC: number[]; // CH 1-4 VOLUME [100, 100, 100, 100]
  trackReverbsCC: number[]; // CH 1-4 REVERB send (calibrated nominal sends 42 to 86)
}

export function calculateProceduralLevels(seed: number): ProceduralPatchLevels {
  const uSeed = seed >>> 0;
  const rng = new MT19937(uSeed);

  const draw0 = rng.extract(); // Draw 0: PRE-DELAY   (0x080208b0)
  const draw1 = rng.extract(); // Draw 1: TONE        (0x08020900)
  const draw2 = rng.extract(); // Draw 2: DIFFUSION 1 (0x0802094a)
  const draw3 = rng.extract(); // Draw 3: DIFFUSION 2 (0x08020996)
  const draw4 = rng.extract(); // Draw 4: DECAY       (0x080209e4)
  const draw5 = rng.extract(); // Draw 5: ROOM SIZE   (0x08020a34)

  // Firmware formulas from applySeed (2.3283064e-10 = 1 / 2^32)
  const predelay = Math.min(1.0, Math.max(0.0, draw0 * 2.3283064365386963e-10));
  const tone = Math.min(0.98, Math.max(0.50, 0.50 + draw1 * 1.1175871339474952e-10));
  const diffusion1 = Math.min(1.0, Math.max(0.0, draw2 * 2.3283064365386963e-10));
  const diffusion2 = Math.min(1.0, Math.max(0.0, draw3 * 2.3283064365386963e-10));
  const decay = Math.min(0.95, Math.max(0.30, 0.30 + draw4 * 1.5133991282390014e-10));
  const roomSize = Math.min(0.98, Math.max(0.50, 0.50 + draw5 * 1.1175871339474952e-10));
  const toCC = (v: number) => Math.min(127, Math.max(0, Math.round(v * 127)));

  // Master Reverb Send (CC 91):
  // With JGpatch-005 proportional trim, Master CC 91 = 64 (0.50) is the exact unity center
  // (100% of the patch's procedural reverb send).
  const masterReverbCC = 64;

  // Next 4 extractions determine track-specific procedural reverb sends:
  // Track sends in hardware are centered around nominal stock send [track + 0xac] ~ 0.26 (CC ~64)
  // modulated by the PRNG seed (between 0.65x and 1.35x of nominal send -> CC 42 to 86)
  const trackDraws = [rng.extract(), rng.extract(), rng.extract(), rng.extract()];
  const trackReverbsCC = trackDraws.map((d) => {
    const factor = 0.65 + (d * 2.3283064365386963e-10) * 0.70;
    return Math.min(127, Math.max(5, Math.round(masterReverbCC * factor)));
  });

  return {
    seed: uSeed,
    predelayCC: toCC(predelay),
    toneCC: toCC(tone),
    diffusion1CC: toCC(diffusion1),
    diffusion2CC: toCC(diffusion2),
    roomSizeCC: toCC(roomSize),
    decayCC: toCC(decay),
    masterVolumeCC: 100,
    masterReverbCC,
    trackVolumesCC: [100, 100, 100, 100],
    trackReverbsCC,
  };
}
