/**
 * Lógica principal del juego de carreras:
 *  - colocación de la pista sobre la mesa (hit-test + planos detectados),
 *  - la pista avanza bajo el carro (el carro no se desplaza hacia adelante),
 *  - el carro se agarra con la mano y sólo se mueve a izquierda/derecha,
 *  - choques con obstáculos (salen volando con física), vidas y meta.
 *
 * Coordenadas locales de la pista ("race-root"): +X a la derecha del
 * jugador, +Y arriba, +Z hacia el jugador. El carro mira hacia -Z.
 */
import {
  BufferAttribute,
  BufferGeometry,
  createSystem,
  DepthOccludable,
  EnvironmentRaycastTarget,
  Grabbed,
  GrabSystem,
  Group,
  Mesh,
  MeshStandardMaterial,
  OneHandGrabbable,
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
  createTrackBase,
  OBSTACLE_FACTORIES,
  OBSTACLE_RADIUS,
  PLAY_AREA,
} from '../scene-assets/race.scene-asset.js';
import { RaceSound } from './sound.js';
import { createRoadTexture, ROAD_HALF_WIDTH, samplePose, TEXTURE_REPEAT_LENGTH, TRACK } from './track.js';

const ROAD_Y = PLAY_AREA.height + 0.0006;
/** Posición fija del carro sobre la zona de juego (cerca del jugador). */
export const CAR_Z = 0.17;
const VIEW_BEHIND = PLAY_AREA.length / 2 - CAR_Z + 0.03;
const VIEW_AHEAD = PLAY_AREA.length / 2 + CAR_Z + 0.03;
const RIBBON_SEGMENTS = 72;
export const CAR_LIMIT = ROAD_HALF_WIDTH - CAR_SIZE.width / 2 - 0.005;
/** Donde queda la pista cuando no hay sesión de RA (vista de escritorio). */
const DEFAULT_ROOT_POSITION = [0, 0.78, -0.55];
const POOL_PER_TYPE = 6;
export const FINISH_DISTANCE = TRACK.length - 1.2;
const BASE_SPEED = 0.16;
const SPEED_GAIN = 0.3;
export const MAX_SPEED = BASE_SPEED + SPEED_GAIN;
const INVULNERABLE_TIME = 1.2;
const DEBRIS_LIFETIME = 2.5;
const KEYBOARD_SPEED = 0.25;
const OBSTACLE_HEIGHT = { cone: 0.03, barrel: 0.026, crate: 0.022 };
/** Factor para mostrar la velocidad en "km/h" de un carro a escala 1:64. */
export const SPEED_TO_KMH = 3.6 * 64;

