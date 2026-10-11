# Rapier 3D

- Upstream: https://github.com/dimforge/rapier
- Official package: `@dimforge/rapier3d-simd-compat` **0.21.0** (WebAssembly SIMD build of the same Rapier release)
- Download: https://registry.npmjs.org/@dimforge/rapier3d-simd-compat/-/rapier3d-simd-compat-0.21.0.tgz
- Package SHA-512 (verified against the registry `dist.integrity`): `o30irwGVP/Q8CYxZBBtftMqhq/kUY2nGv4ml5xNkblpDD5IViybzxo3XtuNnq1C5RJgeGagLgBFRJBMrt2ydLw==`
- `rapier.js` SHA-256: `889AB6AFCDB530AB41C08A6E72400876C5B17E8573E5B21973D7CE431C9267BF`
- License: Apache-2.0, reproduced in `RAPIER-LICENSE.txt` (identical to the package `LICENSE`).
- `rapier.js` is the unmodified content of the package's `dist/rapier.mjs`, renamed for this project's static server. It includes the upstream WebAssembly binary as base64 and does not need a CDN at runtime. The optional upstream source map is not distributed. The runtime requires WebAssembly SIMD (Chromium 91+, Node 16.4+; the desktop client uses Electron 44).

The application adapter in `src/rigid-world.js` and the player/rendering integration are project code. Rapier supplies rigid-body dynamics; voxel fracture, material damage, chunk meshes and structural support remain this project's systems.
