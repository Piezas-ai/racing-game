/** All sound is generated with WebAudio — no audio assets. Includes the
 * cartoon jump-scare screech (loud-ish but capped, dissonant saw chord + noise). */

let ctx: AudioContext | null = null;
let engineOsc: OscillatorNode | null = null;
let engineGain: GainNode | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Call from a user gesture (button click) so the browser lets audio play. */
export function unlockAudio(): void {
  ac();
}

function blip(freq: number, durS: number, type: OscillatorType, gain: number, slideTo?: number): void {
  const a = ac();
  if (!a) return;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, a.currentTime);
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), a.currentTime + durS);
  g.gain.setValueAtTime(gain, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + durS);
  osc.connect(g).connect(a.destination);
  osc.start();
  osc.stop(a.currentTime + durS + 0.02);
}

function noiseBurst(durS: number, gain: number, lowpassHz = 4000): void {
  const a = ac();
  if (!a) return;
  const len = Math.floor(a.sampleRate * durS);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = lowpassHz;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(a.destination);
  src.start();
}

export const sfx = {
  countdownTick: () => blip(440, 0.15, 'square', 0.12),
  go: () => blip(880, 0.4, 'square', 0.15),
  pickup: () => {
    blip(660, 0.09, 'square', 0.1);
    setTimeout(() => blip(990, 0.12, 'square', 0.1), 90);
  },
  boost: () => {
    noiseBurst(0.5, 0.12, 2500);
    blip(200, 0.5, 'sawtooth', 0.1, 900);
  },
  spike: () => {
    blip(90, 0.3, 'sine', 0.3, 40);
    noiseBurst(0.15, 0.15, 1200);
  },
  trap: () => {
    blip(400, 0.12, 'square', 0.2, 90);
    noiseBurst(0.1, 0.2, 3000);
  },
  oilDrop: () => blip(300, 0.2, 'sine', 0.12, 120),
  spin: () => blip(500, 0.6, 'triangle', 0.12, 100),
  lightning: () => {
    blip(1400, 0.4, 'sawtooth', 0.2, 150);
    noiseBurst(0.3, 0.15, 6000);
  },
  lap: () => {
    blip(523, 0.1, 'square', 0.1);
    setTimeout(() => blip(659, 0.1, 'square', 0.1), 100);
    setTimeout(() => blip(784, 0.18, 'square', 0.1), 200);
  },
  /** The jump scare: dissonant scream-ish chord + noise. Loud but capped. */
  scare: () => {
    for (const f of [110, 116.5, 233, 466, 622]) blip(f, 0.9, 'sawtooth', 0.14, f * 0.7);
    noiseBurst(0.7, 0.25, 8000);
  },
  shoot: () => {
    blip(950, 0.16, 'square', 0.16, 140);
    noiseBurst(0.08, 0.08, 5000);
  },
  shootDistant: () => blip(700, 0.12, 'square', 0.05, 160),
  placeBlock: () => {
    blip(150, 0.18, 'sine', 0.22, 70);
    noiseBurst(0.08, 0.1, 900);
  },
  empty: () => blip(1300, 0.05, 'square', 0.07, 900),
  armor: () => {
    blip(1250, 0.22, 'triangle', 0.18, 880);
    blip(1870, 0.14, 'triangle', 0.1, 1400);
  },
  shatter: () => {
    noiseBurst(0.3, 0.22, 2600);
    blip(110, 0.3, 'sine', 0.25, 50);
  },
  sword: () => {
    blip(2400, 0.18, 'sawtooth', 0.1, 800);
    noiseBurst(0.12, 0.08, 9000);
  },
  barrier: () => {
    blip(440, 0.5, 'sine', 0.12, 660);
    blip(660, 0.5, 'sine', 0.08, 880);
  },
  steal: () => {
    blip(880, 0.12, 'triangle', 0.12, 1400);
    setTimeout(() => blip(1400, 0.15, 'triangle', 0.12, 500), 110);
  },
  boom: () => {
    blip(60, 1.0, 'sine', 0.4, 25);
    noiseBurst(0.8, 0.3, 1500);
    blip(120, 0.6, 'sawtooth', 0.2, 30);
  },
  hypno: () => {
    for (let i = 0; i < 5; i++) {
      setTimeout(() => blip(500 + Math.sin(i * 2) * 220, 0.3, 'sine', 0.12, 500 - Math.sin(i * 2) * 220), i * 180);
    }
  },
  /** DJ drop: a funky little four-on-the-floor bass riff. */
  dj: () => {
    [110, 110, 165, 110, 220, 165].forEach((f, i) =>
      setTimeout(() => blip(f, 0.14, 'square', 0.14), i * 130),
    );
  },
  rocket: () => {
    noiseBurst(0.5, 0.14, 3000);
    blip(140, 0.7, 'sawtooth', 0.14, 900);
  },
  win: () => {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.18, 'square', 0.12), i * 130));
  },
  lose: () => {
    [392, 330, 262, 196].forEach((f, i) => setTimeout(() => blip(f, 0.22, 'triangle', 0.12), i * 160));
  },
};

/** Engine hum that follows speed. Call every frame; speed01 in [0,1]. */
export function updateEngineSound(speed01: number, muted: boolean): void {
  const a = ac();
  if (!a) return;
  if (!engineOsc) {
    engineOsc = a.createOscillator();
    engineGain = a.createGain();
    engineOsc.type = 'sawtooth';
    engineGain.gain.value = 0;
    engineOsc.connect(engineGain).connect(a.destination);
    engineOsc.start();
  }
  const target = muted ? 0 : 0.015 + speed01 * 0.02;
  engineGain!.gain.setTargetAtTime(target, a.currentTime, 0.08);
  engineOsc.frequency.setTargetAtTime(55 + speed01 * 160, a.currentTime, 0.05);
}

export function stopEngineSound(): void {
  if (engineGain && ctx) engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
}
