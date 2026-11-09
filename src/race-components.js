/**
 * Componentes del juego de carreras. Este módulo no importa sistemas para que
 * el editor de IWSDK pueda leerlo.
 */
import { createComponent, Types } from '@iwsdk/core';

export const RacePhase = {
  Placing: 'placing',
  Ready: 'ready',
  Racing: 'racing',
  Finished: 'finished',
  GameOver: 'gameover',
};

/** Estado de la partida; vive en la entidad raíz de la pista ("race-root"). */
export const RaceState = createComponent('RaceState', {
  phase: { type: Types.Enum, enum: RacePhase, default: RacePhase.Ready },
  distance: { type: Types.Float32, default: 0 },
  speed: { type: Types.Float32, default: 0 },
  lives: { type: Types.Int8, default: 3 },
  elapsed: { type: Types.Float32, default: 0 },
  crashes: { type: Types.Int16, default: 0 },
  carOffset: { type: Types.Float32, default: 0 },
  placed: { type: Types.Boolean, default: false },
  // Cabina: entradas del volante, botones y palanca.
  gear: { type: Types.Int8, default: 1, min: 1, max: 4 },
  rpm: { type: Types.Float32, default: 900 },
  throttle: { type: Types.Float32, default: 0 },
  brake: { type: Types.Float32, default: 0 },
  steer: { type: Types.Float32, default: 0, help: '-1 izquierda, +1 derecha' },
  /** Asistencia de cambio: +1 subir, -1 bajar, 0 nada. */
  assist: { type: Types.Int8, default: 0 },
  /** Tramo especial actual o próximo: "", "hill", "mud", "curve" o "ramp". */
  zone: { type: Types.String, default: '' },
});
