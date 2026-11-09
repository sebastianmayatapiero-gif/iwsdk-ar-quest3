/**
 * Modelos del juego de carreras, hechos con primitivas para no descargar nada.
 * Todas las medidas están en metros a escala de mesa: el carro mide 7 cm.
 * Cada fábrica devuelve un Object3D sin padre, con el origen en el punto de
 * apoyo (y = 0) y el frente del carro mirando hacia -Z.
 */
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from '@iwsdk/core';

/**
 * Tamaño de la zona de juego proyectada sobre la mesa. `lift` es la
 * separación entre la mesa y la base, para que no parpadeen al coincidir.
 */
export const PLAY_AREA = { width: 0.3, length: 0.6, height: 0.008, lift: 0.015 };

/**
 * Volante: radio del aro, altura del centro sobre la mesa e inclinación.
 * Los botones van pegados al borde interior del aro, donde descansa el pulgar
 * al sujetar el volante a las 9 y a las 3.
 */
export const WHEEL = { radius: 0.13, tube: 0.012, height: 0.15, tilt: 0.6, buttonOffset: 0.098, buttonRadius: 0.016 };

/** Palanca: altura del pomo y recorrido adelante/atrás. */
export const LEVER = { height: 0.11, travel: 0.04 };

/** Medidas del carro, usadas también para detectar choques. */
export const CAR_SIZE = { width: 0.04, length: 0.07, height: 0.03 };

/** Radio de choque de cada tipo de obstáculo. */
export const OBSTACLE_RADIUS = { cone: 0.012, barrel: 0.013, crate: 0.015 };

const materials = {
  body: new MeshStandardMaterial({ color: '#e0262b', roughness: 0.35, metalness: 0.2 }),
  trim: new MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.5 }),
  glass: new MeshStandardMaterial({ color: '#1d2a3a', roughness: 0.15, metalness: 0.4 }),
  tire: new MeshStandardMaterial({ color: '#16171a', roughness: 0.9 }),
  rim: new MeshStandardMaterial({ color: '#b9bcc2', roughness: 0.3, metalness: 0.7 }),
  light: new MeshStandardMaterial({ color: '#fff4c2', emissive: '#ffe58a', emissiveIntensity: 1.5 }),
  cone: new MeshStandardMaterial({ color: '#ff7a1a', roughness: 0.6 }),
  coneStripe: new MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }),
  barrel: new MeshStandardMaterial({ color: '#2f6fd6', roughness: 0.45, metalness: 0.3 }),
  barrelBand: new MeshStandardMaterial({ color: '#ffd23a', roughness: 0.5 }),
  crate: new MeshStandardMaterial({ color: '#b98a4e', roughness: 0.85 }),
  crateEdge: new MeshStandardMaterial({ color: '#7c5a2e', roughness: 0.85 }),
  base: new MeshStandardMaterial({ color: '#15181e', roughness: 0.8, transparent: true, opacity: 0.85 }),
  baseGlow: new MeshStandardMaterial({ color: '#2ad4ff', emissive: '#2ad4ff', emissiveIntensity: 1.2 }),
  finish: new MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }),
};

function mesh(geometry, material, x = 0, y = 0, z = 0) {
  const m = new Mesh(geometry, material);
  m.position.set(x, y, z);
  return m;
}

