/**
 * Catálogo de assets del juego. Se evalúa dos veces (app y editor), así que
 * debe ser determinista y sin efectos secundarios.
 */
import { AssetType, defineAssets } from '@iwsdk/core';
import {
  createBarrel,
  createCone,
  createCrate,
  createFinishLine,
  createGearKnob,
  createGearLever,
  createRaceCar,
  createRamp,
  createSteeringWheel,
  createTrackBase,
} from './scene-assets/race.scene-asset.js';

const publicAssetUrl = (filePath) => `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

export default defineAssets({
  'race-car': createRaceCar(),
  'track-base': createTrackBase(),
  'finish-line': createFinishLine(),
  'obstacle-cone': createCone(),
  'obstacle-barrel': createBarrel(),
  'obstacle-crate': createCrate(),
  'steering-wheel': createSteeringWheel(),
  'gear-lever': createGearLever(),
  'gear-knob': createGearKnob(),
  'jump-ramp': createRamp(),
  'race-panel': {
    url: publicAssetUrl('ui/race-panel.uikitml'),
    type: AssetType.UIKitML,
    name: 'Race Panel',
  },
});
