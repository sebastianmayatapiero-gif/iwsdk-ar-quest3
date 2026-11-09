/**
 * Cabina: volante, botones de acelerar/frenar y palanca de cambios.
 *
 *  - Volante: sólo se mueve con prensión digitopalmar (índice, medio y anular
 *    flexionados contra la palma, pulgar libre) y sólo en las empuñaduras de
 *    las 9 (mano izquierda) y las 3 (mano derecha), junto a los botones.
 *    Con las dos manos usa el ángulo entre ellas; con una, cómo gira
 *    alrededor del centro. Sin manos vuelve solo al centro.
 *  - Botones: azul (izquierda) acelera y rojo (derecha) frena mientras el
 *    pulgar está apoyado encima. Con controles: gatillo izquierdo acelera y
 *    derecho frena; el botón lateral (squeeze) equivale a cerrar la mano.
 *  - Palanca secuencial: sólo con agarre de bola (dedos semiflexionados
 *    rodeando el pomo y pulgar separado; una pinza no sirve). Empuja hacia
 *    adelante para subir de marcha o tira hacia atrás para bajar. Vuelve
 *    sola al centro.
 *  - Teclado (escritorio): flechas o A/D giran, W/flecha arriba acelera,
 *    S/flecha abajo frena, E sube y Q baja de marcha.
 *
 * Escribe steer, throttle y brake en RaceState; los cambios llaman a
 * RaceSystem.shift().
 */
import { createSystem, Vector3, VisibilityState } from '@iwsdk/core';
import { RaceState } from '../race-components.js';
import { createGearKnob, createGearLever, createSteeringWheel, LEVER, WHEEL } from '../scene-assets/race.scene-asset.js';
import { RaceSystem } from './race-system.js';

/** Posición de la cabina en coordenadas del ancla (delante de la pista). */
export const WHEEL_POSITION = [0, 0, 0.47];
const LEVER_POSITION = [0.22, 0, 0.5];
const MAX_WHEEL_ANGLE = 1.75;
const FULL_STEER_ANGLE = 1.4;
const DEAD_ZONE = 0.09;
// El punto de agarre de la mano está en la palma, unos 5 cm fuera del aro.
const RIM_TOLERANCE = 0.075;
const RIM_RELEASE_TOLERANCE = 0.1;
const RIM_DEPTH = 0.1;
/** Media apertura (rad) de las empuñaduras de las 9 y las 3. */
const GRIP_ZONE = 0.5;
/** Índice de flexión (punta-muñeca / nudillo-muñeca): ~2 extendido, ~1 cerrado. */
const PALMAR_MAX_CURL = 1.45;
const BALL_MIN_CURL = 1.35;
const BALL_MAX_CURL = 1.85;
const BALL_MIN_THUMB_GAP = 0.035;
// El centro de la mano (puntas + base del medio) queda unos cm por encima del
// pomo cuando la palma se apoya sobre él.
const KNOB_GRAB_DISTANCE = 0.065;
const KNOB_RELEASE_DISTANCE = 0.11;
const HANDS = ['left', 'right'];
const JOINTS = [
  'wrist',
  'thumb-tip',
  'index-finger-phalanx-proximal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-tip',
  'ring-finger-phalanx-proximal',
  'ring-finger-tip',
];

function createHandState() {
  const joints = {};
  for (const name of JOINTS) {
    joints[name] = new Vector3();
  }
  return {
    present: false,
    tracked: false,
    joints,
    grip: new Vector3(),
    grasp: new Vector3(),
    curl: { index: 2, middle: 2, ring: 2 },
    thumbGap: 0,
    squeeze: 0,
    trigger: 0,
  };
}

