// ── Mobile touch controls: virtual joystick + action buttons ────────────────
// Returns a touch state object that input.js merges into the unified input.

export const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && !matchMedia("(pointer:fine)").matches);

export function createTouchControls({ onLookDelta, onReload, onSwapWeapon, onMenu }) {
  const LOOK_SENSITIVITY = 0.004;

  const state = {
    active: false,
    moveX: 0,   // -1..1
    moveY: 0,   // -1..1
    fire: false,
    aim: false,
    jump: false,
    sprint: false,
  };

  if (!isMobile) return { state, destroy() {} };

  state.active = true;

  // ── Build overlay DOM ──────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.id = "touch-overlay";
  overlay.innerHTML = `
    <div id="touch-stick-zone">
      <div id="touch-stick-base"><div id="touch-stick-knob"></div></div>
    </div>
    <div id="touch-look-zone"></div>
    <button id="touch-fire" class="touch-btn touch-fire">FIRE</button>
    <button id="touch-aim" class="touch-btn touch-aim">ADS</button>
    <button id="touch-jump" class="touch-btn touch-jump">JUMP</button>
    <button id="touch-swap" class="touch-btn touch-swap">Q</button>
    <button id="touch-sprint" class="touch-btn touch-sprint">RUN</button>
    <button id="touch-menu" class="touch-btn touch-menu">&#9776;</button>
  `;
  document.body.appendChild(overlay);

  // Update hint text for mobile
  const ctrlHint = document.getElementById("ctrl-hint");
  if (ctrlHint) ctrlHint.textContent = "Touch to play • Left stick move • Right drag aim";

  const stickZone = document.getElementById("touch-stick-zone");
  const stickBase = document.getElementById("touch-stick-base");
  const stickKnob = document.getElementById("touch-stick-knob");
  const lookZone  = document.getElementById("touch-look-zone");
  const fireBtn   = document.getElementById("touch-fire");
  const aimBtn    = document.getElementById("touch-aim");
  const jumpBtn   = document.getElementById("touch-jump");
  const swapBtn   = document.getElementById("touch-swap");
  const sprintBtn = document.getElementById("touch-sprint");
  const menuBtn   = document.getElementById("touch-menu");

  // ── Joystick (left side) ───────────────────────────────────────────────────
  const STICK_RADIUS = 50;
  let stickTouchId = null;
  let stickCenterX = 0, stickCenterY = 0;

  stickZone.addEventListener("touchstart", (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (stickTouchId !== null) continue;
      stickTouchId = t.identifier;
      const rect = stickZone.getBoundingClientRect();
      stickCenterX = t.clientX;
      stickCenterY = t.clientY;
      stickBase.style.display = "block";
      stickBase.style.left = (stickCenterX - rect.left - 50) + "px";
      stickBase.style.top  = (stickCenterY - rect.top - 50) + "px";
      stickKnob.style.transform = "translate(0px, 0px)";
    }
  }, { passive: false });

  stickZone.addEventListener("touchmove", (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== stickTouchId) continue;
      let dx = t.clientX - stickCenterX;
      let dy = t.clientY - stickCenterY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > STICK_RADIUS) { dx *= STICK_RADIUS / dist; dy *= STICK_RADIUS / dist; }
      stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      state.moveX = dx / STICK_RADIUS;
      state.moveY = dy / STICK_RADIUS;
    }
  }, { passive: false });

  function endStick(e) {
    for (const t of e.changedTouches) {
      if (t.identifier !== stickTouchId) continue;
      stickTouchId = null;
      state.moveX = 0;
      state.moveY = 0;
      stickBase.style.display = "none";
    }
  }
  stickZone.addEventListener("touchend", endStick);
  stickZone.addEventListener("touchcancel", endStick);

  // ── Look area (right side background) ──────────────────────────────────────
  let lookTouchId = null;
  let lookLastX = 0, lookLastY = 0;

  lookZone.addEventListener("touchstart", (e) => {
    for (const t of e.changedTouches) {
      if (lookTouchId !== null) continue;
      lookTouchId = t.identifier;
      lookLastX = t.clientX;
      lookLastY = t.clientY;
    }
  }, { passive: true });

  lookZone.addEventListener("touchmove", (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== lookTouchId) continue;
      const dx = t.clientX - lookLastX;
      const dy = t.clientY - lookLastY;
      lookLastX = t.clientX;
      lookLastY = t.clientY;
      onLookDelta?.(-dx * LOOK_SENSITIVITY, -dy * LOOK_SENSITIVITY);
    }
  }, { passive: false });

  function endLook(e) {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookTouchId) continue;
      lookTouchId = null;
    }
  }
  lookZone.addEventListener("touchend", endLook);
  lookZone.addEventListener("touchcancel", endLook);

  // ── Action buttons ─────────────────────────────────────────────────────────
  function btnHold(el, onDown, onUp) {
    el.addEventListener("touchstart", (e) => { e.preventDefault(); onDown(); }, { passive: false });
    el.addEventListener("touchend",   (e) => { e.preventDefault(); onUp();   }, { passive: false });
    el.addEventListener("touchcancel",(e) => { e.preventDefault(); onUp();   }, { passive: false });
  }

  btnHold(fireBtn,   () => { state.fire = true;  }, () => { state.fire = false;  });
  btnHold(jumpBtn,   () => { state.jump = true;  }, () => { state.jump = false;  });

  // Toggle buttons for ADS and Sprint
  function btnToggle(el, key) {
    el.addEventListener("touchstart", (e) => {
      e.preventDefault();
      state[key] = !state[key];
      el.style.opacity = state[key] ? "0.85" : "";
    }, { passive: false });
  }
  btnToggle(aimBtn, "aim");
  btnToggle(sprintBtn, "sprint");

  swapBtn.addEventListener("touchstart",   (e) => { e.preventDefault(); onSwapWeapon?.(); }, { passive: false });
  menuBtn.addEventListener("touchstart",   (e) => { e.preventDefault(); onMenu?.(); }, { passive: false });

  // ── Fullscreen on first touch ──────────────────────────────────────────────
  function requestFullscreen() {
    const el = document.documentElement;
    const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (rfs) {
      rfs.call(el).catch(() => {});
      // Lock to landscape if possible
      try { screen.orientation.lock("landscape").catch(() => {}); } catch (_) {}
    }
    document.removeEventListener("touchstart", requestFullscreen);
  }
  document.addEventListener("touchstart", requestFullscreen, { once: true });

  function setVisible(visible) {
    overlay.style.display = visible ? "" : "none";
  }

  function destroy() {
    overlay.remove();
    document.removeEventListener("touchstart", requestFullscreen);
  }

  return { state, setVisible, destroy };
}
