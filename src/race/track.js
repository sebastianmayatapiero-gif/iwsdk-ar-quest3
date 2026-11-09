/**
 * Trazado fijo de la pista, obstáculos y textura del asfalto.
 *
 * La pista se describe como tramos de longitud y curvatura (1/radio, positiva
 * hacia la derecha) a escala de mesa, en metros. Se integra una sola vez en
 * muestras cada SAMPLE_STEP metros con su posición en el "mapa" (mx, my) y su
 * rumbo. Todo es determinista: la misma pista y los mismos obstáculos siempre.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, UnsignedByteType } from '@iwsdk/core';

export const ROAD_HALF_WIDTH = 0.09;
export const LANE_OFFSET = 0.055;
export const SAMPLE_STEP = 0.02;
/** Metros de pista que ocupa una repetición de la textura. */
export const TEXTURE_REPEAT_LENGTH = 0.4;

const SEGMENTS = [
  { length: 3.0, radius: 0 },
  { length: 1.6, radius: 1.5 },
  { length: 2.0, radius: 0 },
  { length: 1.8, radius: -1.2 },
  { length: 1.5, radius: 0 },
  { length: 1.2, radius: 1.0 },
  { length: 1.2, radius: -1.0 },
  { length: 3.0, radius: 0 },
  { length: 3.0, radius: -2.0 },
  { length: 2.0, radius: 0 },
  { length: 2.4, radius: 1.2 },
  { length: 2.5, radius: 0 },
  { length: 1.5, radius: -1.0 },
  { length: 1.5, radius: 1.0 },
  { length: 3.0, radius: 0 },
  { length: 2.0, radius: 1.5 },
  { length: 4.0, radius: 0 },
];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildCenterline() {
  const total = SEGMENTS.reduce((sum, seg) => sum + seg.length, 0);
  const count = Math.ceil(total / SAMPLE_STEP) + 1;
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const heading = new Float32Array(count);
  let mx = 0;
  let my = 0;
  let h = 0;
  let segIndex = 0;
  let segStart = 0;
  for (let i = 0; i < count; i += 1) {
    x[i] = mx;
    y[i] = my;
    heading[i] = h;
    const s = i * SAMPLE_STEP;
    while (segIndex < SEGMENTS.length - 1 && s >= segStart + SEGMENTS[segIndex].length) {
      segStart += SEGMENTS[segIndex].length;
      segIndex += 1;
    }
    const radius = SEGMENTS[segIndex].radius;
    const curvature = radius === 0 ? 0 : 1 / radius;
    h += curvature * SAMPLE_STEP;
    mx += Math.sin(h) * SAMPLE_STEP;
    my += Math.cos(h) * SAMPLE_STEP;
  }
  return { x, y, heading, count, length: (count - 1) * SAMPLE_STEP };
}

/**
 * Tramos que obligan a cambiar de marcha (distancias en metros de pista):
 *  - hill: subida, la pista se eleva; pide 1ª o 2ª.
 *  - mud: barro/arena que frena; pide 1ª o 2ª.
 *  - curve: curva cerrada con límite de velocidad; pide frenar y 2ª.
 *  - ramp: rampa de salto; pide 4ª y velocidad alta antes de `start`.
 */
export const ZONES = [
  { type: 'mud', start: 5.0, end: 6.0, gear: 2 },
  { type: 'curve', start: 9.9, end: 12.3, gear: 2, limitKmh: 45 },
  { type: 'hill', start: 13.0, end: 14.2, gear: 2, height: 0.03 },
  { type: 'mud', start: 19.0, end: 20.0, gear: 2 },
  { type: 'hill', start: 23.2, end: 24.4, gear: 1, height: 0.04 },
  { type: 'curve', start: 25.2, end: 28.2, gear: 2, limitKmh: 45 },
  { type: 'ramp', start: 30.4, end: 31.0, gear: 4, minKmh: 75 },
];

/** Tramo en el que está la distancia `s`, o null. */
export function zoneAt(s) {
  for (const zone of ZONES) {
    if (s >= zone.start && s <= zone.end) {
      return zone;
    }
  }
  return null;
}

