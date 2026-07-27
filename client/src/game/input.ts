/** Input: keyboard (arrows/WASD + ability keys) and touch (drag pad + buttons)
 * both feed the same analog state. Throttle and steer are -1..1. */

export interface InputState {
  throttle: number; // -1 (brake/reverse) .. 1 (full gas)
  steer: number; // -1 (left) .. 1 (right)
}

export type GameAction = 'useItem' | 'fire' | 'place' | 'turret' | 'boom' | 'hypno';

const KEY_ACTIONS: Record<string, GameAction> = {
  Space: 'useItem',
  KeyF: 'fire',
  KeyB: 'place',
  KeyT: 'turret',
  KeyX: 'boom',
  KeyH: 'hypno',
};

export function createInput(): {
  state: InputState;
  queue: (a: GameAction) => void;
  consume: (a: GameAction) => boolean;
  setTouchAxes: (throttle: number, steer: number) => void;
  clearTouchAxes: () => void;
  dispose: () => void;
} {
  const state: InputState = { throttle: 0, steer: 0 };
  const kb = { up: false, down: false, left: false, right: false };
  const touch = { throttle: 0, steer: 0, active: false };
  const pending = new Set<GameAction>();

  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const sync = () => {
    const kbThrottle = (kb.up ? 1 : 0) - (kb.down ? 1 : 0);
    const kbSteer = (kb.right ? 1 : 0) - (kb.left ? 1 : 0);
    state.throttle = clamp(kbThrottle + (touch.active ? touch.throttle : 0));
    state.steer = clamp(kbSteer + (touch.active ? touch.steer : 0));
  };

  const setKey = (code: string, down: boolean): boolean => {
    switch (code) {
      case 'ArrowUp': case 'KeyW': kb.up = down; sync(); return true;
      case 'ArrowDown': case 'KeyS': kb.down = down; sync(); return true;
      case 'ArrowLeft': case 'KeyA': kb.left = down; sync(); return true;
      case 'ArrowRight': case 'KeyD': kb.right = down; sync(); return true;
      default:
        if (code in KEY_ACTIONS) {
          if (down) pending.add(KEY_ACTIONS[code]);
          return true;
        }
        return false;
    }
  };

  const onDown = (e: KeyboardEvent) => {
    if (setKey(e.code, true)) e.preventDefault();
  };
  const onUp = (e: KeyboardEvent) => {
    if (!(e.code in KEY_ACTIONS) && setKey(e.code, false)) e.preventDefault();
  };
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);

  return {
    state,
    queue: (a) => pending.add(a),
    consume: (a) => pending.delete(a),
    setTouchAxes: (throttle, steer) => {
      touch.active = true;
      touch.throttle = clamp(throttle);
      touch.steer = clamp(steer);
      sync();
    },
    clearTouchAxes: () => {
      touch.active = false;
      touch.throttle = 0;
      touch.steer = 0;
      sync();
    },
    dispose: () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    },
  };
}
