/**
 * Lógica principal del juego de carreras:
 *  - colocación de la pista sobre la mesa (hit-test + planos detectados),
 *  - la pista avanza bajo el carro (el carro no se desplaza hacia adelante),
 *  - motor con 4 marchas: acelerador, freno y RPM (CockpitSystem da las
 *    entradas del volante, los botones y la palanca),
 *  - tramos que piden cambiar de marcha: subidas, barro, curvas y rampa,
 *  - choques con obstáculos (salen volando con física), vidas y meta.
 *
 * "race-root" es el ancla colocada sobre la mesa y mira al jugador (+Z hacia
 * él); de ella cuelgan la cabina y el panel. La pista vive en "track-frame",
 * hijo del ancla girado TRACK_YAW. Coordenadas de la pista: +X a la derecha,
 * +Y arriba, +Z hacia el extremo cercano. El carro mira hacia -Z.
 */
import {
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DepthOccludable,
  EnvironmentRaycastTarget,
  Group,
  Mesh,
  MeshStandardMaterial,
  PhysicsBody,
  PhysicsManipulation,
  PhysicsShape,
  PhysicsShapeType,
  PhysicsState,
  Plane,
  Quaternion,
  RaycastSpace,
  SceneUnderstandingSystem,
  Vector3,
  VisibilityState,
  XRPlane,
} from '@iwsdk/core';
import { RacePhase, RaceState } from '../race-components.js';
import {
  CAR_SIZE,
  createFinishLine,
  createPlacementReticle,
  createRaceCar,
  createRamp,
  createSpeedSign,
  createTrackBase,
  OBSTACLE_FACTORIES,
  OBSTACLE_RADIUS,
  PLAY_AREA,
} from '../scene-assets/race.scene-asset.js';
import { RaceSound } from './sound.js';
import {
  createRoadTexture,
  elevationAt,
  ROAD_HALF_WIDTH,
  samplePose,
  slopeAt,
  TEXTURE_REPEAT_LENGTH,
  TRACK,
  upcomingZone,
  ZONES,
  zoneAt,
} from './track.js';

/** Altura del asfalto: un poco por encima de la base para evitar parpadeos. */
const ROAD_Y = PLAY_AREA.lift + PLAY_AREA.height + 0.0015;
/** Posición fija del carro dentro de la pista (+Z = hacia el jugador). */
export const CAR_Z = 0.02;
/**
 * Giro horizontal de la pista respecto al jugador (unos 20°): al verla un poco
 * en diagonal se aprecian mejor las subidas y los saltos. El volante y la
 * palanca siguen mirando al jugador de frente.
 */
export const TRACK_YAW = -0.35;
const VIEW_BEHIND = PLAY_AREA.length / 2 - CAR_Z + 0.03;
const VIEW_AHEAD = PLAY_AREA.length / 2 + CAR_Z + 0.03;
const RIBBON_SEGMENTS = 80;
export const CAR_LIMIT = ROAD_HALF_WIDTH - CAR_SIZE.width / 2 - 0.005;
/** Donde queda la pista cuando no hay sesión de RA (vista de escritorio). */
const DEFAULT_ROOT_POSITION = [0, 0.78, -0.55];
const POOL_PER_TYPE = 6;
export const FINISH_DISTANCE = TRACK.length - 1.2;
const INVULNERABLE_TIME = 1.2;
const DEBRIS_LIFETIME = 2.5;
const STEER_RATE = 0.22;
const OBSTACLE_HEIGHT = { cone: 0.03, barrel: 0.026, crate: 0.022 };
/**
 * Factor para mostrar la velocidad en "km/h" de un carro a escala 1:87 (H0).
 * Así 120 km/h son ~0,38 m/s sobre la mesa y da tiempo a reaccionar.
 */
export const SPEED_TO_KMH = 3.6 * 87;

// ------------------------------------------------------------ motor/marchas
export const GEAR_COUNT = 4;
/** Velocidad máxima de cada marcha (km/h). El índice 0 no se usa. */
export const GEAR_MAX_KMH = [0, 35, 60, 90, 120];
/** Aceleración a fondo en la banda de potencia (km/h por segundo). */
const GEAR_ACCEL = [0, 26, 18, 13, 10];
export const IDLE_RPM = 900;
export const REDLINE_RPM = 7000;
export const MAX_RPM = 8000;
const RPM_AT_GEAR_MAX = 7500;
/** Cuánta fuerza conserva cada marcha en subida y en barro. */
const HILL_FACTOR = [0, 1, 0.75, 0.15, 0.05];
const MUD_FACTOR = [0, 1, 0.8, 0.2, 0.08];
const ZONE_COLORS = {
  mud: [0.62, 0.45, 0.28],
  curve: [1, 0.8, 0.8],
  hill: [1, 0.96, 0.86],
};
const JUMP_LENGTH = 0.45;
const JUMP_HEIGHT = 0.05;

