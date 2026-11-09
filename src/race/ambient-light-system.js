/**
 * Camera Access: mide el brillo y el color del cuarto con la cámara del Quest
 * y ajusta las luces virtuales para que el carro y la pista se integren con el
 * ambiente real. La cámara se pide al pulsar Iniciar dentro de la sesión de RA;
 * si no hay permiso o cámara, las luces se quedan como están.
 */
import { CameraSource, CameraUtils, Color, createSystem, VisibilityState } from '@iwsdk/core';

const SAMPLE_INTERVAL = 0.5;
const SAMPLE_W = 16;
const SAMPLE_H = 12;

export class AmbientLightSystem extends createSystem({
  cameras: { required: [CameraSource] },
}) {
  init() {
    this.cameraEntity = null;
    this.sampleTimer = 0;
    this.brightness = 0.5;
    this.targetBrightness = 0.5;
    this.tint = new Color(1, 1, 1);
    this.targetTint = new Color(1, 1, 1);
    this.white = new Color(1, 1, 1);
    this.sampleColor = new Color();
    /** Último estado legible, útil para depurar desde la CLI. */
    this.status = 'inactive';

    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = SAMPLE_W;
    this.sampleCanvas.height = SAMPLE_H;
    this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true });

    this.keyLight = this.findLight('key-light', 'isDirectionalLight');
    this.fillLight = this.findLight('fill-light', 'isHemisphereLight');
    this.base = {
      key: this.keyLight?.intensity ?? 0,
      fill: this.fillLight?.intensity ?? 0,
      keyColor: this.keyLight?.color.clone(),
      fillColor: this.fillLight?.color.clone(),
    };

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (state === VisibilityState.NonImmersive) {
          this.stopCamera();
        }
      }),
    );
  }

  findLight(nodeId, flag) {
    const object = this.world.getSceneObject(nodeId);
    let light = null;
    object?.traverse((child) => {
      if (light == null && child[flag]) {
        light = child;
      }
    });
    return light;
  }

  /** Se llama al pulsar Iniciar: sólo pide la cámara dentro de la sesión de RA. */
  ensureCamera() {
    if (this.cameraEntity != null) {
      return;
    }
    if (this.world.visibilityState.peek() === VisibilityState.NonImmersive) {
      return;
    }
    this.cameraEntity = this.world.createTransformEntity();
    this.cameraEntity.addComponent(CameraSource, { width: 320, height: 240, frameRate: 15 });
    this.status = 'starting';
  }

  stopCamera() {
    if (this.cameraEntity != null) {
      this.cameraEntity.dispose();
      this.cameraEntity = null;
    }
    this.status = 'inactive';
    this.targetBrightness = 0.5;
    this.targetTint.copy(this.white);
  }

  sampleCamera() {
    const entity = this.cameraEntity;
    const state = entity.getValue(CameraSource, 'state');
    this.status = state;
    if (state !== 'active') {
      return;
    }
    const frame = CameraUtils.captureFrame(entity);
    if (frame == null) {
      return;
    }
    const ctx = this.sampleCtx;
    ctx.drawImage(frame, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    let r = 0;
    let g = 0;
    let b = 0;
    const count = SAMPLE_W * SAMPLE_H;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    r /= count * 255;
    g /= count * 255;
    b /= count * 255;
    this.targetBrightness = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Tono del cuarto normalizado, mezclado suavemente con blanco.
    const max = Math.max(r, g, b, 1e-3);
    this.sampleColor.setRGB(r / max, g / max, b / max);
    this.targetTint.copy(this.white).lerp(this.sampleColor, 0.35);
  }

  update(delta) {
    if (this.cameraEntity != null) {
      this.sampleTimer -= delta;
      if (this.sampleTimer <= 0) {
        this.sampleTimer = SAMPLE_INTERVAL;
        this.sampleCamera();
      }
    }

    const k = Math.min(1, delta * 2);
    this.brightness += (this.targetBrightness - this.brightness) * k;
    this.tint.lerp(this.targetTint, k);
    // 0.5 de brillo deja las luces como en la escena original.
    const factor = 0.35 + this.brightness * 1.3;
    if (this.keyLight != null) {
      this.keyLight.intensity = this.base.key * factor;
      this.keyLight.color.copy(this.base.keyColor).multiply(this.tint);
    }
    if (this.fillLight != null) {
      this.fillLight.intensity = this.base.fill * factor;
      this.fillLight.color.copy(this.base.fillColor).multiply(this.tint);
    }
  }
}
