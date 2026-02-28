import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

function applyTexture(root, texture) {
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      m.map = texture;
      m.needsUpdate = true;
    }
  });
}

export async function createWeaponView(scene, config) {
  const gun = new THREE.Group();
  scene.add(gun);

  const recoilNodes = [];
  let muzzleMode = "local";
  const muzzleLocal = new THREE.Vector3(0.28, -0.22, -1.4);
  let muzzleNode = null;
  let ejectMode = "local";
  const ejectLocal = new THREE.Vector3(0.34, -0.17, -0.72);
  let ejectNode = null;
  let slideNode = null;
  let slideBack = 0;
  const slideTravel = config.gunSlideTravel ?? 0.06;

  if (config.gunModelUrl) {
    try {
      const { GLTFLoader } = await import(
        "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js/+esm"
      );
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(config.gunModelUrl);
      const model = gltf.scene;
      model.scale.setScalar(config.gunScale ?? 1);
      if (config.gunRotation) {
        model.rotation.set(
          config.gunRotation.x ?? 0,
          config.gunRotation.y ?? 0,
          config.gunRotation.z ?? 0
        );
      }
      gun.add(model);

      if (config.gunTextureUrl) {
        const tex = await new THREE.TextureLoader().loadAsync(config.gunTextureUrl);
        tex.colorSpace = THREE.SRGBColorSpace;
        applyTexture(model, tex);
      }

      if (config.gunMuzzleNodeName) {
        muzzleNode = model.getObjectByName(config.gunMuzzleNodeName) || null;
        if (muzzleNode) muzzleMode = "node";
      }

      if (config.gunEjectNodeName) {
        ejectNode = model.getObjectByName(config.gunEjectNodeName) || null;
        if (ejectNode) ejectMode = "node";
      }

      if (config.gunSlideNodeName) {
        slideNode = model.getObjectByName(config.gunSlideNodeName) || null;
      }
    } catch (err) {
      console.warn("Gun model load failed; using fallback gun:", err);
    }
  }

  if (gun.children.length === 0) {
    const g1 = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.24, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x27343d, roughness: 0.5, metalness: 0.3 })
    );
    g1.position.set(0.28, -0.25, -0.65);
    const g2 = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.042, 1.75, 16),
      new THREE.MeshStandardMaterial({ color: 0x3b4a54, roughness: 0.66, metalness: 0.25 })
    );
    g2.rotation.x = Math.PI / 2;
    g2.position.set(0.28, -0.22, -1.32);
    const g3 = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.18, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x3b4a54, roughness: 0.66, metalness: 0.25 })
    );
    g3.position.set(0.28, -0.15, -0.78);
    gun.add(g1, g2, g3);
    recoilNodes.push(g1, g2, g3);
    slideNode = g1;
  } else {
    let bestY = -Infinity;
    gun.traverse((obj) => {
      if (!obj.isMesh) return;
      if (!slideNode && obj.position.y > bestY) {
        bestY = obj.position.y;
        slideNode = obj;
      }
    });
  }

  const recoilBaseZ = new Map();
  for (const n of recoilNodes) recoilBaseZ.set(n, n.position.z);
  const slideBaseZ = slideNode ? slideNode.position.z : 0;

  function kick() {
    slideBack = Math.max(slideBack, slideTravel);
    for (const n of recoilNodes) n.position.z += 0.03;
  }

  function settle(dt) {
    slideBack = THREE.MathUtils.lerp(slideBack, 0, 30 * dt);
    if (slideNode) slideNode.position.z = slideBaseZ + slideBack;
    for (const n of recoilNodes) {
      const baseZ = recoilBaseZ.get(n) ?? n.position.z;
      n.position.z = THREE.MathUtils.lerp(n.position.z, baseZ, 18 * dt);
    }
  }

  function getMuzzleWorld(out) {
    gun.updateMatrixWorld(true);
    if (muzzleMode === "node" && muzzleNode) {
      return muzzleNode.getWorldPosition(out);
    }
    return out.copy(muzzleLocal).applyMatrix4(gun.matrixWorld);
  }

  function getEjectWorld(out) {
    gun.updateMatrixWorld(true);
    if (ejectMode === "node" && ejectNode) {
      return ejectNode.getWorldPosition(out);
    }
    return out.copy(ejectLocal).applyMatrix4(gun.matrixWorld);
  }

  function getEjectVelocity(out) {
    // Right/up/back-ish toss so casings visibly arc away from the weapon.
    return out.set(1, 0.42, 0.18).applyQuaternion(gun.quaternion).normalize();
  }

  return { gun, kick, settle, getMuzzleWorld, getEjectWorld, getEjectVelocity };
}
