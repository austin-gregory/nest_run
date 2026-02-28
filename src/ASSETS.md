# Asset Setup

Update `src/constants.js`:

```js
export const ASSETS = {
  gunModelUrl: "./assets/models/rifle.glb",
  gunTextureUrl: "./assets/textures/rifle_albedo.png",
  gunMuzzleNodeName: "Muzzle",
  gunScale: 1.0,
};
```

Notes:
- `gunModelUrl` supports `.glb` or `.gltf`.
- `gunTextureUrl` is optional. If provided, it overrides mesh maps in the loaded gun model.
- Add an empty node named `Muzzle` in your DCC tool (Blender) to control projectile origin.
- If model loading fails, the game automatically falls back to the procedural gun.
