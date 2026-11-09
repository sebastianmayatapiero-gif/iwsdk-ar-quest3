/**
 * Modelos del juego de carreras, hechos con primitivas para no descargar nada.
 * Todas las medidas están en metros a escala de mesa: el carro mide 7 cm.
 * Cada fábrica devuelve un Object3D sin padre, con el origen en el punto de
 * apoyo (y = 0) y el frente del carro mirando hacia -Z.
 */
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
} from '@iwsdk/core';

/** Tamaño de la zona de juego proyectada sobre la mesa. */
export const PLAY_AREA = { width: 0.3, length: 0.6, height: 0.008 };

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

/** Base translúcida con borde luminoso que marca la zona proyectada. */
export function createTrackBase() {
  const { width, length, height } = PLAY_AREA;
  const base = new Group();
  base.name = 'track-base';
  base.add(mesh(new BoxGeometry(width, height, length), materials.base, 0, height / 2, 0));
  const glowW = new BoxGeometry(0.004, 0.003, length);
  const glowL = new BoxGeometry(width, 0.003, 0.004);
  base.add(mesh(glowW, materials.baseGlow, -width / 2, height, 0));
  base.add(mesh(glowW, materials.baseGlow, width / 2, height, 0));
  base.add(mesh(glowL, materials.baseGlow, 0, height, -length / 2));
  base.add(mesh(glowL, materials.baseGlow, 0, height, length / 2));
  return base;
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
