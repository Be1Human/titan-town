const CELL = .05;
const profiles = Object.freeze({
  fragile: {name: '原创玻璃花瓶', radius: .28, height: 1.1, width: .56, depth: .56, limits: [7, 18, 12, 34, 7, 18]},
  bulky: {name: '原创织物沙发', radius: .85, height: .9, width: 1.77, depth: .85, limits: [18, 40, 12, 26, 9, 20]},
  heavy: {name: '原创薄钢保险柜', radius: .44, height: 1.25, width: .88, depth: .72, limits: [12, 24, 16, 34, 10, 20]}
});
const count = (metres, min, max) => Math.max(min, Math.min(max, Math.round(metres / CELL)));

// Independent project models. No original game assets, coordinates or source
// are used. Dimensions snap to the 5 cm grid and clamp to construction budgets;
// shell/foot thickness stays physical rather than filling an envelope box.
// RigidWorld centres the source bounds at the supplied nominal cargo position.
// Thus default floors align exactly with y-height/2; custom non-grid heights
// differ by at most half a cell unless they exceed the documented size clamps.
export function createOriginalCargo(cargo = {}) {
  if(cargo.type==='parcel'){
    const dims={S:[4,4,5],M:[7,4,5],L:[7,7,5]}[cargo.rackSize];
    if(!dims)throw new RangeError('Unknown parcel size');
    const [w,h,d]=dims,cells=[];
    for(let y=0;y<h;y++)for(let z=0;z<d;z++)for(let x=0;x<w;x++)
      if(x===0||x===w-1||y===0||y===h-1||z===0||z===d-1)cells.push({x:x-Math.floor(w/2),y:y-Math.floor(h/2),z:z-Math.floor(d/2),mat:x===Math.floor(w/2)?'plaster':'wood'});
    return {name:cargo.name||'配送包裹',cells,cellSize:CELL,position:{x:cargo.x||0,y:cargo.y||0,z:cargo.z||0},strength:1,density:1};
  }
  const profile = profiles[cargo.type];
  if (!profile) throw new RangeError(`Unknown original cargo type: ${cargo.type}`);
  const radius = Number.isFinite(cargo.radius) && cargo.radius > 0 ? cargo.radius : profile.radius;
  const height = Number.isFinite(cargo.height) && cargo.height > 0 ? cargo.height : profile.height;
  const scale = radius / profile.radius, [minW, maxW, minH, maxH, minD, maxD] = profile.limits;
  const w = count(profile.width * scale, minW, maxW), h = count(height, minH, maxH), d = count(profile.depth * scale, minD, maxD);
  const offset = {x: -Math.floor(w / 2), y: -Math.floor(h / 2), z: -Math.floor(d / 2)}, cells = new Map();
  const put = (x, y, z, mat) => {
    if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d) return;
    x += offset.x; y += offset.y; z += offset.z;
    cells.set(`${x},${y},${z}`, {x, y, z, mat});
  };
  const box = (x, y, z, width, height, depth, mat) => {
    for (let b = y; b < y + height; b++) for (let c = z; c < z + depth; c++) for (let a = x; a < x + width; a++) put(a, b, c, mat);
  };
  if (cargo.type === 'fragile') {
    // Seven adjoining stepped rings form an open mouth and a genuine cavity.
    // Transition bands overlap vertically; the two bottom layers close the base.
    const stages = [[.09, .65], [.22, .83], [.53, 1], [.68, .83], [.82, .65], [.93, .48], [1, .65]];
    const radii = stages.map(([, ratio]) => Math.max(3, Math.round(Math.min(w, d) * ratio)) * CELL / 2);
    const thickness = Math.max(CELL * 1.5, ...radii.slice(1).map((r, i) => Math.abs(r - radii[i]) + CELL / 2));
    for (let y = 0; y < h; y++) {
      const stage = stages.findIndex(([end]) => (y + .5) / h <= end), outer = radii[stage], inner = Math.max(0, outer - thickness);
      for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
        const dx = (x + .5 - w / 2) * CELL, dz = (z + .5 - d / 2) * CELL, distance2 = dx * dx + dz * dz;
        if (distance2 <= outer * outer + 1e-12 && (y < 2 || distance2 > inner * inner + 1e-12)) put(x, y, z, 'glass');
      }
    }
  } else if (cargo.type === 'bulky') {
    const foot = Math.max(3, Math.round(h * .22)), arm = Math.max(2, Math.round(w * .085)), armTop = Math.round(h * .67), cushion = 4;
    // Four discrete timber feet contact the ground and join a thin seat frame.
    for (const x of [2, w - 4]) for (const z of [2, d - 4]) box(x, 0, z, 2, foot, 2, 'wood');
    box(1, foot - 1, 1, w - 2, 2, d - 2, 'wood');
    box(0, foot, d - 2, w, h - foot - 1, 1, 'wood');
    for (const x of [0, w - arm]) box(x, foot, 0, arm, armTop - foot, d - 1, 'wood');
    // Two upholstered seat cushions share their wooden support; a real seam
    // separates their upper occupancy rather than one solid cargo-sized box.
    const middle = Math.floor(w / 2);
    box(arm, foot + 1, 0, middle - arm, cushion, d - 3, 'plaster');
    box(middle + 1, foot + 1, 0, w - arm - middle - 1, cushion, d - 3, 'plaster');
    box(0, foot + 1, d - 3, w, h - foot - 1, 1, 'plaster');
    box(0, foot + 1, d - 1, w, h - foot - 1, 1, 'plaster');
    box(0, h - 1, d - 3, w, 1, 3, 'plaster');
    for (const x of [0, w - arm]) {
      box(x, armTop, 0, arm, 1, d - 1, 'plaster');
      box(x === 0 ? 0 : w - 1, foot + 1, 0, 1, armTop - foot, d - 1, 'plaster');
      box(x, foot + 1, 0, arm, armTop - foot, 1, 'plaster');
    }
  } else {
    // Metal wall plates surround an empty volume. The door is a separate thin
    // plate connected to the shell at two voxel hinges, not a simulated joint.
    for (const x of [2, w - 4]) for (const z of [2, d - 4]) box(x, 0, z, 2, 2, 2, 'metal');
    box(0, 2, 1, w, 1, d - 1, 'metal'); box(0, h - 1, 1, w, 1, d - 1, 'metal');
    box(0, 3, 1, 1, h - 4, d - 1, 'metal'); box(w - 1, 3, 1, 1, h - 4, d - 1, 'metal');
    box(1, 3, d - 1, w - 2, h - 4, 1, 'metal');
    box(2, 4, 1, w - 4, h - 6, 1, 'metal');
    for (const y of [Math.round(h * .28), Math.round(h * .72)]) box(1, y, 1, 2, 2, 2, 'metal');
    box(Math.round(w * .68), Math.round(h * .47), 0, 1, Math.max(2, Math.round(h * .16)), 1, 'metal');
    box(Math.round(w * .47), Math.round(h * .66), 0, 2, 2, 1, 'metal');
  }
  if (cells.size > 8192) throw new RangeError('Original cargo exceeded its voxel construction budget');
  return {name: cargo.name || profile.name, cells: [...cells.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x), cellSize: CELL,
    position: {x: Number.isFinite(cargo.x) ? cargo.x : 0, y: Number.isFinite(cargo.y) ? cargo.y : 0, z: Number.isFinite(cargo.z) ? cargo.z : 0}, strength: 1, density: 1};
}
