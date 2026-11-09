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
});
