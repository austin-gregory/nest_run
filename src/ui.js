export function createUI() {
  const $ = (id) => document.getElementById(id);
  const refs = {
    hp: $("hp"),
    hpb: $("hpb"),
    en: $("en"),
    kl: $("kl"),
    de: $("de"),
    tm: $("tm"),
    pr: $("pr"),
    prb: $("prb"),
    pric: $("pric"),
    st: $("st"),
    m: $("m"),
    bn: $("bn"),
    x: $("x"),
    optic: $("optic"),
  };

  function msg(text) {
    refs.m.textContent = text || "";
  }

  function banner(text, seconds = 1.6) {
    refs.bn.textContent = text;
    refs.bn.style.opacity = "1";
    clearTimeout(banner._timer);
    banner._timer = setTimeout(() => {
      refs.bn.style.opacity = "0";
    }, seconds * 1000);
  }

  function setStatus(text) {
    refs.st.textContent = text;
  }

  function setCrosshairAim(isAim) {
    refs.x.style.opacity = isAim ? "0.08" : "0.9";
    if (refs.optic) refs.optic.style.opacity = isAim ? "1" : "0";
  }

  function hud({ hp, maxHp, enemies, kills, deaths, progress, elapsed }) {
    const pct = Math.max(0, hp) / maxHp;
    refs.hp.textContent = Math.max(0, Math.floor(hp));
    refs.hpb.style.width = (pct * 100).toFixed(1) + "%";
    refs.hpb.className = "bf " + (pct > 0.6 ? "hp-hi" : pct > 0.3 ? "hp-mid" : "hp-low");

    refs.en.textContent = enemies;
    refs.kl.textContent = kills;
    refs.de.textContent = deaths;
    if (refs.tm && elapsed !== undefined) {
      const s = Math.floor(elapsed);
      refs.tm.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }

    const prPct = (progress * 100).toFixed(1);
    refs.pr.textContent = Math.floor(progress * 100) + "%";
    refs.prb.style.width = prPct + "%";
    refs.pric.style.left = prPct + "%";
  }

  return { refs, msg, banner, setStatus, setCrosshairAim, hud };
}