export class RaceSystem extends createSystem({
  roots: { required: [RaceState] },
  planes: { required: [XRPlane] },
  grabbedCars: { required: [OneHandGrabbable, Grabbed] },
}) {
  init() {
    // Temporales reutilizables (sin asignaciones por frame).
    this.carPose = { x: 0, y: 0, heading: 0 };
    this.samplePoseTmp = { x: 0, y: 0, heading: 0 };
    this.localTmp = { x: 0, z: 0, heading: 0 };
    this.statusText = 'Pulsa Iniciar para correr';
    this.vecA = new Vector3();
    this.vecB = new Vector3();
    this.quatA = new Quaternion();
    this.up = new Vector3(0, 1, 0);
    this.hitObstacles = new Uint8Array(TRACK.obstacles.length);
    this.invulnerable = 0;
    this.debris = [];
    this.keys = { left: false, right: false };
    this.sound = new RaceSound();
    this.reticleValid = false;
    this.reticleOnTable = false;

    this.createEntities();
    this.resetRace();

    const onKey = (event, down) => {
      if (event.code === 'ArrowLeft' || event.code === 'KeyA') {
        this.keys.left = down;
      } else if (event.code === 'ArrowRight' || event.code === 'KeyD') {
        this.keys.right = down;
      } else if (down && event.code === 'Space') {
        const phase = this.phase;
        if (phase === RacePhase.Racing) {
          return;
        }
        this.startRace();
      }
    };
    const keyDown = (event) => onKey(event, true);
    const keyUp = (event) => onKey(event, false);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    this.cleanupFuncs.push(
      () => window.removeEventListener('keydown', keyDown),
      () => window.removeEventListener('keyup', keyUp),
      this.world.visibilityState.subscribe((state) => this.onVisibilityChange(state)),
      () => this.sound.stopEngine(),
    );
  }

  // ---------------------------------------------------------------- setup

  createEntities() {
    const world = this.world;
    this.root = world.createTransformEntity(new Group());
    this.root.object3D.name = 'race-root';
    this.root.addComponent(RaceState, { phase: RacePhase.Ready, lives: 3, placed: false });
    this.root.object3D.position.fromArray(DEFAULT_ROOT_POSITION);

    // Base translúcida con borde luminoso.
    const baseObject = createTrackBase();
    baseObject.traverse((child) => {
      child.receiveShadow = true;
    });
    this.base = world.createTransformEntity(baseObject, { parent: this.root });
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
    const normals = new Float32Array(vertexCount * 3);
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
    geometry.setIndex(indices);
    const roadMaterial = new MeshStandardMaterial({
      map: createRoadTexture(),
      roughness: 0.85,
      clippingPlanes: this.clipPlanes,
    });
    const roadMesh = new Mesh(geometry, roadMaterial);
    roadMesh.name = 'race-road';
    roadMesh.frustumCulled = false;
    roadMesh.receiveShadow = true;
    this.roadGeometry = geometry;
    this.road = world.createTransformEntity(roadMesh, { parent: this.root });
    this.road.addComponent(DepthOccludable);

    // Línea de meta.
    const finishObject = createFinishLine(ROAD_HALF_WIDTH * 2);
    finishObject.traverse((child) => {
      if (child.isMesh) {
        child.material = child.material.clone();
        child.material.clippingPlanes = this.clipPlanes;
      }
    });
    this.finish = world.createTransformEntity(finishObject, { parent: this.root });
    this.finish.addComponent(DepthOccludable);

    // Carro: se agarra con la mano y sólo se desliza a lo ancho de la pista.
    const carObject = createRaceCar();
    carObject.traverse((child) => {
      child.castShadow = true;
    });
    carObject.position.set(0, ROAD_Y, CAR_Z);
    this.car = world.createTransformEntity(carObject, { parent: this.root });
    this.car.addComponent(OneHandGrabbable, {
      rotate: false,
      translate: true,
      translateMin: [-CAR_LIMIT, ROAD_Y, CAR_Z],
      translateMax: [CAR_LIMIT, ROAD_Y, CAR_Z],
    });
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
        const entity = world.createTransformEntity(object, { parent: this.root });
        entity.addComponent(DepthOccludable);
        this.pools[type].push(entity);
      }
    }

    // Indicador de colocación: lo mueve EnvironmentRaycastSystem.
    const reticleObject = createPlacementReticle();
    reticleObject.visible = false;
    this.reticle = world.createTransformEntity(reticleObject);
    this.reticleMaterial = reticleObject.children[0].material;

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
    this.root.object3D.updateWorldMatrix(true, false);
    this.vecA.set(0, PLAY_AREA.height - thickness / 2, 0);
    this.root.object3D.localToWorld(this.vecA);
    holder.position.copy(this.vecA);
    holder.quaternion.copy(this.root.object3D.quaternion);
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
    const grab = this.world.getSystem(GrabSystem);
    if (grab != null && this.car.hasComponent(Grabbed)) {
      grab.forceRelease(this.car);
    }
    this.root.setValue(RaceState, 'distance', 0);
    this.root.setValue(RaceState, 'speed', 0);
    this.root.setValue(RaceState, 'lives', 3);
    this.root.setValue(RaceState, 'elapsed', 0);
    this.root.setValue(RaceState, 'crashes', 0);
    this.root.setValue(RaceState, 'carOffset', 0);
    this.hitObstacles.fill(0);
    this.invulnerable = 0;
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
    this.setStatus('Agarra el carro y esquiva los obstaculos');
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
    }
    this.updateTrackVisuals();
    this.updateDebris(dt);
  }

  updateCarControl(dt) {
    const car = this.car.object3D;
    if (!this.car.hasComponent(Grabbed)) {
      const dir = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
      car.position.x += dir * KEYBOARD_SPEED * dt;
    }
    // Restricción: sólo movimiento lateral dentro de la pista.
    car.position.x = Math.min(CAR_LIMIT, Math.max(-CAR_LIMIT, car.position.x));
    car.position.y = ROAD_Y;
    car.position.z = CAR_Z;
    car.rotation.set(0, 0, 0);
    this.root.setValue(RaceState, 'carOffset', car.position.x);
  }

  updateRace(dt) {
    const root = this.root;
    let distance = root.getValue(RaceState, 'distance');
    let speed = root.getValue(RaceState, 'speed');
    const target = BASE_SPEED + SPEED_GAIN * Math.min(1, distance / FINISH_DISTANCE);
    speed += (target - speed) * Math.min(1, dt * 1.2);
    distance += speed * dt;
    root.setValue(RaceState, 'speed', speed);
    root.setValue(RaceState, 'distance', distance);
    root.setValue(RaceState, 'elapsed', root.getValue(RaceState, 'elapsed') + dt);
    this.sound.setEngineSpeed(speed / MAX_SPEED);

    if (this.invulnerable > 0) {
      this.invulnerable -= dt;
      this.car.object3D.visible = this.invulnerable <= 0 || Math.floor(this.invulnerable * 10) % 2 === 0;
    }

    this.checkCollisions(distance);

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
    const root = this.root;
    this.hitObstacles[index] = 1;
    const lives = root.getValue(RaceState, 'lives') - 1;
    root.setValue(RaceState, 'lives', lives);
    root.setValue(RaceState, 'crashes', root.getValue(RaceState, 'crashes') + 1);
    root.setValue(RaceState, 'speed', root.getValue(RaceState, 'speed') * 0.3);
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
    this.vecA.set(this.localTmp.x, ROAD_Y + height / 2 + 0.002, this.localTmp.z);
    this.root.object3D.updateWorldMatrix(true, false);
    this.root.object3D.localToWorld(this.vecA);

    const model = OBSTACLE_FACTORIES[obstacle.type]();
    model.position.y = -height / 2;
    model.traverse((child) => {
      child.castShadow = true;
    });
    const holder = new Group();
    holder.name = `debris-${obstacle.type}`;
    holder.add(model);
    holder.position.copy(this.vecA);
    holder.quaternion.copy(this.root.object3D.quaternion);

    const side = Math.sign(obstacle.lateral - carOffset) || 1;
    this.vecB.set(side * 0.45, 0.8, -0.3).applyQuaternion(this.root.object3D.quaternion);
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

  updateTrackVisuals() {
    const distance = this.root.getValue(RaceState, 'distance');
    samplePose(distance, this.carPose);

    // Planos de recorte en coordenadas de mundo (la pista no sale de la base).
    const rootObject = this.root.object3D;
    rootObject.updateWorldMatrix(true, false);
    for (let i = 0; i < this.clipPlanes.length; i += 1) {
      this.clipPlanes[i].copy(this.clipPlanesLocal[i]).applyMatrix4(rootObject.matrixWorld);
    }

    // Cinta de asfalto.
    const span = VIEW_BEHIND + VIEW_AHEAD;
    const positions = this.roadPositions;
    const uvs = this.roadUvs;
    for (let i = 0; i <= RIBBON_SEGMENTS; i += 1) {
      const s = distance - VIEW_BEHIND + (span * i) / RIBBON_SEGMENTS;
      const left = this.toLocal(s, -ROAD_HALF_WIDTH, this.localTmp);
      let p = i * 6;
      positions[p] = left.x;
      positions[p + 1] = ROAD_Y;
      positions[p + 2] = left.z;
      const right = this.toLocal(s, ROAD_HALF_WIDTH, this.localTmp);
      p += 3;
      positions[p] = right.x;
      positions[p + 1] = ROAD_Y;
      positions[p + 2] = right.z;
      const v = s / TEXTURE_REPEAT_LENGTH;
      uvs[i * 4] = 0;
      uvs[i * 4 + 1] = v;
      uvs[i * 4 + 2] = 1;
      uvs[i * 4 + 3] = v;
    }
    this.roadGeometry.attributes.position.needsUpdate = true;
    this.roadGeometry.attributes.uv.needsUpdate = true;

    // Línea de meta.
    const finishObject = this.finish.object3D;
    const finishVisible = Math.abs(FINISH_DISTANCE - distance) < span;
    finishObject.visible = finishVisible;
    if (finishVisible) {
      const local = this.toLocal(FINISH_DISTANCE, 0, this.localTmp);
      finishObject.position.set(local.x, ROAD_Y + 0.0002, local.z);
      finishObject.rotation.set(0, -local.heading, 0);
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
      object.position.set(local.x, ROAD_Y, local.z);
      object.rotation.set(0, -local.heading + i * 0.7, 0);
    }
    for (const type in this.pools) {
      const pool = this.pools[type];
      for (let i = this.poolUsage[type]; i < pool.length; i += 1) {
        pool[i].object3D.visible = false;
      }
    }
  }
}
