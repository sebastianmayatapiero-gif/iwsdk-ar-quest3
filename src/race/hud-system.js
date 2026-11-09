/**
 * Panel del juego: botones, estadísticas y minimapa cenital de toda la pista.
 * El panel flota detrás de la pista mirando al jugador; mientras se coloca la
 * pista, flota delante de la vista con las instrucciones.
 */
import { CanvasTexture, createSystem, Quaternion, SRGBColorSpace, Vector3, VisibilityState } from '@iwsdk/core';
import { RacePhase, RaceState } from '../race-components.js';
import { TRACK, samplePose } from './track.js';
import { AmbientLightSystem } from './ambient-light-system.js';
import { FINISH_DISTANCE, GEAR_MAX_KMH, MAX_RPM, RaceSystem, REDLINE_RPM, SPEED_TO_KMH } from './race-system.js';

const PANEL_OFFSET = new Vector3(0, 0.26, -0.43);
const PANEL_TILT = -0.15;
const MAP_SIZE = 256;
const MAP_MARGIN = 20;
const TEXT_INTERVAL = 0.1;
const GAUGE_INTERVAL = 0.05;
const GAUGE_SIZE = 256;
const MAX_KMH = 120;
/** Los relojes barren 270 grados, de abajo a la izquierda a abajo a la derecha. */
const ARC_START = Math.PI * 0.75;
const ARC_SWEEP = Math.PI * 1.5;

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

