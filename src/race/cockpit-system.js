/**
 * Cabina: volante, botones de frenar/acelerar y palanca de cambios.
 *
 *  - Volante: apoya las manos en el aro (sin pellizcar) y gira siguiendo su
 *    posición. Con las dos manos usa el ángulo entre ellas; con una, cómo
 *    gira alrededor del centro. Sin manos vuelve solo al centro.
 *  - Botones: rojo (izquierda) frena y azul (derecha) acelera mientras la
 *    punta de un dedo (pulgar o índice) los toca. Con controles: gatillo
 *    izquierdo frena y derecho acelera.
 *  - Palanca secuencial: agarra el pomo, empújalo hacia adelante para subir
 *    de marcha o tira hacia atrás para bajar. Vuelve sola al centro.
 *  - Teclado (escritorio): flechas o A/D giran, W/flecha arriba acelera,
 *    S/flecha abajo frena, E sube y Q baja de marcha.
 *
 * Escribe steer, throttle y brake en RaceState; los cambios llaman a
 * RaceSystem.shift().
 */
import { createSystem, Grabbed, OneHandGrabbable, Vector3, VisibilityState } from '@iwsdk/core';
import { RaceState } from '../race-components.js';
import { createGearKnob, createGearLever, createSteeringWheel, LEVER, PLAY_AREA, WHEEL } from '../scene-assets/race.scene-asset.js';
import { RaceSystem } from './race-system.js';

/** Posición de la cabina en coordenadas de la pista (delante del borde cercano). */
const WHEEL_POSITION = [0, 0, PLAY_AREA.length / 2 + 0.07];
const LEVER_POSITION = [0.22, 0, PLAY_AREA.length / 2 + 0.11];
const MAX_WHEEL_ANGLE = 1.75;
const FULL_STEER_ANGLE = 1.4;
const DEAD_ZONE = 0.09;
// El punto de agarre de la mano está en la palma, unos 5 cm fuera del aro.
const RIM_TOLERANCE = 0.075;
const RIM_DEPTH = 0.1;
const TIP_JOINTS = ['thumb-tip', 'index-finger-tip'];
const HANDS = ['left', 'right'];

