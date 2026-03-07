export function attachInput({ element, onReload, onSwapWeapon, onLookDelta, onLockChange, lookSensitivity = 0.0022 }) {
  const keys = new Set();
  const pointer = { locked: false, aim: false, fire: false };

  element.addEventListener("click", () => {
    element.requestPointerLock();
  });

  document.addEventListener("pointerlockchange", () => {
    pointer.locked = document.pointerLockElement === element;
    onLockChange?.(pointer.locked);
  });

  addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.code === "KeyR") onReload?.();
    if (e.code === "KeyQ") onSwapWeapon?.();
  });

  addEventListener("keyup", (e) => {
    keys.delete(e.code);
  });

  addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  addEventListener("mousedown", (e) => {
    if (!pointer.locked) return;
    if (e.button === 0) pointer.fire = true;
    if (e.button === 2) pointer.aim = true;
  });

  addEventListener("mouseup", (e) => {
    if (e.button === 0) pointer.fire = false;
    if (e.button === 2) pointer.aim = false;
  });

  document.addEventListener("mousemove", (e) => {
    if (!pointer.locked) return;
    onLookDelta?.(-e.movementX * lookSensitivity, -e.movementY * lookSensitivity);
  });

  // ── Gamepad (Xbox controller) support ──────────────────────────────────
  const STICK_DEADZONE = 0.15;
  const TRIGGER_DEADZONE = 0.1;
  const LOOK_SENSITIVITY = 2.8; // radians/sec at full stick deflection

  const gamepad = {
    connected: false,
    // Left stick (movement)
    moveX: 0,  // -1 left, +1 right
    moveY: 0,  // -1 forward, +1 backward
    // Right stick (look)
    lookX: 0,
    lookY: 0,
    // Buttons
    fire: false,       // RT (right trigger)
    aim: false,        // LT (left trigger)
    jump: false,       // A
    sprint: false,     // Left stick press (L3)
    reload: false,     // X
    _prevReload: false,
    _prevJump: false,
    _prevSwap: false,
  };

  function applyDeadzone(value, deadzone) {
    if (Math.abs(value) < deadzone) return 0;
    // Remap so output starts at 0 after deadzone
    const sign = Math.sign(value);
    return sign * (Math.abs(value) - deadzone) / (1 - deadzone);
  }

  function pollGamepad(dt) {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const pad of gamepads) {
      if (pad && pad.connected) { gp = pad; break; }
    }

    if (!gp) {
      gamepad.connected = false;
      gamepad.moveX = gamepad.moveY = gamepad.lookX = gamepad.lookY = 0;
      gamepad.fire = gamepad.aim = gamepad.jump = gamepad.sprint = gamepad.reload = false;
      return;
    }

    gamepad.connected = true;

    // Standard gamepad mapping (Xbox):
    // Axes: 0=LStickX, 1=LStickY, 2=RStickX, 3=RStickY
    // Buttons: 0=A, 1=B, 2=X, 3=Y, 4=LB, 5=RB, 6=LT, 7=RT,
    //          10=L3(stick press), 11=R3(stick press)

    // Left stick → movement
    gamepad.moveX = applyDeadzone(gp.axes[0] || 0, STICK_DEADZONE);
    gamepad.moveY = applyDeadzone(gp.axes[1] || 0, STICK_DEADZONE);

    // Right stick → look
    const rawLookX = applyDeadzone(gp.axes[2] || 0, STICK_DEADZONE);
    const rawLookY = applyDeadzone(gp.axes[3] || 0, STICK_DEADZONE);
    gamepad.lookX = rawLookX;
    gamepad.lookY = rawLookY;

    // Apply right stick look as delta (like mouse movement)
    if (rawLookX !== 0 || rawLookY !== 0) {
      // Non-linear response curve for finer control at low deflections
      const lx = Math.sign(rawLookX) * rawLookX * rawLookX;
      const ly = Math.sign(rawLookY) * rawLookY * rawLookY;
      onLookDelta?.(-lx * LOOK_SENSITIVITY * dt, -ly * LOOK_SENSITIVITY * dt);
    }

    // Triggers — some browsers report as buttons, some as axes
    // RT = fire (button 7), LT = aim (button 6)
    const rt = gp.buttons[7];
    const lt = gp.buttons[6];
    gamepad.fire = rt ? (rt.value > TRIGGER_DEADZONE || rt.pressed) : false;
    gamepad.aim = lt ? (lt.value > TRIGGER_DEADZONE || lt.pressed) : false;

    // A = jump (button 0) — edge-triggered
    const aPressed = gp.buttons[0] ? gp.buttons[0].pressed : false;
    gamepad.jump = aPressed && !gamepad._prevJump;
    gamepad._prevJump = aPressed;

    // Left stick press (L3) = sprint (button 10) — toggle-style hold
    gamepad.sprint = gp.buttons[10] ? gp.buttons[10].pressed : false;

    // X = reload (button 2) — edge-triggered
    const xPressed = gp.buttons[2] ? gp.buttons[2].pressed : false;
    if (xPressed && !gamepad._prevReload) onReload?.();
    gamepad._prevReload = xPressed;

    // Y = swap weapon (button 3) — edge-triggered
    const yPressed = gp.buttons[3] ? gp.buttons[3].pressed : false;
    gamepad.swap = yPressed && !gamepad._prevSwap;
    if (gamepad.swap) onSwapWeapon?.();
    gamepad._prevSwap = yPressed;
  }

  return { keys, pointer, gamepad, pollGamepad };
}
