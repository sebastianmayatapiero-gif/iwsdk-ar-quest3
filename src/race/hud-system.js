/**
 * Panel del juego: botones, estadísticas y minimapa cenital de toda la pista.
 * El panel flota detrás de la pista mirando al jugador; mientras se coloca la
 * pista, flota delante de la vista con las instrucciones.
 */
import { CanvasTexture, createSystem, Quaternion, SRGBColorSpace, Vector3, VisibilityState } from '@iwsdk/core';
import { RacePhase, RaceState } from '../race-components.js';
import { TRACK, samplePose } from './track.js';
import { AmbientLightSystem } from './ambient-light-system.js';
import { FINISH_DISTANCE, RaceSystem, SPEED_TO_KMH } from './race-system.js';

const PANEL_OFFSET = new Vector3(0, 0.26, -0.43);
const PANEL_TILT = -0.15;
const MAP_SIZE = 256;
const MAP_MARGIN = 20;
const TEXT_INTERVAL = 0.1;

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
      speed: el('speed-value'),
      minimap: el('minimap'),
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

  update(delta) {
    const state = this.race.root;
    const phase = state.getValue(RaceState, 'phase');
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    this.updateButtons(phase, immersive);
    this.placePanel(phase);

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
    this.setText('speed', `${Math.round(state.getValue(RaceState, 'speed') * SPEED_TO_KMH)} km/h`);
    const livesColor = lives <= 1 ? '#ff5a5a' : '#fafaf7';
    if (this.lastTexts.livesColor !== livesColor) {
      this.lastTexts.livesColor = livesColor;
      this.elements.lives.setProperties({ color: livesColor });
    }
    this.drawMinimap();
  }
}
