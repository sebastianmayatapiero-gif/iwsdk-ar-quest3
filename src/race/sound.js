/**
 * Efectos de sonido generados con Web Audio (sin archivos): motor, choque,
 * meta y fin de partida. El contexto de audio se crea en el primer gesto del
 * usuario (pulsar Iniciar), como exigen los navegadores.
 */
export class RaceSound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.engineOsc = null;
    this.engineGain = null;
    this.engineFilter = null;
  }

  ensure() {
    if (this.ctx == null) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx == null) {
        return false;
      }
      this.ctx = new AudioCtx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return true;
  }

  startEngine() {
    if (!this.ensure() || this.engineOsc != null) {
      return;
    }
    const ctx = this.ctx;
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 55;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineOsc.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    this.engineOsc.start();
    this.engineGain.gain.setTargetAtTime(0.18, ctx.currentTime, 0.2);
  }

  stopEngine() {
    if (this.engineOsc == null) {
      return;
    }
    const osc = this.engineOsc;
    this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    osc.stop(this.ctx.currentTime + 0.5);
    this.engineOsc = null;
  }

  /** speedRatio va de 0 (parado) a 1 (velocidad máxima). */
  setEngineSpeed(speedRatio) {
    if (this.engineOsc == null) {
      return;
    }
    const t = this.ctx.currentTime;
    this.engineOsc.frequency.setTargetAtTime(50 + speedRatio * 110, t, 0.1);
    this.engineFilter.frequency.setTargetAtTime(350 + speedRatio * 900, t, 0.1);
  }

  tone(freq, start, duration, type = 'square', volume = 0.25) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
    osc.connect(gain).connect(this.master);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + duration + 0.05);
  }

  countdown() {
    if (!this.ensure()) {
      return;
    }
    this.tone(440, 0, 0.15);
    this.tone(880, 0.2, 0.3);
  }

  crash() {
    if (!this.ensure()) {
      return;
    }
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * 0.35);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.6;
    noise.connect(gain).connect(this.master);
    noise.start();
    this.tone(90, 0, 0.25, 'triangle', 0.4);
  }

  finish() {
    if (!this.ensure()) {
      return;
    }
    [523, 659, 784, 1047].forEach((freq, i) => this.tone(freq, i * 0.12, 0.25, 'triangle', 0.3));
  }

  gameOver() {
    if (!this.ensure()) {
      return;
    }
    [392, 330, 262].forEach((freq, i) => this.tone(freq, i * 0.18, 0.3, 'sawtooth', 0.2));
  }
}