export class RaceSystem extends createSystem({
  roots: { required: [RaceState] },
  planes: { required: [XRPlane] },
}) {
  init() {
    // Temporales reutilizables (sin asignaciones por frame).
    this.carPose = { x: 0, y: 0, heading: 0 };
    this.samplePoseTmp = { x: 0, y: 0, heading: 0 };
    this.localTmp = { x: 0, z: 0, heading: 0 };
    this.statusText = 'Pulsa Iniciar para correr';
    this.hintText = '';
    this.vecA = new Vector3();
    this.vecB = new Vector3();
    this.quatA = new Quaternion();
    this.up = new Vector3(0, 1, 0);
    this.hitObstacles = new Uint8Array(TRACK.obstacles.length);
    this.zonePenalized = new Uint8Array(ZONES.length);
    this.invulnerable = 0;
    this.jumpStart = -1;
    this.debris = [];
    this.sound = new RaceSound();
    this.reticleValid = false;
    this.reticleOnTable = false;

    this.createEntities();
    this.resetRace();

    const keyDown = (event) => {
      if (event.code === 'Space' && this.phase !== RacePhase.Racing) {
        this.startRace();
      }
    };
    window.addEventListener('keydown', keyDown);
    this.cleanupFuncs.push(
      () => window.removeEventListener('keydown', keyDown),
      this.world.visibilityState.subscribe((state) => this.onVisibilityChange(state)),
      () => this.sound.stopEngine(),
    );
  }

  // ---------------------------------------------------------------- setup

  createEntities() {
    const world = this.world;
    this.root = world.createTransformEntity(new Group());
    this.root.object3D.name = 'race-root';
    this.root.addComponent(RaceState, { phase: RacePhase.Ready, lives: 3, placed: false, gear: 1 });
    this.root.object3D.position.fromArray(DEFAULT_ROOT_POSITION);

    // Marco de la pista, girado para verla un poco en diagonal.
    const trackFrame = new Group();
    trackFrame.name = 'track-frame';
    trackFrame.rotation.y = TRACK_YAW;
    this.track = world.createTransformEntity(trackFrame, { parent: this.root });

    // Base translúcida flotante con borde luminoso.
    const baseObject = createTrackBase();
    baseObject.traverse((child) => {
      child.receiveShadow = true;
    });
    this.base = world.createTransformEntity(baseObject, { parent: this.track });
    this.base.addComponent(DepthOccludable);

    // Cinta de asfalto que se regenera cada frame alrededor del carro.
    this.clipPlanesLocal = [
      new Plane(new Vector3(-1, 0, 0), PLAY_AREA.width / 2),
      new Plane(new Vector3(1, 0, 0), PLAY_AREA.width / 2),
      new Plane(new Vector3(0, 0, -1), PLAY_AREA.length / 2),
      new Plane(new Vector3(0, 0, 1), PLAY_AREA.length / 2),
    ];
    this.clipPlanes = this.clipPlanesLocal.map(() => new Plane());
    this.renderer.localClippingEnabled = true;

    const vertexCount = (RIBBON_SEGMENTS + 1) * 2;
    const geometry = new BufferGeometry();
    this.roadPositions = new Float32Array(vertexCount * 3);
    this.roadUvs = new Float32Array(vertexCount * 2);
    this.roadColors = new Float32Array(vertexCount * 3).fill(1);
    // Normales por fila: se inclinan en las subidas para que la luz las marque.
    this.roadNormals = new Float32Array(vertexCount * 3);
    const normals = this.roadNormals;
    for (let i = 0; i < vertexCount; i += 1) {
      normals[i * 3 + 1] = 1;
    }
    const indices = [];
    for (let i = 0; i < RIBBON_SEGMENTS; i += 1) {
      const l0 = i * 2;
      const r0 = l0 + 1;
      const l1 = l0 + 2;
      const r1 = l0 + 3;
      indices.push(l0, r0, l1, r0, r1, l1);
    }
    geometry.setAttribute('position', new BufferAttribute(this.roadPositions, 3));
    geometry.setAttribute('uv', new BufferAttribute(this.roadUvs, 2));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('color', new BufferAttribute(this.roadColors, 3));
    geometry.setIndex(indices);
    const roadMaterial = new MeshStandardMaterial({
      map: createRoadTexture(),
      roughness: 0.85,
      vertexColors: true,
      clippingPlanes: this.clipPlanes,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const roadMesh = new Mesh(geometry, roadMaterial);
    roadMesh.name = 'race-road';
    roadMesh.frustumCulled = false;
    roadMesh.receiveShadow = true;
    this.roadGeometry = geometry;
    this.road = world.createTransformEntity(roadMesh, { parent: this.track });
    this.road.addComponent(DepthOccludable);

    const clipped = (object) => {
      object.traverse((child) => {
        if (child.isMesh) {
          child.material = child.material.clone();
          child.material.clippingPlanes = this.clipPlanes;
        }
      });
      return object;
    };

    // Línea de meta.
    this.finish = world.createTransformEntity(clipped(createFinishLine(ROAD_HALF_WIDTH * 2)), { parent: this.track });
    this.finish.addComponent(DepthOccludable);

    // Rampa y señales de límite de velocidad de las curvas.
    this.zoneProps = [];
    for (const zone of ZONES) {
      let object = null;
      let lateral = 0;
      if (zone.type === 'ramp') {
        object = createRamp(ROAD_HALF_WIDTH * 1.8);
      } else if (zone.type === 'curve') {
        object = createSpeedSign(zone.limitKmh);
        lateral = -(ROAD_HALF_WIDTH + 0.025);
      }
      if (object == null) {
        continue;
      }
      object.visible = false;
      const entity = world.createTransformEntity(clipped(object), { parent: this.track });
      entity.addComponent(DepthOccludable);
      this.zoneProps.push({ zone, entity, lateral });
    }

    // Carro: se conduce con el volante (CockpitSystem).
    const carObject = createRaceCar();
    carObject.traverse((child) => {
      child.castShadow = true;
    });
    carObject.position.set(0, ROAD_Y, CAR_Z);
    this.car = world.createTransformEntity(carObject, { parent: this.track });
    this.car.addComponent(DepthOccludable);

    // Reserva de obstáculos que se reutilizan al pasar por la ventana visible.
    this.pools = {};
    this.poolUsage = {};
    for (const type of Object.keys(OBSTACLE_FACTORIES)) {
      this.pools[type] = [];
      this.poolUsage[type] = 0;
      for (let i = 0; i < POOL_PER_TYPE; i += 1) {
        const object = OBSTACLE_FACTORIES[type]();
        object.traverse((child) => {
          child.castShadow = true;
        });
        object.visible = false;
        const entity = world.createTransformEntity(object, { parent: this.track });
        entity.addComponent(DepthOccludable);
        this.pools[type].push(entity);
      }
    }

    // Indicador de colocación: lo mueve EnvironmentRaycastSystem.
    // El rectángulo del indicador se gira igual que la pista.
    const reticleShape = createPlacementReticle();
    reticleShape.rotation.y = TRACK_YAW;
    const reticleObject = new Group();
    reticleObject.name = 'placement-reticle';
    reticleObject.add(reticleShape);
    reticleObject.visible = false;
    this.reticle = world.createTransformEntity(reticleObject);
    this.reticleMaterial = reticleShape.children[0].material;

    this.rebuildStaticCollider();
  }

  /** Superficie física (la mesa) donde caen los obstáculos que salen volando. */
  rebuildStaticCollider() {
    if (this.tableCollider != null) {
      this.tableCollider.dispose();
    }
    const holder = new Group();
    holder.name = 'table-collider';
    // Caja gruesa (10 cm) con la cara superior al nivel de la base: si fuera
    // tan fina como la base, las piezas rápidas la atravesarían.
    const thickness = 0.1;
    const top = PLAY_AREA.lift + PLAY_AREA.height;
    const frame = this.track.object3D;
    frame.updateWorldMatrix(true, false);
    this.vecA.set(0, top - thickness / 2, 0);
    frame.localToWorld(this.vecA);
    holder.position.copy(this.vecA);
    frame.getWorldQuaternion(holder.quaternion);
    this.tableCollider = this.world.createTransformEntity(holder);
    this.tableCollider.addComponent(PhysicsShape, {
      shape: PhysicsShapeType.Box,
      dimensions: [0.9, thickness, 0.9],
      friction: 0.7,
    });
    this.tableCollider.addComponent(PhysicsBody, { state: PhysicsState.Static });
  }

  // ---------------------------------------------------------------- state

  get phase() {
    return this.root.getValue(RaceState, 'phase');
  }

  setPhase(phase) {
    this.root.setValue(RaceState, 'phase', phase);
  }

  /** Mensaje corto para el panel: lo lee el HudSystem. */
  setStatus(text) {
    this.statusText = text;
  }

  resetRace() {
    const state = this.root;
    state.setValue(RaceState, 'distance', 0);
    state.setValue(RaceState, 'speed', 0);
    state.setValue(RaceState, 'lives', 3);
    state.setValue(RaceState, 'elapsed', 0);
    state.setValue(RaceState, 'crashes', 0);
    state.setValue(RaceState, 'carOffset', 0);
    state.setValue(RaceState, 'gear', 1);
    state.setValue(RaceState, 'rpm', IDLE_RPM);
    state.setValue(RaceState, 'assist', 0);
    state.setValue(RaceState, 'zone', '');
    this.hitObstacles.fill(0);
    this.zonePenalized.fill(0);
    this.invulnerable = 0;
    this.jumpStart = -1;
    this.hintText = '';
    this.car.object3D.position.set(0, ROAD_Y, CAR_Z);
    this.car.object3D.visible = true;
    for (const item of this.debris) {
      item.entity.dispose();
    }
    this.debris.length = 0;
    this.sound.stopEngine();
    this.updateTrackVisuals();
  }

  /** Iniciar (o volver a empezar tras la meta o el fin de partida). */
  startRace() {
    const phase = this.phase;
    if (phase === RacePhase.Placing || phase === RacePhase.Racing) {
      return;
    }
    if (phase !== RacePhase.Ready) {
      this.resetRace();
    }
    this.setPhase(RacePhase.Racing);
    // La fuente del panel no tiene tildes ni "¡": los mensajes van en ASCII.
    this.setStatus('Acelera con el pulgar izquierdo (azul) y esquiva los obstaculos');
    this.sound.countdown();
    this.sound.startEngine();
  }

  restartRace() {
    if (this.phase === RacePhase.Placing) {
      return;
    }
    this.resetRace();
    this.setPhase(RacePhase.Ready);
    this.setStatus('Pulsa Iniciar para correr');
  }

  /** Cambio de marcha secuencial (+1 sube, -1 baja). */
  shift(delta) {
    const gear = this.root.getValue(RaceState, 'gear');
    const next = Math.max(1, Math.min(GEAR_COUNT, gear + delta));
    if (next !== gear) {
      this.root.setValue(RaceState, 'gear', next);
      this.sound.shift();
    }
  }

  // ------------------------------------------------------------ placement

  onVisibilityChange(state) {
    if (state === VisibilityState.NonImmersive) {
      this.stopPlacing();
      this.root.object3D.position.fromArray(DEFAULT_ROOT_POSITION);
      this.root.object3D.rotation.set(0, 0, 0);
      this.root.object3D.visible = true;
      this.root.setValue(RaceState, 'placed', false);
      this.rebuildStaticCollider();
      this.restartRace();
      return;
    }
    if (!this.root.getValue(RaceState, 'placed') && this.phase !== RacePhase.Placing) {
      this.beginPlacing();
    }
  }

  /** Muestra el indicador sobre la mesa y espera un pellizco para fijar la pista. */
  beginPlacing() {
    this.resetRace();
    this.setPhase(RacePhase.Placing);
    this.setStatus('Apunta a la mesa y pellizca para colocar la pista');
    this.root.object3D.visible = false;
    if (!this.reticle.hasComponent(EnvironmentRaycastTarget)) {
      this.reticle.addComponent(EnvironmentRaycastTarget, { space: RaycastSpace.Right, maxDistance: 3 });
    }
    this.setPlaneWireframe(true);
  }

  stopPlacing() {
    if (this.reticle.hasComponent(EnvironmentRaycastTarget)) {
      this.reticle.removeComponent(EnvironmentRaycastTarget);
    }
    this.reticle.object3D.visible = false;
    this.setPlaneWireframe(false);
  }

  setPlaneWireframe(enabled) {
    const sceneUnderstanding = this.world.getSystem(SceneUnderstandingSystem);
    if (sceneUnderstanding?.config?.showWireFrame != null) {
      sceneUnderstanding.config.showWireFrame.value = enabled;
    }
  }

  updatePlacing() {
    const reticle = this.reticle.object3D;
    this.reticleValid = false;
    this.reticleOnTable = false;
    if (reticle.visible) {
      reticle.getWorldPosition(this.vecA);
      reticle.getWorldQuaternion(this.quatA);
      this.vecB.copy(this.up).applyQuaternion(this.quatA);
      this.reticleValid = this.vecB.y > 0.9;
      // Scene Understanding: ¿hay un plano horizontal detectado a esa altura?
      for (const planeEntity of this.queries.planes.entities) {
        const plane = planeEntity.getValue(XRPlane, '_plane');
        if (plane?.orientation !== 'horizontal' || planeEntity.object3D == null) {
          continue;
        }
        planeEntity.object3D.getWorldPosition(this.vecB);
        const sameHeight = Math.abs(this.vecB.y - this.vecA.y) < 0.05;
        if (sameHeight && (plane.semanticLabel === 'table' || this.vecA.y > 0.35)) {
          this.reticleOnTable = true;
        }
      }
      const color = !this.reticleValid ? '#ff5a5a' : this.reticleOnTable ? '#3dff8a' : '#2ad4ff';
      this.reticleMaterial.color.set(color);
      this.reticleMaterial.emissive.set(color);
      // Orienta el indicador para que la pista avance alejándose del jugador.
      this.player.head.getWorldPosition(this.vecB);
      reticle.rotation.set(0, Math.atan2(this.vecB.x - this.vecA.x, this.vecB.z - this.vecA.z), 0);
    }

    const xr = this.input.xr;
    const pinched = xr?.getSelectState?.('right')?.start || xr?.getSelectState?.('left')?.start;
    if (pinched && reticle.visible && this.reticleValid) {
      this.placeAt(this.vecA, reticle.rotation.y);
    }
  }

  placeAt(position, yaw) {
    this.stopPlacing();
    const root = this.root.object3D;
    root.position.copy(position);
    root.rotation.set(0, yaw, 0);
    root.visible = true;
    this.root.setValue(RaceState, 'placed', true);
    this.rebuildStaticCollider();
    this.setPhase(RacePhase.Ready);
    this.setStatus('Pulsa Iniciar para correr');
  }

  /** Volver a colocar la pista (botón "Mover pista"). */
  movePlacement() {
    if (this.world.visibilityState.peek() === VisibilityState.NonImmersive) {
      return;
    }
    this.root.setValue(RaceState, 'placed', false);
    this.beginPlacing();
  }

  // ---------------------------------------------------------------- frame

  update(delta) {
    const dt = Math.min(delta, 0.05);
    const phase = this.phase;

    if (phase === RacePhase.Placing) {
      this.updatePlacing();
      return;
    }

    this.updateCarControl(dt);
    if (phase === RacePhase.Racing && this.world.visibilityState.peek() !== VisibilityState.VisibleBlurred) {
      this.updateRace(dt);
    } else {
      this.updateIdleEngine(dt);
    }
    this.updateTrackVisuals();
    this.updateDebris(dt);
  }

  updateCarControl(dt) {
    const state = this.root;
    const car = this.car.object3D;
    const steer = state.getValue(RaceState, 'steer');
    const speedKmh = state.getValue(RaceState, 'speed') * SPEED_TO_KMH;
    // Se gira mejor en movimiento; parado apenas se desplaza.
    const grip = Math.min(1, 0.25 + speedKmh / 40);
    if (this.phase === RacePhase.Racing) {
      car.position.x += steer * STEER_RATE * grip * dt;
    }
    car.position.x = Math.min(CAR_LIMIT, Math.max(-CAR_LIMIT, car.position.x));
    car.rotation.set(0, -steer * 0.35, 0);
    state.setValue(RaceState, 'carOffset', car.position.x);
  }

  /** Sin carrera: RPM al ralentí (o subiendo si se pisa el acelerador). */
  updateIdleEngine(dt) {
    const state = this.root;
    const throttle = state.getValue(RaceState, 'throttle');
    const target = IDLE_RPM + throttle * 3000;
    const rpm = state.getValue(RaceState, 'rpm');
    state.setValue(RaceState, 'rpm', rpm + (target - rpm) * Math.min(1, dt * 6));
  }

  updateRace(dt) {
    const state = this.root;
    let distance = state.getValue(RaceState, 'distance');
    let kmh = state.getValue(RaceState, 'speed') * SPEED_TO_KMH;
    const gear = state.getValue(RaceState, 'gear');
    const throttle = state.getValue(RaceState, 'throttle');
    const brake = state.getValue(RaceState, 'brake');
    const zone = this.jumpStart >= 0 ? null : zoneAt(distance);

    // RPM según la velocidad y la marcha.
    const rpm = IDLE_RPM + (kmh / GEAR_MAX_KMH[gear]) * (RPM_AT_GEAR_MAX - IDLE_RPM);
    // Fuerza del motor: en 1ª y 2ª siempre empuja (el embrague patina al
    // arrancar); en 3ª y 4ª con pocas RPM se "ahoga", y cerca del corte
    // pierde fuerza.
    let torque = 1;
    if (gear > 2 && rpm < 1800) {
      torque = 0.3;
    } else if (rpm > 6800) {
      torque = Math.max(0, (RPM_AT_GEAR_MAX - rpm) / (RPM_AT_GEAR_MAX - 6800));
    }
    let power = throttle * GEAR_ACCEL[gear] * torque;
    let drag = 1.5 + kmh * 0.02 + (throttle > 0 ? 0 : 3 + gear);
    if (zone?.type === 'hill') {
      power *= HILL_FACTOR[gear];
      drag += 8;
    } else if (zone?.type === 'mud') {
      power *= MUD_FACTOR[gear];
      drag += 6 + kmh * 0.15;
    }
    // Pasado el máximo de la marcha (reducción brusca), el motor frena fuerte.
    if (kmh > GEAR_MAX_KMH[gear]) {
      drag += 10 + (kmh - GEAR_MAX_KMH[gear]) * 1.5;
    }
    kmh += (power - drag - brake * 45) * dt;
    kmh = Math.max(0, kmh);

    // Curva cerrada: si entras por encima del límite, derrapas.
    if (zone?.type === 'curve') {
      const index = ZONES.indexOf(zone);
      if (!this.zonePenalized[index] && kmh > zone.limitKmh + 5) {
        this.zonePenalized[index] = 1;
        kmh *= 0.45;
        this.setStatus(`Derrape! Entra a la curva a menos de ${zone.limitKmh} km/h`);
        this.sound.skid();
      }
    }

    // Rampa: con 4ª y velocidad suficiente saltas; si no, el carro se frena
    // en seco y retrocede un poco para volver a intentarlo.
    for (let i = 0; i < ZONES.length; i += 1) {
      const ramp = ZONES[i];
      if (ramp.type !== 'ramp' || this.jumpStart >= 0) {
        continue;
      }
      if (distance < ramp.start && distance + (kmh / SPEED_TO_KMH) * dt >= ramp.start) {
        if (gear === 4 && kmh >= ramp.minKmh) {
          this.jumpStart = ramp.start;
          this.setStatus('Gran salto!');
          this.sound.finish();
        } else {
          kmh = 0;
          distance = ramp.start - 1.5;
          this.setStatus(`Sin impulso: llega a la rampa en 4a y a ${ramp.minKmh} km/h`);
          this.sound.skid();
        }
      }
    }
    if (this.jumpStart >= 0 && distance > this.jumpStart + JUMP_LENGTH) {
      this.jumpStart = -1;
    }

    const speed = kmh / SPEED_TO_KMH;
    distance += speed * dt;
    state.setValue(RaceState, 'speed', speed);
    state.setValue(RaceState, 'distance', distance);
    state.setValue(RaceState, 'elapsed', state.getValue(RaceState, 'elapsed') + dt);
    const shownRpm = Math.min(MAX_RPM, IDLE_RPM + (kmh / GEAR_MAX_KMH[gear]) * (RPM_AT_GEAR_MAX - IDLE_RPM));
    state.setValue(RaceState, 'rpm', shownRpm);
    this.sound.setEngineSpeed((shownRpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM));
    this.updateAssist(distance, gear, shownRpm, kmh);

    if (this.invulnerable > 0) {
      this.invulnerable -= dt;
      this.car.object3D.visible = this.invulnerable <= 0 || Math.floor(this.invulnerable * 10) % 2 === 0;
    }

    if (this.jumpStart < 0) {
      this.checkCollisions(distance);
    }

    if (this.phase !== RacePhase.Racing) {
      return;
    }
    if (distance >= FINISH_DISTANCE) {
      this.setPhase(RacePhase.Finished);
      this.car.object3D.visible = true;
      this.setStatus('META! Pulsa Iniciar para otra carrera');
      this.sound.stopEngine();
      this.sound.finish();
    }
  }

  /**
   * Asistencia de cambio: antes de un tramo especial recomienda la marcha
   * que pide; fuera de ellos, sube cerca del corte y baja si el motor se ahoga.
   */
  updateAssist(distance, gear, rpm, kmh) {
    const state = this.root;
    const zone = upcomingZone(distance, 1.2);
    let assist = 0;
    let hint = '';
    if (zone != null) {
      if (zone.type === 'ramp') {
        if (gear < 4) assist = 1;
        hint = `Rampa: 4ª y +${zone.minKmh} km/h`;
      } else {
        if (gear > zone.gear) assist = -1;
        const name = zone.type === 'hill' ? 'Subida' : zone.type === 'mud' ? 'Barro' : `Curva ${zone.limitKmh} km/h`;
        hint = `${name}: ${zone.type === 'curve' ? 'frena y ' : ''}${assist < 0 ? 'baja' : 'usa'} a ${zone.gear}ª`;
      }
    } else if (rpm > 6600 && gear < GEAR_COUNT) {
      assist = 1;
      hint = 'Sube de marcha';
    } else if (gear > 1 && rpm < 1800 && kmh > 1) {
      assist = -1;
      hint = 'Baja de marcha';
    }
    state.setValue(RaceState, 'assist', assist);
    state.setValue(RaceState, 'zone', zone?.type ?? '');
    this.hintText = hint;
  }

  checkCollisions(distance) {
    if (this.invulnerable > 0) {
      return;
    }
    const carOffset = this.root.getValue(RaceState, 'carOffset');
    const obstacles = TRACK.obstacles;
    for (let i = 0; i < obstacles.length; i += 1) {
      const obstacle = obstacles[i];
      if (obstacle.s > distance + 0.1) {
        break;
      }
      if (this.hitObstacles[i] || obstacle.s < distance - 0.1) {
        continue;
      }
      const radius = OBSTACLE_RADIUS[obstacle.type];
      const alongHit = Math.abs(obstacle.s - distance) < CAR_SIZE.length / 2 + radius;
      const sideHit = Math.abs(obstacle.lateral - carOffset) < CAR_SIZE.width / 2 + radius;
      if (alongHit && sideHit) {
        this.onCrash(i, carOffset);
        return;
      }
    }
  }

  onCrash(index, carOffset) {
    const state = this.root;
    this.hitObstacles[index] = 1;
    const lives = state.getValue(RaceState, 'lives') - 1;
    state.setValue(RaceState, 'lives', lives);
    state.setValue(RaceState, 'crashes', state.getValue(RaceState, 'crashes') + 1);
    state.setValue(RaceState, 'speed', state.getValue(RaceState, 'speed') * 0.3);
    this.invulnerable = INVULNERABLE_TIME;
    this.spawnDebris(index, carOffset);
    this.sound.crash();
    if (lives <= 0) {
      this.setPhase(RacePhase.GameOver);
      this.car.object3D.visible = true;
      this.setStatus('Fin de la partida. Pulsa Iniciar para reintentar');
      this.sound.stopEngine();
      this.sound.gameOver();
    } else {
      this.setStatus(`Choque! Te quedan ${lives} ${lives === 1 ? 'vida' : 'vidas'}`);
    }
  }

  /** El obstáculo golpeado se convierte en un cuerpo físico que sale volando. */
  spawnDebris(index, carOffset) {
    const obstacle = TRACK.obstacles[index];
    const height = OBSTACLE_HEIGHT[obstacle.type];
    this.toLocal(obstacle.s, obstacle.lateral, this.localTmp);
    this.vecA.set(this.localTmp.x, ROAD_Y + elevationAt(obstacle.s) + height / 2 + 0.002, this.localTmp.z);
    const frame = this.track.object3D;
    frame.updateWorldMatrix(true, false);
    frame.localToWorld(this.vecA);
    frame.getWorldQuaternion(this.quatA);

    const model = OBSTACLE_FACTORIES[obstacle.type]();
    model.position.y = -height / 2;
    model.traverse((child) => {
      child.castShadow = true;
    });
    const holder = new Group();
    holder.name = `debris-${obstacle.type}`;
    holder.add(model);
    holder.position.copy(this.vecA);
    holder.quaternion.copy(this.quatA);

    const side = Math.sign(obstacle.lateral - carOffset) || 1;
    this.vecB.set(side * 0.45, 0.8, -0.3).applyQuaternion(this.quatA);
    const entity = this.world.createTransformEntity(holder);
    entity.addComponent(PhysicsShape, {
      shape: PhysicsShapeType.Box,
      dimensions: [0.024, height, 0.024],
      restitution: 0.35,
      friction: 0.6,
    });
    entity.addComponent(PhysicsBody, { state: PhysicsState.Dynamic });
    entity.addComponent(PhysicsManipulation, {
      linearVelocity: [this.vecB.x, this.vecB.y, this.vecB.z],
      angularVelocity: [side * 8, 3, -side * 6],
    });
    entity.addComponent(DepthOccludable);
    this.debris.push({ entity, age: 0 });
  }

  updateDebris(dt) {
    for (let i = this.debris.length - 1; i >= 0; i -= 1) {
      const item = this.debris[i];
      item.age += dt;
      if (item.age > DEBRIS_LIFETIME) {
        item.entity.dispose();
        this.debris.splice(i, 1);
      }
    }
  }

  // --------------------------------------------------------- track visuals

  /** Convierte un punto de la pista (distancia, desplazamiento lateral) a local. */
  toLocal(s, lateral, out) {
    const pose = samplePose(s, this.samplePoseTmp);
    const mx = pose.x + Math.cos(pose.heading) * lateral;
    const my = pose.y - Math.sin(pose.heading) * lateral;
    const car = this.carPose;
    const dx = mx - car.x;
    const dy = my - car.y;
    const sinH = Math.sin(car.heading);
    const cosH = Math.cos(car.heading);
    out.x = dx * cosH - dy * sinH;
    out.z = CAR_Z - (dx * sinH + dy * cosH);
    out.heading = pose.heading - car.heading;
    return out;
  }

  /** Altura del salto sobre la rampa (parábola). */
  jumpHeight(distance) {
    if (this.jumpStart < 0) {
      return 0;
    }
    const t = Math.min(1, Math.max(0, (distance - this.jumpStart) / JUMP_LENGTH));
    return JUMP_HEIGHT * 4 * t * (1 - t);
  }

  updateTrackVisuals() {
    const distance = this.root.getValue(RaceState, 'distance');
    samplePose(distance, this.carPose);

    // Planos de recorte en coordenadas de mundo (la pista no sale de la base).
    const frame = this.track.object3D;
    frame.updateWorldMatrix(true, false);
    for (let i = 0; i < this.clipPlanes.length; i += 1) {
      this.clipPlanes[i].copy(this.clipPlanesLocal[i]).applyMatrix4(frame.matrixWorld);
    }

    // El carro sigue la altura de la pista (subidas) y del salto, y se
    // inclina con la pendiente.
    const carObject = this.car.object3D;
    carObject.position.y = ROAD_Y + elevationAt(distance) + this.jumpHeight(distance);
    carObject.rotation.x = Math.atan(slopeAt(distance));

    // Cinta de asfalto con color por tramo (barro, curva, subida).
    const span = VIEW_BEHIND + VIEW_AHEAD;
    const positions = this.roadPositions;
    const uvs = this.roadUvs;
    const colors = this.roadColors;
    const normals = this.roadNormals;
    for (let i = 0; i <= RIBBON_SEGMENTS; i += 1) {
      const s = distance - VIEW_BEHIND + (span * i) / RIBBON_SEGMENTS;
      const y = ROAD_Y + elevationAt(s);
      const left = this.toLocal(s, -ROAD_HALF_WIDTH, this.localTmp);
      let p = i * 6;
      positions[p] = left.x;
      positions[p + 1] = y;
      positions[p + 2] = left.z;
      const right = this.toLocal(s, ROAD_HALF_WIDTH, this.localTmp);
      p += 3;
      positions[p] = right.x;
      positions[p + 1] = y;
      positions[p + 2] = right.z;
      // Normal = arriba menos pendiente × dirección de avance (local).
      const slope = slopeAt(s);
      const h = right.heading;
      const nx = -slope * Math.sin(h);
      const nz = slope * Math.cos(h);
      const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      for (let k = 0; k < 2; k += 1) {
        const n = i * 6 + k * 3;
        normals[n] = nx * inv;
        normals[n + 1] = inv;
        normals[n + 2] = nz * inv;
      }
      const v = s / TEXTURE_REPEAT_LENGTH;
      uvs[i * 4] = 0;
      uvs[i * 4 + 1] = v;
      uvs[i * 4 + 2] = 1;
      uvs[i * 4 + 3] = v;
      const zone = zoneAt(s);
      const color = zone != null ? ZONE_COLORS[zone.type] : null;
      for (let k = 0; k < 2; k += 1) {
        const c = i * 6 + k * 3;
        colors[c] = color ? color[0] : 1;
        colors[c + 1] = color ? color[1] : 1;
        colors[c + 2] = color ? color[2] : 1;
      }
    }
    const attributes = this.roadGeometry.attributes;
    attributes.position.needsUpdate = true;
    attributes.uv.needsUpdate = true;
    attributes.color.needsUpdate = true;
    attributes.normal.needsUpdate = true;

    // Línea de meta, rampa y señales.
    this.placeProp(this.finish.object3D, FINISH_DISTANCE, 0, distance);
    for (const prop of this.zoneProps) {
      this.placeProp(prop.entity.object3D, prop.zone.start, prop.lateral, distance);
    }

    // Obstáculos visibles en la ventana.
    for (const type in this.poolUsage) {
      this.poolUsage[type] = 0;
    }
    const halfW = PLAY_AREA.width / 2;
    const halfL = PLAY_AREA.length / 2;
    const obstacles = TRACK.obstacles;
    for (let i = 0; i < obstacles.length; i += 1) {
      const obstacle = obstacles[i];
      if (obstacle.s > distance + VIEW_AHEAD) {
        break;
      }
      if (obstacle.s < distance - VIEW_BEHIND || this.hitObstacles[i]) {
        continue;
      }
      const local = this.toLocal(obstacle.s, obstacle.lateral, this.localTmp);
      const radius = OBSTACLE_RADIUS[obstacle.type];
      if (Math.abs(local.x) > halfW - radius || Math.abs(local.z) > halfL - radius) {
        continue;
      }
      const pool = this.pools[obstacle.type];
      const used = this.poolUsage[obstacle.type];
      if (used >= pool.length) {
        continue;
      }
      this.poolUsage[obstacle.type] = used + 1;
      const object = pool[used].object3D;
      object.visible = true;
      object.position.set(local.x, ROAD_Y + elevationAt(obstacle.s), local.z);
      object.rotation.set(0, -local.heading + i * 0.7, 0);
    }
    for (const type in this.pools) {
      const pool = this.pools[type];
      for (let i = this.poolUsage[type]; i < pool.length; i += 1) {
        pool[i].object3D.visible = false;
      }
    }
  }

  /** Coloca un objeto fijo de la pista si está dentro de la ventana visible. */
  placeProp(object, s, lateral, distance) {
    const visible = s > distance - VIEW_BEHIND && s < distance + VIEW_AHEAD;
    object.visible = visible;
    if (visible) {
      const local = this.toLocal(s, lateral, this.localTmp);
      object.position.set(local.x, ROAD_Y + elevationAt(s) + 0.0002, local.z);
      object.rotation.set(0, -local.heading, 0);
    }
  }
}
