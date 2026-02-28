export function attachInput({ element, onReload, onLookDelta, onLockChange, lookSensitivity = 0.0022 }) {
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

  return { keys, pointer };
}