/** Carro de carreras low-poly: carrocería, cabina, alerón y cuatro ruedas. */
export function createRaceCar() {
  const { width: w, length: l } = CAR_SIZE;
  const car = new Group();
  car.name = 'race-car';
  const wheelR = 0.0085;
  // Carrocería principal y morro.
  car.add(mesh(new BoxGeometry(w * 0.82, 0.011, l * 0.92), materials.body, 0, wheelR + 0.003, 0));
  car.add(mesh(new BoxGeometry(w * 0.55, 0.008, l * 0.3), materials.body, 0, wheelR + 0.008, -l * 0.28));
  // Cabina con cristal.
  car.add(mesh(new BoxGeometry(w * 0.5, 0.01, l * 0.3), materials.glass, 0, wheelR + 0.013, l * 0.05));
  // Franja central blanca.
  car.add(mesh(new BoxGeometry(w * 0.12, 0.0012, l * 0.9), materials.trim, 0, wheelR + 0.0091, 0));
  // Alerón trasero.
  car.add(mesh(new BoxGeometry(w * 0.95, 0.002, 0.01), materials.trim, 0, wheelR + 0.019, l * 0.43));
  car.add(mesh(new BoxGeometry(0.003, 0.01, 0.006), materials.trim, -w * 0.3, wheelR + 0.013, l * 0.43));
  car.add(mesh(new BoxGeometry(0.003, 0.01, 0.006), materials.trim, w * 0.3, wheelR + 0.013, l * 0.43));
  // Faros.
  car.add(mesh(new BoxGeometry(0.008, 0.003, 0.002), materials.light, -w * 0.25, wheelR + 0.005, -l * 0.46));
  car.add(mesh(new BoxGeometry(0.008, 0.003, 0.002), materials.light, w * 0.25, wheelR + 0.005, -l * 0.46));
  // Ruedas.
  const tireGeo = new CylinderGeometry(wheelR, wheelR, 0.008, 14);
  const rimGeo = new CylinderGeometry(wheelR * 0.5, wheelR * 0.5, 0.0085, 10);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * w * 0.47;
      const z = sz * l * 0.3;
      const tire = mesh(tireGeo, materials.tire, x, wheelR, z);
      tire.rotation.z = Math.PI / 2;
      const rim = mesh(rimGeo, materials.rim, x, wheelR, z);
      rim.rotation.z = Math.PI / 2;
      car.add(tire, rim);
    }
  }
  return car;
}

/** Cono de tráfico naranja con franja blanca. */
export function createCone() {
  const cone = new Group();
  cone.name = 'obstacle-cone';
  cone.add(mesh(new BoxGeometry(0.022, 0.002, 0.022), materials.cone, 0, 0.001, 0));
  cone.add(mesh(new ConeGeometry(0.009, 0.028, 16), materials.cone, 0, 0.016, 0));
  cone.add(mesh(new CylinderGeometry(0.0052, 0.0064, 0.004, 16), materials.coneStripe, 0, 0.017, 0));
  return cone;
}

/** Barril azul con bandas amarillas. */
export function createBarrel() {
  const barrel = new Group();
  barrel.name = 'obstacle-barrel';
  barrel.add(mesh(new CylinderGeometry(0.011, 0.011, 0.026, 18), materials.barrel, 0, 0.013, 0));
  const bandGeo = new CylinderGeometry(0.0113, 0.0113, 0.003, 18);
  barrel.add(mesh(bandGeo, materials.barrelBand, 0, 0.007, 0));
  barrel.add(mesh(bandGeo, materials.barrelBand, 0, 0.019, 0));
  return barrel;
}

/** Caja de madera. */
export function createCrate() {
  const crate = new Group();
  crate.name = 'obstacle-crate';
  crate.add(mesh(new BoxGeometry(0.024, 0.022, 0.024), materials.crate, 0, 0.011, 0));
  const edge = new BoxGeometry(0.025, 0.003, 0.025);
  crate.add(mesh(edge, materials.crateEdge, 0, 0.0015, 0));
  crate.add(mesh(edge, materials.crateEdge, 0, 0.0205, 0));
  return crate;
}

export const OBSTACLE_FACTORIES = {
  cone: createCone,
  barrel: createBarrel,
  crate: createCrate,
};

/**
 * Base translúcida con borde luminoso que marca la zona proyectada. Flota
 * `PLAY_AREA.lift` sobre la mesa, apoyada en cuatro soportes pequeños.
 */
