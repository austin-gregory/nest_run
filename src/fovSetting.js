// ── Field-of-view setting ────────────────────────────────────────────────────
// Shared by the first-person modes. The pause menu owns the slider; the render
// loop reads `value` each frame, so a change takes effect immediately rather
// than on resume.
//
// Only the base (hip-fire) FOV is stored. Sprint and ADS derive from it, so
// raising the base widens the sprint punch and the scope together instead of
// the three drifting apart.

const KEY = "nestrun.fov";
const MIN = 70;
const MAX = 120;
const DEFAULT = 94;

// Ratios taken from the original hardcoded 94 / 100 / 30.
const SPRINT_ADD = 6;
const ADS_RATIO = 30 / 94;

function clamp(v) {
  return Math.max(MIN, Math.min(MAX, v));
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : DEFAULT;
  } catch {
    return DEFAULT;   // private window, blocked storage — just use the default
  }
}

function save(v) {
  try { localStorage.setItem(KEY, String(v)); } catch { /* not worth failing over */ }
}

/**
 * Build the FOV row and append it to `container` (the pause overlay).
 * Returns a handle whose `.value` is the live base FOV.
 */
export function createFovSetting(container) {
  const state = { value: load() };

  const row = document.createElement("div");
  row.id = "fov-setting";
  row.style.cssText = [
    "display:flex", "align-items:center", "gap:12px",
    "font-family:monospace", "color:#00b4ff", "font-size:15px",
    "letter-spacing:2px", "padding:10px 18px",
    "background:rgba(255,255,255,.04)",
    "border:1px solid rgba(0,180,255,.25)", "border-radius:6px",
  ].join(";");

  const label = document.createElement("span");
  label.textContent = "FOV";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(MIN);
  slider.max = String(MAX);
  slider.step = "1";
  slider.value = String(state.value);
  slider.style.cssText = "width:200px;accent-color:#00b4ff;cursor:pointer";

  const readout = document.createElement("span");
  readout.style.cssText = "min-width:34px;text-align:right;color:#fff";
  readout.textContent = String(state.value);

  const reset = document.createElement("button");
  reset.textContent = "RESET";
  reset.style.cssText = [
    "padding:4px 10px", "font-family:monospace", "font-size:11px",
    "letter-spacing:1px", "background:rgba(255,255,255,.06)", "color:#9cc",
    "border:1px solid rgba(0,180,255,.25)", "border-radius:4px", "cursor:pointer",
  ].join(";");

  function apply(v, fromSlider) {
    state.value = clamp(Math.round(v));
    readout.textContent = String(state.value);
    if (!fromSlider) slider.value = String(state.value);
    save(state.value);
  }

  slider.addEventListener("input", () => apply(Number(slider.value), true));
  reset.addEventListener("click", () => apply(DEFAULT, false));
  // The overlay sits under a pointer-lock game; stop the slider's clicks and
  // keys from reaching the game's handlers.
  for (const ev of ["keydown", "keyup", "mousedown", "click"]) {
    row.addEventListener(ev, (e) => e.stopPropagation());
  }

  row.append(label, slider, readout, reset);
  container.appendChild(row);

  return {
    row,
    get value() { return state.value; },
    /** FOV for the current movement state. */
    forState({ aiming, sprinting }) {
      if (aiming) return state.value * ADS_RATIO;
      if (sprinting) return state.value + SPRINT_ADD;
      return state.value;
    },
  };
}

export const FOV_DEFAULT = DEFAULT;