/** Próximo tramo que empieza dentro de `lookAhead` metros (o el actual). */
export function upcomingZone(s, lookAhead) {
  for (const zone of ZONES) {
    if (s <= zone.end && zone.start - s <= lookAhead) {
      return zone;
    }
  }
  return null;
}

/** Altura extra de la pista en `s` (las subidas son una loma suave). */
export function elevationAt(s) {
  for (const zone of ZONES) {
    if (zone.type !== 'hill' || s < zone.start || s > zone.end) {
      continue;
    }
    const t = (s - zone.start) / (zone.end - zone.start);
    return zone.height * Math.sin(Math.PI * t) ** 2;
  }
  return 0;
}

/**
 * Obstáculos ordenados por distancia. Al principio aparecen sueltos; más
 * adelante aparecen en parejas, pero siempre dejan un carril libre. No se
 * colocan dentro de los tramos especiales (con un margen) para que sean justos.
 */
function buildObstacles(length) {
  const random = seededRandom(2026);
  const types = ['cone', 'barrel', 'crate'];
  const lanes = [-LANE_OFFSET, 0, LANE_OFFSET];
  const list = [];
  let s = 2.2;
  while (s < length - 1.6) {
    const progress = s / length;
    const free = Math.floor(random() * 3);
    const pair = progress > 0.35 && random() < 0.35 + progress * 0.3;
    const blocked = pair ? [0, 1, 2].filter((lane) => lane !== free) : [Math.floor(random() * 3)];
    for (const lane of blocked) {
      list.push({
        s: s + (random() - 0.5) * 0.04,
        lateral: lanes[lane] + (random() - 0.5) * 0.012,
        type: types[Math.floor(random() * types.length)],
      });
    }
    s += 1.25 - progress * 0.55 + random() * 0.5;
  }
  const clear = (o) => !ZONES.some((zone) => o.s > zone.start - 0.5 && o.s < zone.end + 0.5);
  return list.filter(clear).sort((a, b) => a.s - b.s);
}

const centerline = buildCenterline();

export const TRACK = {
  ...centerline,
  obstacles: buildObstacles(centerline.length),
};

/**
 * Escribe en `out` la pose del mapa a la distancia `s`, interpolada entre
 * muestras: out.x, out.y, out.heading.
 */
export function samplePose(s, out) {
  const clamped = Math.min(Math.max(s, 0), TRACK.length);
  const f = clamped / SAMPLE_STEP;
  const i = Math.min(Math.floor(f), TRACK.count - 2);
  const t = f - i;
  out.x = TRACK.x[i] + (TRACK.x[i + 1] - TRACK.x[i]) * t;
  out.y = TRACK.y[i] + (TRACK.y[i + 1] - TRACK.y[i]) * t;
  out.heading = TRACK.heading[i] + (TRACK.heading[i + 1] - TRACK.heading[i]) * t;
  // Más allá de los extremos, prolonga la pista en línea recta.
  const extra = s - clamped;
  if (extra !== 0) {
    out.x += Math.sin(out.heading) * extra;
    out.y += Math.cos(out.heading) * extra;
  }
  return out;
}

/**
 * Textura del asfalto: gris con grano, bordillos rojos y blancos y una línea
 * central discontinua. Se repite a lo largo de la pista.
 */
export function createRoadTexture() {
  const w = 64;
  const h = 256;
  const pixels = new Uint8Array(w * h * 4);
  const random = seededRandom(11);
  for (let py = 0; py < h; py += 1) {
    for (let px = 0; px < w; px += 1) {
      const u = (px + 0.5) / w;
      const v = (py + 0.5) / h;
      let r;
      let g;
      let b;
      if (u < 0.07 || u > 0.93) {
        const red = Math.floor(v * 8) % 2 === 0;
        [r, g, b] = red ? [214, 40, 40] : [240, 240, 240];
      } else if (u < 0.09 || u > 0.91) {
        [r, g, b] = [235, 235, 235];
      } else if (Math.abs(u - 0.5) < 0.018 && Math.floor(v * 4) % 2 === 0) {
        [r, g, b] = [246, 246, 238];
      } else {
        const grain = (random() - 0.5) * 18;
        r = 58 + grain;
        g = 61 + grain;
        b = 68 + grain;
      }
      const i = (py * w + px) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
  const texture = new DataTexture(pixels, w, h, RGBAFormat, UnsignedByteType);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