export function createTrackBase() {
  const { width, length, height, lift } = PLAY_AREA;
  const base = new Group();
  base.name = 'track-base';
  const top = lift + height;
  base.add(mesh(new BoxGeometry(width, height, length), materials.base, 0, lift + height / 2, 0));
  const glowW = new BoxGeometry(0.004, 0.003, length);
  const glowL = new BoxGeometry(width, 0.003, 0.004);
  base.add(mesh(glowW, materials.baseGlow, -width / 2, top, 0));
  base.add(mesh(glowW, materials.baseGlow, width / 2, top, 0));
  base.add(mesh(glowL, materials.baseGlow, 0, top, -length / 2));
  base.add(mesh(glowL, materials.baseGlow, 0, top, length / 2));
  const post = new CylinderGeometry(0.004, 0.006, lift, 10);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      base.add(mesh(post, materials.trim, sx * (width / 2 - 0.015), lift / 2, sz * (length / 2 - 0.015)));
    }
  }
  return base;
}

const cockpit = {
  rim: new MeshStandardMaterial({ color: '#1b1d22', roughness: 0.55 }),
  grip: new MeshStandardMaterial({ color: '#2b2e35', roughness: 0.8 }),
  metal: new MeshStandardMaterial({ color: '#9aa0a8', roughness: 0.35, metalness: 0.8 }),
  accent: new MeshStandardMaterial({ color: '#2ad4ff', emissive: '#2ad4ff', emissiveIntensity: 0.6 }),
  brake: new MeshStandardMaterial({ color: '#e0262b', emissive: '#e0262b', emissiveIntensity: 0.25, roughness: 0.4 }),
  throttle: new MeshStandardMaterial({ color: '#2f6fd6', emissive: '#2f6fd6', emissiveIntensity: 0.25, roughness: 0.4 }),
  knob: new MeshStandardMaterial({ color: '#111216', roughness: 0.3, metalness: 0.2 }),
  up: new MeshStandardMaterial({ color: '#3dff8a', emissive: '#3dff8a', emissiveIntensity: 0.5 }),
  down: new MeshStandardMaterial({ color: '#ff9a3c', emissive: '#ff9a3c', emissiveIntensity: 0.5 }),
};

/**
 * Volante sobre su soporte. El origen está en la mesa, bajo el soporte.
 * "wheel-pivot" está inclinado hacia el jugador; dentro, "wheel-spinner" es
 * lo que gira (aro, radios y los botones "brake-button" y "throttle-button").
 * El aro está en el plano XY local de "wheel-pivot" y mira hacia +Z.
 */