export class CockpitSystem extends createSystem({
  roots: { required: [RaceState] },
}) {
  init() {
    this.race = this.world.getSystem(RaceSystem);
    this.vec = new Vector3();
    this.local = new Vector3();
    this.hands = { left: createHandState(), right: createHandState() };
    this.handLocal = { left: new Vector3(), right: new Vector3() };
    this.wheelHeld = { left: false, right: false };
    this.contactKey = '';
    this.baseAngle = 0;
    this.startWheelAngle = 0;
    this.wheelAngle = 0;
    this.knobHeldBy = null;
    this.knobOffset = 0;
    this.shiftLatched = false;
    this.keys = { left: false, right: false, up: false, down: false };

    const root = this.race.root;
    const wheelObject = createSteeringWheel();
    wheelObject.position.fromArray(WHEEL_POSITION);
    this.wheel = this.world.createTransformEntity(wheelObject, { parent: root });
    this.pivot = wheelObject.getObjectByName('wheel-pivot');
    this.spinner = wheelObject.getObjectByName('wheel-spinner');
    this.brakeButton = wheelObject.getObjectByName('brake-button');
    this.throttleButton = wheelObject.getObjectByName('throttle-button');
    this.buttonZ = this.brakeButton.position.z;

    const leverObject = createGearLever();
    leverObject.position.fromArray(LEVER_POSITION);
    this.lever = this.world.createTransformEntity(leverObject, { parent: root });
    this.leverObject = leverObject;
    this.stick = leverObject.getObjectByName('lever-stick');
    this.knobY = this.stick.position.y + LEVER.height;
    const knobObject = createGearKnob();
    knobObject.position.set(0, this.knobY, 0);
    // El pomo no usa el sistema de agarre de IWSDK (que acepta pinza):
    // aquí sólo se acepta agarre de bola.
    this.knob = this.world.createTransformEntity(knobObject, { parent: this.lever });

    const onKey = (event, down) => {
      switch (event.code) {
        case 'ArrowLeft':
        case 'KeyA':
          this.keys.left = down;
          break;
        case 'ArrowRight':
        case 'KeyD':
          this.keys.right = down;
          break;
        case 'ArrowUp':
        case 'KeyW':
          this.keys.up = down;
          break;
        case 'ArrowDown':
        case 'KeyS':
          this.keys.down = down;
          break;
        case 'KeyE':
          if (down && !event.repeat) this.race.shift(1);
          break;
        case 'KeyQ':
          if (down && !event.repeat) this.race.shift(-1);
          break;
        default:
      }
    };
    const keyDown = (event) => onKey(event, true);
    const keyUp = (event) => onKey(event, false);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    this.cleanupFuncs.push(
      () => window.removeEventListener('keydown', keyDown),
      () => window.removeEventListener('keyup', keyUp),
    );
  }

  // ------------------------------------------------------------ hand data

  /** Lee agarre, articulaciones y botones de cada mano o control. */
  readHands() {
    const xr = this.input.xr;
    const frame = this.renderer.xr.getFrame?.();
    const refSpace = this.renderer.xr.getReferenceSpace?.();
    for (const handedness of HANDS) {
      const hand = this.hands[handedness];
      const source = xr?.getPrimaryInputSource?.(handedness);
      const grip = this.player.gripSpaces?.[handedness];
      hand.present = source != null && grip != null;
      hand.tracked = false;
      if (!hand.present) {
        continue;
      }
      grip.getWorldPosition(hand.grip);
      hand.grasp.copy(hand.grip);
      const pad = xr.gamepads?.[handedness];
      hand.squeeze = pad?.getButtonValue?.('xr-standard-squeeze') ?? 0;
      hand.trigger = pad?.getButtonValue?.('xr-standard-trigger') ?? 0;

      if (source.hand == null || frame?.getJointPose == null || refSpace == null) {
        continue;
      }
      let ok = true;
      for (const name of JOINTS) {
        const joint = source.hand.get(name);
        const pose = joint ? frame.getJointPose(joint, refSpace) : null;
        if (pose == null) {
          ok = false;
          break;
        }
        const p = pose.transform.position;
        this.player.localToWorld(hand.joints[name].set(p.x, p.y, p.z));
      }
      if (!ok) {
        continue;
      }
      const j = hand.joints;
      const wrist = j.wrist;
      const curl = (tip, base) => j[tip].distanceTo(wrist) / Math.max(1e-4, j[base].distanceTo(wrist));
      hand.curl.index = curl('index-finger-tip', 'index-finger-phalanx-proximal');
      hand.curl.middle = curl('middle-finger-tip', 'middle-finger-phalanx-proximal');
      hand.curl.ring = curl('ring-finger-tip', 'ring-finger-phalanx-proximal');
      hand.thumbGap = j['thumb-tip'].distanceTo(j['index-finger-tip']);
      // Centro de la mano que rodea el pomo: puntas + base del dedo medio.
      hand.grasp
        .copy(j['thumb-tip'])
        .add(j['index-finger-tip'])
        .add(j['middle-finger-tip'])
        .add(j['ring-finger-tip'])
        .add(j['middle-finger-metacarpal'])
        .multiplyScalar(0.2);
      hand.tracked = true;
    }
  }

  /** Prensión digitopalmar: índice, medio y anular cerrados (pulgar libre). */
  isPalmarGrip(hand) {
    if (!hand.present) return false;
    if (!hand.tracked) return hand.squeeze > 0.5;
    const { index, middle, ring } = hand.curl;
    return index < PALMAR_MAX_CURL && middle < PALMAR_MAX_CURL && ring < PALMAR_MAX_CURL;
  }

  /** Agarre de bola: dedos semiflexionados y pulgar separado (no pinza). */
  isBallGrip(hand, loose) {
    if (!hand.present) return false;
    if (!hand.tracked) return hand.squeeze > 0.5;
    const margin = loose ? 0.1 : 0;
    const avg = (hand.curl.index + hand.curl.middle + hand.curl.ring) / 3;
    return (
      avg > BALL_MIN_CURL - margin &&
      avg < BALL_MAX_CURL + margin &&
      hand.thumbGap > BALL_MIN_THUMB_GAP - margin * 0.1
    );
  }

  /** ¿El pulgar de alguna mano está apoyado sobre este botón? */
  buttonTouched(button) {
    for (const handedness of HANDS) {
      const hand = this.hands[handedness];
      if (!hand.tracked) {
        continue;
      }
      const p = this.spinner.worldToLocal(this.local.copy(hand.joints['thumb-tip']));
      const dx = p.x - button.position.x;
      const dy = p.y - button.position.y;
      if (Math.hypot(dx, dy) < WHEEL.buttonRadius + 0.01 && p.z > -0.012 && p.z < 0.03) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- wheel

  /** Actualiza qué manos sujetan el volante (sólo a las 9 y a las 3). */
  updateWheelHold() {
    for (const handedness of HANDS) {
      const hand = this.hands[handedness];
      if (!this.isPalmarGrip(hand)) {
        this.wheelHeld[handedness] = false;
        continue;
      }
      // Posición en el plano del volante (sin girar) para medir el giro.
      const p = this.pivot.worldToLocal(this.handLocal[handedness].copy(hand.grip));
      const radial = Math.hypot(p.x, p.y);
      if (this.wheelHeld[handedness]) {
        // Mientras sujeta, sólo se suelta al abrir la mano o alejarse del aro.
        this.wheelHeld[handedness] =
          Math.abs(radial - WHEEL.radius) < RIM_RELEASE_TOLERANCE && Math.abs(p.z) < RIM_DEPTH * 1.2;
        continue;
      }
      // Para empezar a sujetar: la mano tiene que estar en su empuñadura,
      // medida sobre el volante (que puede estar girado).
      const s = this.spinner.worldToLocal(this.local.copy(hand.grip));
      const angle = Math.atan2(s.y, s.x);
      const target = handedness === 'left' ? Math.PI : 0;
      const offset = Math.abs(Math.atan2(Math.sin(angle - target), Math.cos(angle - target)));
      this.wheelHeld[handedness] =
        offset < GRIP_ZONE && Math.abs(radial - WHEEL.radius) < RIM_TOLERANCE && Math.abs(p.z) < RIM_DEPTH;
    }
  }

  updateWheel(dt) {
    const left = this.wheelHeld.left;
    const right = this.wheelHeld.right;
    const key = `${left}|${right}`;
    let handAngle = null;
    if (left && right) {
      const l = this.handLocal.left;
      const r = this.handLocal.right;
      handAngle = Math.atan2(r.y - l.y, r.x - l.x);
    } else if (left || right) {
      const p = left ? this.handLocal.left : this.handLocal.right;
      handAngle = Math.atan2(p.y, p.x);
    }

    if (handAngle != null) {
      // Al cambiar qué manos sujetan, se toma una nueva referencia.
      if (key !== this.contactKey) {
        this.contactKey = key;
        this.baseAngle = handAngle;
        this.startWheelAngle = this.wheelAngle;
      }
      let delta = handAngle - this.baseAngle;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      // Girar a la derecha (horario visto por el jugador) es positivo.
      this.wheelAngle = this.startWheelAngle - delta;
    } else {
      this.contactKey = '';
      const keySteer = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
      if (keySteer !== 0) {
        this.wheelAngle += keySteer * 3 * dt;
      } else {
        this.wheelAngle *= Math.exp(-dt * 5);
      }
    }
    this.wheelAngle = Math.max(-MAX_WHEEL_ANGLE, Math.min(MAX_WHEEL_ANGLE, this.wheelAngle));
    this.spinner.rotation.z = -this.wheelAngle;
    // Zona muerta: el temblor natural de las manos (~5°) no desvía el carro.
    const magnitude = Math.abs(this.wheelAngle);
    if (magnitude < DEAD_ZONE) {
      return 0;
    }
    const steer = (magnitude - DEAD_ZONE) / (FULL_STEER_ANGLE - DEAD_ZONE);
    return Math.sign(this.wheelAngle) * Math.min(1, steer);
  }

  updatePedals() {
    // Izquierda acelera, derecha frena (botones y gatillos).
    const throttleTouch = this.buttonTouched(this.throttleButton);
    const brakeTouch = this.buttonTouched(this.brakeButton);
    const throttle = Math.max(throttleTouch ? 1 : 0, this.hands.left.trigger, this.keys.up ? 1 : 0);
    const brake = Math.max(brakeTouch ? 1 : 0, this.hands.right.trigger, this.keys.down ? 1 : 0);
    // El botón se hunde y se ilumina al pulsarlo.
    this.throttleButton.position.z = this.buttonZ - 0.005 * throttle;
    this.brakeButton.position.z = this.buttonZ - 0.005 * brake;
    this.throttleButton.material.emissiveIntensity = 0.25 + throttle * 1.5;
    this.brakeButton.material.emissiveIntensity = 0.25 + brake * 1.5;
    return { brake, throttle };
  }

  // ---------------------------------------------------------------- lever

  updateLever(dt) {
    const knob = this.knob.object3D;
    const travel = LEVER.travel;
    knob.getWorldPosition(this.vec);

    if (this.knobHeldBy == null) {
      for (const handedness of HANDS) {
        const hand = this.hands[handedness];
        const grabPoint = hand.tracked ? hand.grasp : hand.grip;
        if (this.isBallGrip(hand, false) && grabPoint.distanceTo(this.vec) < KNOB_GRAB_DISTANCE) {
          this.knobHeldBy = handedness;
          this.leverObject.worldToLocal(this.local.copy(grabPoint));
          this.knobOffset = this.local.z - knob.position.z;
          break;
        }
      }
    } else {
      const hand = this.hands[this.knobHeldBy];
      const grabPoint = hand.tracked ? hand.grasp : hand.grip;
      if (!this.isBallGrip(hand, true) || grabPoint.distanceTo(this.vec) > KNOB_RELEASE_DISTANCE) {
        this.knobHeldBy = null;
      }
    }

    if (this.knobHeldBy != null) {
      const hand = this.hands[this.knobHeldBy];
      this.leverObject.worldToLocal(this.local.copy(hand.tracked ? hand.grasp : hand.grip));
      knob.position.z = this.local.z - this.knobOffset;
    } else {
      // Muelle de regreso al centro.
      knob.position.z *= Math.exp(-dt * 12);
    }
    knob.position.x = 0;
    knob.position.y = this.knobY;
    knob.position.z = Math.max(-travel, Math.min(travel, knob.position.z));
    this.stick.rotation.x = Math.asin(knob.position.z / LEVER.height);

    const z = knob.position.z;
    if (this.knobHeldBy != null && !this.shiftLatched && z < -travel * 0.7) {
      this.race.shift(1);
      this.shiftLatched = true;
    } else if (this.knobHeldBy != null && !this.shiftLatched && z > travel * 0.7) {
      this.race.shift(-1);
      this.shiftLatched = true;
    } else if (Math.abs(z) < travel * 0.3) {
      this.shiftLatched = false;
    }
  }

  // ---------------------------------------------------------------- frame

  update(delta) {
    const dt = Math.min(delta, 0.05);
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    if (immersive) {
      this.readHands();
    } else {
      for (const handedness of HANDS) {
        this.hands[handedness].present = false;
        this.hands[handedness].tracked = false;
        this.hands[handedness].trigger = 0;
      }
    }
    this.updateWheelHold();
    const steer = this.updateWheel(dt);
    const { brake, throttle } = this.updatePedals();
    this.updateLever(dt);

    const state = this.race.root;
    state.setValue(RaceState, 'steer', steer);
    state.setValue(RaceState, 'throttle', throttle);
    state.setValue(RaceState, 'brake', brake);
  }
}