export class HudSystem extends createSystem({
  roots: { required: [RaceState] },
}) {
  init() {
    this.race = this.world.getSystem(RaceSystem);
    this.vecA = new Vector3();
    this.vecB = new Vector3();
    this.quat = new Quaternion();
    this.textTimer = 0;
    this.buttonKey = '';
    this.lastTexts = {};

    this.panel = this.world.requireSceneObject('race-panel');
    this.shadow = this.world.getSceneObject('table-shadow');
    const el = (id) => {
      const element = this.panel.requireElementById(id);
      element.name = id;
      return element;
    };
    this.elements = {
      status: el('status-text'),
      lives: el('lives-value'),
      time: el('time-value'),
      progress: el('progress-value'),
      gear: el('gear-value'),
      minimap: el('minimap'),
      rpmGauge: el('rpm-gauge'),
      speedGauge: el('speed-gauge'),
      start: el('start-button'),
      restart: el('restart-button'),
      place: el('place-button'),
      xr: el('xr-button'),
      exit: el('exit-button'),
    };

    const handlers = {
      start: () => {
        this.race.startRace();
        this.world.getSystem(AmbientLightSystem)?.ensureCamera();
      },
      restart: () => this.race.restartRace(),
      place: () => this.race.movePlacement(),
      xr: () => this.world.launchXR(),
      exit: () => this.world.exitXR(),
    };
    for (const [key, handler] of Object.entries(handlers)) {
      const element = this.elements[key];
      element.addEventListener('click', handler);
      this.cleanupFuncs.push(() => element.removeEventListener('click', handler));
    }

    this.createMinimap();
    this.gaugeTimer = 0;
    this.shownRpm = 0;
    this.shownKmh = 0;
    this.rpmGauge = this.createGaugeCanvas(this.elements.rpmGauge);
    this.speedGauge = this.createGaugeCanvas(this.elements.speedGauge);
    this.drawGauges(0);
  }

  // --------------------------------------------------------------- gauges

  createGaugeCanvas(element) {
    const canvas = document.createElement('canvas');
    canvas.width = GAUGE_SIZE;
    canvas.height = GAUGE_SIZE;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    element.setProperties({ src: texture });
    return { canvas, ctx: canvas.getContext('2d'), texture };
  }

  /** Esfera, marcas, números y aguja de un reloj analógico. */
  drawDial(ctx, value, max, majorStep, labelScale, redFrom) {
    const c = GAUGE_SIZE / 2;
    const radius = 104;
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, GAUGE_SIZE, GAUGE_SIZE);
    ctx.lineCap = 'round';
    // Arco base y zona roja.
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#2a303b';
    ctx.beginPath();
    ctx.arc(c, c, radius, ARC_START, ARC_START + ARC_SWEEP);
    ctx.stroke();
    if (redFrom != null) {
      ctx.strokeStyle = '#ff3b3b';
      ctx.beginPath();
      ctx.arc(c, c, radius, ARC_START + (redFrom / max) * ARC_SWEEP, ARC_START + ARC_SWEEP);
      ctx.stroke();
    }
    // Arco de valor actual.
    ctx.strokeStyle = '#2ad4ff';
    ctx.beginPath();
    ctx.arc(c, c, radius, ARC_START, ARC_START + Math.min(1, value / max) * ARC_SWEEP);
    ctx.stroke();
    // Marcas y números.
    ctx.fillStyle = '#c9ced8';
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= max + 1e-6; v += majorStep / 2) {
      const a = ARC_START + (v / max) * ARC_SWEEP;
      const major = Math.abs(v / majorStep - Math.round(v / majorStep)) < 1e-6;
      const inner = radius - (major ? 18 : 11);
      ctx.strokeStyle = redFrom != null && v >= redFrom ? '#ff6b6b' : '#8b94a7';
      ctx.lineWidth = major ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * inner, c + Math.sin(a) * inner);
      ctx.lineTo(c + Math.cos(a) * (radius - 6), c + Math.sin(a) * (radius - 6));
      ctx.stroke();
      if (major) {
        const lr = radius - 34;
        ctx.fillText(String(Math.round(v * labelScale)), c + Math.cos(a) * lr, c + Math.sin(a) * lr);
      }
    }
    // Aguja.
    const a = ARC_START + Math.min(1, Math.max(0, value / max)) * ARC_SWEEP;
    ctx.strokeStyle = '#ff5a3c';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(c - Math.cos(a) * 12, c - Math.sin(a) * 12);
    ctx.lineTo(c + Math.cos(a) * (radius - 14), c + Math.sin(a) * (radius - 14));
    ctx.stroke();
    ctx.fillStyle = '#e9eaee';
    ctx.beginPath();
    ctx.arc(c, c, 7, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Flecha de asistencia (verde arriba = subir, naranja abajo = bajar). */
  drawAssistArrow(ctx, assist, blinkOn) {
    if (assist === 0 || !blinkOn) {
      return;
    }
    const x = GAUGE_SIZE / 2;
    const y = GAUGE_SIZE / 2 + 66;
    const s = 14 * assist;
    ctx.fillStyle = assist > 0 ? '#3dff8a' : '#ff9a3c';
    ctx.beginPath();
    ctx.moveTo(x, y - s * 1.2);
    ctx.lineTo(x + 15, y);
    ctx.lineTo(x + 6, y);
    ctx.lineTo(x + 6, y + s);
    ctx.lineTo(x - 6, y + s);
    ctx.lineTo(x - 6, y);
    ctx.lineTo(x - 15, y);
    ctx.closePath();
    ctx.fill();
  }

  drawGauges(time) {
    const state = this.race.root;
    const rpm = state.getValue(RaceState, 'rpm');
    const kmh = state.getValue(RaceState, 'speed') * SPEED_TO_KMH;
    const gear = state.getValue(RaceState, 'gear');
    const assist = state.getValue(RaceState, 'assist');
    // Suavizado de agujas.
    this.shownRpm += (rpm - this.shownRpm) * 0.5;
    this.shownKmh += (kmh - this.shownKmh) * 0.5;

    // Tacómetro con marcha, flecha de asistencia y consejo.
    const r = this.rpmGauge.ctx;
    this.drawDial(r, this.shownRpm, MAX_RPM, 1000, 1 / 1000, REDLINE_RPM);
    const c = GAUGE_SIZE / 2;
    r.fillStyle = '#8b94a7';
    r.font = 'bold 13px sans-serif';
    r.fillText('RPM x1000', c, c + 30);
    r.fillStyle = '#fafaf7';
    r.font = 'bold 50px sans-serif';
    r.fillText(String(gear), c, c - 18);
    r.font = 'bold 12px sans-serif';
    r.fillStyle = '#8b94a7';
    r.fillText('MARCHA', c, c - 52);
    this.drawAssistArrow(r, assist, Math.floor(time * 4) % 2 === 0);
    const hint = this.race.hintText;
    if (hint) {
      r.fillStyle = assist > 0 ? '#3dff8a' : assist < 0 ? '#ff9a3c' : '#8fe3ff';
      r.font = 'bold 16px sans-serif';
      r.fillText(hint, c, GAUGE_SIZE - 14);
    }
    this.rpmGauge.texture.needsUpdate = true;

    // Velocímetro con lectura digital y el máximo de la marcha actual.
    const v = this.speedGauge.ctx;
    this.drawDial(v, this.shownKmh, MAX_KMH, 20, 1, null);
    v.fillStyle = '#fafaf7';
    v.font = 'bold 40px sans-serif';
    v.fillText(String(Math.round(this.shownKmh)), c, c + 44);
    v.fillStyle = '#8b94a7';
    v.font = 'bold 13px sans-serif';
    v.fillText('km/h', c, c + 72);
    // Marca del máximo de la marcha actual.
    const a = ARC_START + (GEAR_MAX_KMH[gear] / MAX_KMH) * ARC_SWEEP;
    v.fillStyle = '#ffd23a';
    v.beginPath();
    v.arc(c + Math.cos(a) * 104, c + Math.sin(a) * 104, 6, 0, Math.PI * 2);
    v.fill();
    this.speedGauge.texture.needsUpdate = true;
  }

  // -------------------------------------------------------------- minimap

  createMinimap() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < TRACK.count; i += 1) {
      minX = Math.min(minX, TRACK.x[i]);
      maxX = Math.max(maxX, TRACK.x[i]);
      minY = Math.min(minY, TRACK.y[i]);
      maxY = Math.max(maxY, TRACK.y[i]);
    }
    const scale = (MAP_SIZE - MAP_MARGIN * 2) / Math.max(maxX - minX, maxY - minY);
    const offsetX = (MAP_SIZE - (maxX - minX) * scale) / 2;
    const offsetY = (MAP_SIZE - (maxY - minY) * scale) / 2;
    this.mapX = (x) => offsetX + (x - minX) * scale;
    this.mapY = (y) => MAP_SIZE - (offsetY + (y - minY) * scale);
    this.mapPose = { x: 0, y: 0, heading: 0 };

    // Capa fija: fondo, trazado y meta.
    this.mapStatic = document.createElement('canvas');
    this.mapStatic.width = MAP_SIZE;
    this.mapStatic.height = MAP_SIZE;
    const ctx = this.mapStatic.getContext('2d');
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.tracePath(ctx, 0, TRACK.length);
    ctx.strokeStyle = '#3a4250';
    ctx.lineWidth = 11;
    ctx.stroke();
    ctx.strokeStyle = '#8b94a7';
    ctx.lineWidth = 2;
    ctx.stroke();
    this.drawFlag(ctx, 0, '#3dff8a');
    this.drawFlag(ctx, FINISH_DISTANCE, '#ffffff');

    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = MAP_SIZE;
    this.mapCanvas.height = MAP_SIZE;
    this.mapCtx = this.mapCanvas.getContext('2d');
    this.mapTexture = new CanvasTexture(this.mapCanvas);
    this.mapTexture.colorSpace = SRGBColorSpace;
    this.drawMinimap();
    this.elements.minimap.setProperties({ src: this.mapTexture });
  }

  tracePath(ctx, from, to) {
    ctx.beginPath();
    const step = 0.1;
    for (let s = from; s <= to + 1e-6; s += step) {
      const pose = samplePose(Math.min(s, to), this.mapPose);
      const px = this.mapX(pose.x);
      const py = this.mapY(pose.y);
      if (s === from) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
  }

  drawFlag(ctx, s, color) {
    const pose = samplePose(s, this.mapPose);
    const x = this.mapX(pose.x);
    const y = this.mapY(pose.y);
    // Barra perpendicular al trazado.
    const nx = Math.cos(pose.heading) * 9;
    const ny = Math.sin(pose.heading) * 9;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x - nx, y - ny);
    ctx.lineTo(x + nx, y + ny);
    ctx.stroke();
  }

  drawMinimap() {
    const ctx = this.mapCtx;
    const state = this.race.root;
    const distance = state.getValue(RaceState, 'distance');
    ctx.drawImage(this.mapStatic, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Tramo ya recorrido.
    if (distance > 0.05) {
      this.tracePath(ctx, 0, distance);
      ctx.strokeStyle = '#2ad4ff';
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    // Obstáculos que quedan por delante.
    ctx.fillStyle = '#ff9a3c';
    const obstacles = TRACK.obstacles;
    for (let i = 0; i < obstacles.length; i += 1) {
      const obstacle = obstacles[i];
      if (obstacle.s < distance) {
        continue;
      }
      const pose = samplePose(obstacle.s, this.mapPose);
      ctx.fillRect(this.mapX(pose.x) - 1.5, this.mapY(pose.y) - 1.5, 3, 3);
    }

    // Carro.
    const pose = samplePose(distance, this.mapPose);
    ctx.fillStyle = '#ff3b3b';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.mapX(pose.x), this.mapY(pose.y), 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    this.mapTexture.needsUpdate = true;
  }

  // ---------------------------------------------------------------- frame

  setText(key, text) {
    if (this.lastTexts[key] !== text) {
      this.lastTexts[key] = text;
      this.elements[key].setProperties({ text });
    }
  }

  setDisplay(key, visible) {
    this.elements[key].setProperties({ display: visible ? 'flex' : 'none' });
  }

  updateButtons(phase, immersive) {
    const key = `${phase}|${immersive}`;
    if (key === this.buttonKey) {
      return;
    }
    this.buttonKey = key;
    const placing = phase === RacePhase.Placing;
    this.setDisplay('start', !placing && phase !== RacePhase.Racing);
    this.setDisplay('restart', !placing && phase !== RacePhase.Ready);
    this.setDisplay('place', immersive && !placing);
    this.setDisplay('xr', !immersive && this.world.xrEnabled);
    this.setDisplay('exit', immersive);
  }

  placePanel(phase) {
    const panel = this.panel;
    if (phase === RacePhase.Placing) {
      // Delante de la vista, un poco por debajo de los ojos.
      const head = this.player.head;
      head.getWorldPosition(this.vecA);
      head.getWorldQuaternion(this.quat);
      // Dirección hacia donde mira el jugador, sobre el plano horizontal.
      this.vecB.set(0, 0, -1).applyQuaternion(this.quat);
      this.vecB.y = 0;
      if (this.vecB.lengthSq() < 1e-4) {
        this.vecB.set(0, 0, -1);
      }
      this.vecB.normalize();
      panel.position.set(this.vecA.x + this.vecB.x * 0.8, this.vecA.y - 0.25, this.vecA.z + this.vecB.z * 0.8);
      // El panel mira hacia +Z local: lo giramos hacia la cabeza.
      panel.rotation.set(-0.2, Math.atan2(-this.vecB.x, -this.vecB.z), 0, 'YXZ');
      return;
    }
    const root = this.race.root.object3D;
    root.updateWorldMatrix(true, false);
    this.vecA.copy(PANEL_OFFSET);
    root.localToWorld(this.vecA);
    panel.position.copy(this.vecA);
    panel.rotation.set(PANEL_TILT, root.rotation.y, 0, 'YXZ');
    if (this.shadow != null) {
      this.shadow.position.set(root.position.x, root.position.y + 0.0008, root.position.z);
      this.shadow.visible = root.visible;
    }
  }

  update(delta, time) {
    const state = this.race.root;
    const phase = state.getValue(RaceState, 'phase');
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    this.updateButtons(phase, immersive);
    this.placePanel(phase);

    this.gaugeTimer -= delta;
    if (this.gaugeTimer <= 0) {
      this.gaugeTimer = GAUGE_INTERVAL;
      this.drawGauges(time);
    }

    this.textTimer -= delta;
    if (this.textTimer > 0) {
      return;
    }
    this.textTimer = TEXT_INTERVAL;
    const lives = state.getValue(RaceState, 'lives');
    const distance = state.getValue(RaceState, 'distance');
    this.setText('status', this.race.statusText ?? '');
    this.setText('lives', `${lives} / 3`);
    this.setText('time', formatTime(state.getValue(RaceState, 'elapsed')));
    this.setText('progress', `${Math.min(100, Math.floor((distance / FINISH_DISTANCE) * 100))} %`);
    this.setText('gear', `${state.getValue(RaceState, 'gear')}`);
    const livesColor = lives <= 1 ? '#ff5a5a' : '#fafaf7';
    if (this.lastTexts.livesColor !== livesColor) {
      this.lastTexts.livesColor = livesColor;
      this.elements.lives.setProperties({ color: livesColor });
    }
    this.drawMinimap();
  }
}
