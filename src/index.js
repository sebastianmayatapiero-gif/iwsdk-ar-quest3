/**
 * Carrera AR en la mesa para Meta Quest 3 (IWSDK).
 */
import { DepthSensingSystem, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { AmbientLightSystem } from './race/ambient-light-system.js';
import { HudSystem } from './race/hud-system.js';
import { RaceSystem } from './race/race-system.js';

World.create(document.getElementById('scene-container'), projectOptions).then((world) => {
  world.registerSystem(RaceSystem);
  world.registerSystem(AmbientLightSystem);
  world.registerSystem(HudSystem);
  // Depth Occlusion: las manos y objetos reales tapan lo virtual.
  world.registerSystem(DepthSensingSystem, {
    configData: {
      enableDepthTexture: true,
      enableOcclusion: true,
      useFloat32: true,
      blurRadius: 20,
    },
  });
});