export function createSteeringWheel() {
  const { radius, tube, height, tilt, buttonOffset, buttonRadius } = WHEEL;
  const root = new Group();
  root.name = 'steering-wheel';
  const columnLength = 0.06;
  const pivotZ = Math.cos(tilt) * columnLength;
  const pivot = new Group();
  pivot.name = 'wheel-pivot';
  pivot.position.set(0, height, pivotZ);
  pivot.rotation.x = -tilt;
  root.add(pivot);

  // Columna y soporte vertical hasta la mesa.
  const column = mesh(new CylinderGeometry(0.012, 0.014, columnLength, 14), cockpit.metal, 0, 0, -columnLength / 2);
  column.rotation.x = Math.PI / 2;
  pivot.add(column);
  const columnEndY = height - Math.sin(tilt) * columnLength;
  root.add(mesh(new CylinderGeometry(0.012, 0.012, columnEndY, 14), cockpit.metal, 0, columnEndY / 2, 0));
  root.add(mesh(new CylinderGeometry(0.05, 0.055, 0.008, 24), cockpit.rim, 0, 0.004, 0));

  const spinner = new Group();
  spinner.name = 'wheel-spinner';
  pivot.add(spinner);
  spinner.add(mesh(new TorusGeometry(radius, tube, 12, 48), cockpit.rim));
  // Empuñaduras a los lados (3 y 9 en punto).
  const gripGeo = new TorusGeometry(radius, tube * 1.25, 10, 12, 0.7);
  const leftGrip = mesh(gripGeo, cockpit.grip);
  leftGrip.rotation.z = Math.PI - 0.35;
  const rightGrip = mesh(gripGeo, cockpit.grip);
  rightGrip.rotation.z = -0.35;
  spinner.add(leftGrip, rightGrip);
  // Marca superior para ver el giro.
  spinner.add(mesh(new BoxGeometry(0.012, 0.02, 0.026), cockpit.accent, 0, radius, 0));
  // Cubo y radios.
  const hub = mesh(new CylinderGeometry(0.032, 0.032, 0.02, 24), cockpit.rim);
  hub.rotation.x = Math.PI / 2;
  spinner.add(hub);
  const spokeLength = radius - 0.03;
  spinner.add(mesh(new BoxGeometry(spokeLength, 0.03, 0.01), cockpit.rim, -(0.03 + spokeLength / 2), 0, 0));
  spinner.add(mesh(new BoxGeometry(spokeLength, 0.03, 0.01), cockpit.rim, 0.03 + spokeLength / 2, 0, 0));
  spinner.add(mesh(new BoxGeometry(0.026, spokeLength, 0.01), cockpit.rim, 0, -(0.03 + spokeLength / 2), 0));
  // Botones: azul (acelerar) a la izquierda y rojo (frenar) a la derecha.
  const buttonGeo = new CylinderGeometry(buttonRadius, buttonRadius, 0.01, 20);
  const brake = mesh(buttonGeo, cockpit.brake, buttonOffset, 0, 0.011);
  brake.name = 'brake-button';
  brake.rotation.x = Math.PI / 2;
  const throttle = mesh(buttonGeo, cockpit.throttle, -buttonOffset, 0, 0.011);
  throttle.name = 'throttle-button';
  throttle.rotation.x = Math.PI / 2;
  spinner.add(brake, throttle);
  return root;
}

/**
 * Base de la palanca de cambios con la varilla ("lever-stick", gira en su
 * base). El pomo se crea aparte (createGearKnob) porque es lo que se agarra.
 * Flecha verde hacia adelante = subir marcha; naranja hacia atrás = bajar.
 */
export function createGearLever() {
  const lever = new Group();
  lever.name = 'gear-lever';
  lever.add(mesh(new BoxGeometry(0.07, 0.012, 0.11), cockpit.rim, 0, 0.006, 0));
  lever.add(mesh(new BoxGeometry(0.012, 0.002, LEVER.travel * 2 + 0.01), cockpit.metal, 0, 0.0125, 0));
  const arrowGeo = new ConeGeometry(0.008, 0.014, 3);
  const up = mesh(arrowGeo, cockpit.up, 0.022, 0.013, -0.035);
  up.rotation.x = -Math.PI / 2;
  const down = mesh(arrowGeo, cockpit.down, 0.022, 0.013, 0.035);
  down.rotation.x = Math.PI / 2;
  lever.add(up, down);
  const stick = new Group();
  stick.name = 'lever-stick';
  stick.position.y = 0.012;
  stick.add(mesh(new CylinderGeometry(0.005, 0.006, LEVER.height, 12), cockpit.metal, 0, LEVER.height / 2, 0));
  stick.add(mesh(new CylinderGeometry(0.016, 0.02, 0.02, 16), cockpit.grip, 0, 0.01, 0));
  lever.add(stick);
  return lever;
}

/** Pomo de la palanca (lo que agarra la mano). */
export function createGearKnob() {
  const knob = new Group();
  knob.name = 'gear-knob';
  knob.add(mesh(new SphereGeometry(0.018, 20, 14), cockpit.knob));
  knob.add(mesh(new CylinderGeometry(0.01, 0.01, 0.002, 16), cockpit.accent, 0, 0.0175, 0));
  return knob;
}