export class CockpitSystem extends createSystem({
  roots: { required: [RaceState] },
}) {
  init() {
    this.race = this.world.getSystem(RaceSystem);
    this.vec = new Vector3();
    this.local = new Vector3();
    this.handLocal = { left: new Vector3(), right: new Vector3() };
    this.onRim = { left: false, right: false };
    this.contactKey = '';
    this.baseAngle = 0;
    this.startWheelAngle = 0;
    this.wheelAngle = 0;
    this.tips = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    this.tipCount = 0;
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
    this.stick = leverObject.getObjectByName('lever-stick');
    this.knobY = this.stick.position.y + LEVER.height;
    const knobObject = createGearKnob();
    knobObject.position.set(0, this.knobY, 0);
    this.knob = this.world.createTransformEntity(knobObject, { parent: this.lever });
    // Sólo se desliza adelante/atrás por la guía.
    this.knob.addComponent(OneHandGrabbable, {
      rotate: false,
      translate: true,
      translateMin: [0, this.knobY, -LEVER.travel],
      translateMax: [0, this.knobY, LEVER.travel],
    });

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

  /** Posición del agarre de cada mano/control en el plano del volante. */
  readGrips() {
    const xr = this.input.xr;
    for (const hand of HANDS) {
      this.onRim[hand] = false;
      const source = xr?.getPrimaryInputSource?.(hand);
      const grip = this.player.gripSpaces?.[hand];
      if (source == null || grip == null) {
        continue;
      }
      grip.getWorldPosition(this.vec);
      const p = this.pivot.worldToLocal(this.handLocal[hand].copy(this.vec));
      const radial = Math.hypot(p.x, p.y);
      this.onRim[hand] = Math.abs(radial - WHEEL.radius) < RIM_TOLERANCE && Math.abs(p.z) < RIM_DEPTH;
    }
  }

  /** Puntas de pulgar e índice de las manos (seguimiento de manos). */
  readFingertips() {
    this.tipCount = 0;
    const frame = this.renderer.xr.getFrame?.();
    const refSpace = this.renderer.xr.getReferenceSpace?.();
    if (frame == null || refSpace == null || frame.getJointPose == null) {
      return;
    }
    for (const hand of HANDS) {
      const source = this.input.xr?.getPrimaryInputSource?.(hand);
      if (source?.hand == null) {
        continue;
      }
      for (const jointName of TIP_JOINTS) {
        const joint = source.hand.get(jointName);
        const pose = joint ? frame.getJointPose(joint, refSpace) : null;
        if (pose == null) {
          continue;
        }
        const p = pose.transform.position;
        const tip = this.tips[this.tipCount];
        tip.set(p.x, p.y, p.z);
        this.player.localToWorld(tip);
        this.tipCount += 1;
      }
    }
  }

  /**
   * ¿Alguna punta de dedo está apoyada sobre este botón? Se mide en el plano
   * del volante: dentro del círculo del botón (con 1 cm de margen) y a menos
   * de ~1,5 cm por encima de su cara. Al levantar el pulgar se suelta.
   */
  buttonTouched(button) {
    for (let i = 0; i < this.tipCount; i += 1) {
      const p = this.spinner.worldToLocal(this.local.copy(this.tips[i]));
      const dx = p.x - button.position.x;
      const dy = p.y - button.position.y;
      if (Math.hypot(dx, dy) < WHEEL.buttonRadius + 0.01 && p.z > -0.012 && p.z < 0.03) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- frame

  updateWheel(dt) {
    const left = this.onRim.left;
    const right = this.onRim.right;
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
      // Al cambiar qué manos tocan el aro, se toma una nueva referencia.
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
    const pads = this.input.xr?.gamepads;
    const leftTrigger = pads?.left?.getButtonValue?.('xr-standard-trigger') ?? 0;
    const rightTrigger = pads?.right?.getButtonValue?.('xr-standard-trigger') ?? 0;
    const brakeTouch = this.buttonTouched(this.brakeButton);
    const throttleTouch = this.buttonTouched(this.throttleButton);
    const brake = Math.max(brakeTouch ? 1 : 0, leftTrigger, this.keys.down ? 1 : 0);
    const throttle = Math.max(throttleTouch ? 1 : 0, rightTrigger, this.keys.up ? 1 : 0);
    // El botón se hunde y se ilumina al pulsarlo.
    this.brakeButton.position.z = this.buttonZ - 0.005 * brake;
    this.throttleButton.position.z = this.buttonZ - 0.005 * throttle;
    this.brakeButton.material.emissiveIntensity = 0.25 + brake * 1.5;
    this.throttleButton.material.emissiveIntensity = 0.25 + throttle * 1.5;
    return { brake, throttle };
  }

  updateLever(dt) {
    const knob = this.knob.object3D;
    const travel = LEVER.travel;
    if (this.knob.hasComponent(Grabbed)) {
      const z = knob.position.z;
      if (!this.shiftLatched && z < -travel * 0.7) {
        this.race.shift(1);
        this.shiftLatched = true;
      } else if (!this.shiftLatched && z > travel * 0.7) {
        this.race.shift(-1);
        this.shiftLatched = true;
      } else if (Math.abs(z) < travel * 0.3) {
        this.shiftLatched = false;
      }
    } else {
      // Muelle de regreso al centro.
      knob.position.z *= Math.exp(-dt * 12);
      this.shiftLatched = false;
    }
    knob.position.x = 0;
    knob.position.y = this.knobY;
    knob.position.z = Math.max(-travel, Math.min(travel, knob.position.z));
    this.stick.rotation.x = Math.asin(knob.position.z / LEVER.height);
  }

  update(delta) {
    const dt = Math.min(delta, 0.05);
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    if (immersive) {
      this.readGrips();
      this.readFingertips();
    } else {
      this.onRim.left = false;
      this.onRim.right = false;
      this.tipCount = 0;
    }
    const steer = this.updateWheel(dt);
    const { brake, throttle } = this.updatePedals();
    this.updateLever(dt);

    const state = this.race.root;
    state.setValue(RaceState, 'steer', steer);
    state.setValue(RaceState, 'throttle', throttle);
    state.setValue(RaceState, 'brake', brake);
  }
}