/** Rampa de salto amarilla con franjas negras; sube hacia -Z (adelante). */
export function createRamp(width = 0.16, length = 0.1, height = 0.025) {
  const shape = new Shape();
  shape.moveTo(0, 0);
  shape.lineTo(length, 0);
  shape.lineTo(length, height);
  shape.lineTo(0, 0);
  const geometry = new ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geometry.translate(0, 0, -width / 2);
  const yellow = new MeshStandardMaterial({ color: '#ffd23a', roughness: 0.5 });
  const ramp = new Group();
  ramp.name = 'jump-ramp';
  const body = new Mesh(geometry, yellow);
  body.rotation.y = Math.PI / 2;
  ramp.add(body);
  const stripe = new MeshStandardMaterial({ color: '#111111', roughness: 0.6 });
  const slope = Math.atan2(height, length);
  for (let i = 0; i < 4; i += 1) {
    const s = mesh(new BoxGeometry(0.012, 0.0008, Math.hypot(length, height) * 0.98), stripe, -width / 2 + 0.02 + i * 0.04, height / 2 + 0.0006, -length / 2);
    s.rotation.x = slope;
    ramp.add(s);
  }
  return ramp;
}

/**
 * Señal de límite de velocidad sobre un poste. Sólo se usa en tiempo de
 * ejecución porque dibuja el número en un canvas.
 */
export function createSpeedSign(limit) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(64, 64, 60, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#d81e1e';
  ctx.beginPath();
  ctx.arc(64, 64, 53, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 54px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(limit), 64, 68);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sign = new Group();
  sign.name = 'speed-sign';
  sign.add(mesh(new CylinderGeometry(0.002, 0.002, 0.05, 8), materials.rim, 0, 0.025, 0));
  // Cara con el número (mira hacia +Z, el jugador) y reverso gris.
  const faceGeo = new CircleGeometry(0.014, 28);
  const face = new Mesh(faceGeo, new MeshStandardMaterial({ map: texture, roughness: 0.6 }));
  face.position.set(0, 0.06, 0.0006);
  const back = new Mesh(faceGeo, materials.rim);
  back.position.set(0, 0.06, -0.0006);
  back.rotation.y = Math.PI;
  sign.add(face, back);
  return sign;
}

/** Anillo para indicar dónde se colocará la pista sobre la mesa. */
export function createPlacementReticle() {
  const reticle = new Group();
  reticle.name = 'placement-reticle';
  const { width, length } = PLAY_AREA;
  const glow = new MeshStandardMaterial({
    color: '#2ad4ff',
    emissive: '#2ad4ff',
    emissiveIntensity: 1,
    transparent: true,
    opacity: 0.9,
  });
  const sideW = new BoxGeometry(0.006, 0.002, length);
  const sideL = new BoxGeometry(width, 0.002, 0.006);
  reticle.add(mesh(sideW, glow, -width / 2, 0.001, 0));
  reticle.add(mesh(sideW, glow, width / 2, 0.001, 0));
  reticle.add(mesh(sideL, glow, 0, 0.001, -length / 2));
  reticle.add(mesh(sideL, glow, 0, 0.001, length / 2));
  // Flecha que indica hacia dónde avanza la pista.
  const arrow = mesh(new ConeGeometry(0.02, 0.05, 3), glow, 0, 0.002, -0.05);
  arrow.rotation.x = -Math.PI / 2;
  reticle.add(arrow);
  return reticle;
}

/** Línea de meta a cuadros (8×2 casillas). */
export function createFinishLine(width = 0.18) {
  const line = new Group();
  line.name = 'finish-line';
  const cell = width / 8;
  const black = new MeshStandardMaterial({ color: '#111111', roughness: 0.6 });
  const geo = new BoxGeometry(cell, 0.0012, cell);
  for (let i = 0; i < 8; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      const m = mesh(geo, (i + j) % 2 ? black : materials.finish, -width / 2 + cell * (i + 0.5), 0.0006, (j - 0.5) * cell);
      line.add(m);
    }
  }
  return line;
}
