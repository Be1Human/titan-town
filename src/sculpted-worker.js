import * as THREE from '../vendor/three.module.js';
import {normalizeAppearance} from './character-config.js';

// An independent polygon character preview. +Z is forward; the bind pose has
// its soles on y=0. Surfaces are lofted meshes, not collections of voxel boxes.
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, n) => { const t = clamp((n - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp3 = (a, b, t) => a.map((v, i) => mix(v, b[i], t));
const colour = (value, fallback) => {
  const safe = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff || typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
  return new THREE.Color(safe ? value : fallback);
};
const tinted = (c, factor) => Object.assign(c.clone().multiplyScalar(factor),{workerRoughness:c.workerRoughness,workerMetalness:c.workerMetalness});

function form(variant) {
  if (variant === 'human') return {
    variant, height: 1.86, hip: .90, spine: 1.20, head: 1.62,
    shoulder: [.25, 1.365, 0], elbow: [.33, 1.14, .01], wrist: [.35, .925, .065],
    legX: .13, legTop: .91, knee: .48, ankle: .115,
    boot: [.205, .155, .295], bodyExponent: 3.1, headExponent: 2.9,
    headRings: [[1.465, .075, .075], [1.50, .115, .115], [1.59, .13, .117], [1.70, .128, .117], [1.75, .10, .102], [1.78, .06, .055]],
    faceY: 1.605, eyeX: .051, eyeY: 1.652, mouthY: 1.549, eyeSize: .0105,
    hatY: 1.725, hatW: .19, hatD: .164, hatH: .125,
  };
  return {
    variant: 'rounded', height: 1.90, hip: .39, spine: .94, head: 1.36,
    shoulder: [.365, 1.11, 0], elbow: [.515, .93, .01], wrist: [.555, .735, .11],
    legX: .165, legTop: .395, knee: .245, ankle: .085,
    boot: [.255, .13, .32], bodyExponent: 2.6, headExponent: 2.5,
    faceY: 1.395, eyeX: .115, eyeY: 1.438, mouthY: 1.335, eyeSize: .024,
    hatY: 1.625, hatW: .44, hatD: .365, hatH: .265,
  };
}

export function createRig(f) {
  const bones = {}, list = [], index = {}, points = {};
  function add(name, point, parent) {
    const bone = new THREE.Bone(); bone.name = name;
    bones[name] = bone; index[name] = list.length; list.push(bone); points[name] = point;
    bone.position.fromArray(parent ? point.map((v, i) => v - points[parent][i]) : point);
    if (parent) bones[parent].add(bone);
    return bone;
  }
  add('root', [0, 0, 0]); add('hips', [0, f.hip, 0], 'root');
  add('spine', [0, f.spine, 0], 'hips'); add('head', [0, f.head, 0], 'spine');
  for (const side of [-1, 1]) {
    const name = side < 0 ? 'left' : 'right', p = a => [a[0] * side, a[1], a[2]];
    add(`${name}Shoulder`, f.shoulders?.[name] || p(f.shoulder), 'spine');
    add(`${name}Elbow`, f.elbows?.[name] || p(f.elbow), `${name}Shoulder`);
    add(`${name}Wrist`, f.wrists?.[name] || p(f.wrist), `${name}Elbow`);
    add(`${name}Hip`, [side * f.legX, f.legTop, 0], 'hips');
    add(`${name}Knee`, [side * f.legX, f.knee, .01], `${name}Hip`);
    add(`${name}Foot`, [side * f.legX, f.ankle, .015], `${name}Knee`);
  }
  const skin = (a, b = a, t = 0) => ({ indices: [index[a], index[b], 0, 0], weights: [1 - t, t, 0, 0] });
  return { bones, list, points, skin };
}

export function createSurfaceBuilder(rig) {
  const positions = [], normals = [], colors = [], finishes = [], skinIndices = [], skinWeights = [], indices = [];
  function append(geometry, paint, weighting) {
    const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), offset = positions.length / 3;
    if (paint.region) {
      // Split only colour regions on the actual surface. The boundary shares
      // positions and interpolated normals, so it is an inlaid colour area,
      // not a raised face plate or a gradient stretched across large faces.
      const read = i => {
        const v = { p: [p.getX(i), p.getY(i), p.getZ(i)], n: [n.getX(i), n.getY(i), n.getZ(i)] };
        v.d = paint.region(...v.p); return v;
      };
      const cut = (polygon, inside) => {
        const result = [];
        for (let i = 0; i < polygon.length; i++) {
          const a = polygon[i], c = polygon[(i + 1) % polygon.length], aa = inside ? a.d >= 0 : a.d <= 0, cc = inside ? c.d >= 0 : c.d <= 0;
          if (aa) result.push(a);
          if (aa !== cc) {
            const t = a.d / (a.d - c.d), normal = lerp3(a.n, c.n, t), length = Math.hypot(...normal);
            result.push({ p: lerp3(a.p, c.p, t), n: normal.map(v => v / length), d: 0 });
          }
        }
        return result;
      };
      const emit = (polygon, color) => {
        for (let j = 1; j < polygon.length - 1; j++) for (const v of [polygon[0], polygon[j], polygon[j + 1]]) {
          const w = typeof weighting === 'function' ? weighting(...v.p) : weighting;
          const c=typeof color==='function'?color(...v.p):color;
          indices.push(positions.length / 3); positions.push(...v.p); normals.push(...v.n); colors.push(c.r, c.g, c.b);finishes.push(c.workerRoughness??.94,c.workerMetalness??0);
          skinIndices.push(...w.indices); skinWeights.push(...w.weights);
        }
      };
      const source = geometry.index.array;
      for (let i = 0; i < source.length; i += 3) {
        const triangle = [read(source[i]), read(source[i + 1]), read(source[i + 2])];
        emit(cut(triangle, false), paint.base); emit(cut(triangle, true), paint.inside);
      }
      geometry.dispose(); return;
    }
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), c = typeof paint === 'function' ? paint(x, y, z) : paint;
      const w = typeof weighting === 'function' ? weighting(x, y, z) : weighting;
      positions.push(x, y, z); normals.push(n.getX(i), n.getY(i), n.getZ(i));
      colors.push(c.r,c.g,c.b);finishes.push(c.workerRoughness??.94,c.workerMetalness??0);skinIndices.push(...w.indices);skinWeights.push(...w.weights);
    }
    if (geometry.index) for (const i of geometry.index.array) indices.push(offset + i);
    else for (let i = 0; i < p.count; i++) indices.push(offset + i);
    geometry.dispose();
  }
  // Every ring joins its neighbours. The same vertices are shared along the
  // entire sleeve/leg; intermediate rings carry blended joint weights.
  function loft(rings, paint, weighting, { segments = 20, exponent = 2.5, caps = true } = {}) {
    const vertices = [], faces = [];
    for (const ring of rings) for (let j = 0; j < segments; j++) {
      const a = j / segments * Math.PI * 2, sx = Math.sin(a), sz = Math.cos(a), power = 2 / (ring.exponent || exponent);
      vertices.push((ring.x || 0) + Math.sign(sx) * Math.abs(sx) ** power * ring.rx, ring.y,
        (ring.z || 0) + Math.sign(sz) * Math.abs(sz) ** power * ring.rz);
    }
    for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < segments; j++) {
      const a = i * segments + j, an = i * segments + (j + 1) % segments, b = a + segments, bn = an + segments;
      faces.push(a, an, b, an, bn, b);
    }
    if (caps) {
      const bottom = vertices.length / 3, r0 = rings[0], top = bottom + 1, r1 = rings.at(-1);
      vertices.push(r0.x || 0, r0.y, r0.z || 0, r1.x || 0, r1.y, r1.z || 0);
      for (let j = 0; j < segments; j++) {
        faces.push(bottom, (j + 1) % segments, j);
        const offset = (rings.length - 1) * segments;
        faces.push(top, offset + j, offset + (j + 1) % segments);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); g.setIndex(faces); g.computeVertexNormals();
    append(g, paint, weighting);
  }
  function ellipsoid(p, r, paint, weighting, segments = 16, rows = 10) {
    const g = new THREE.SphereGeometry(1, segments, rows); g.scale(...r); g.translate(...p); append(g, paint, weighting);
  }
  function roundedBlock(p, s, paint, weighting, bevel = .025) {
    const [x, y, z] = p, [w, h, d] = s, cut = Math.min(bevel, w * .22, h * .3, d * .22);
    loft([
      { x, y: y - h / 2, z, rx: w / 2 - cut, rz: d / 2 - cut },
      { x, y: y - h / 2 + cut, z, rx: w / 2, rz: d / 2 },
      { x, y: y + h / 2 - cut, z, rx: w / 2, rz: d / 2 },
      { x, y: y + h / 2, z, rx: w / 2 - cut, rz: d / 2 - cut },
    ], paint, weighting, { segments: 8, exponent: 5 });
  }
  function finish() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    g.setAttribute('workerSurface',new THREE.Float32BufferAttribute(finishes,2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    g.setIndex(indices); g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
  return { loft, ellipsoid, roundedBlock, finish, box(p,s,paint,weighting,rotation) { const g=new THREE.BoxGeometry(...s);if(rotation){g.rotateX(rotation[0]||0);g.rotateY(rotation[1]||0);g.rotateZ(rotation[2]||0);}g.translate(...p);append(g,paint,weighting); } };
}

function frontAt(rings, x, y, exponent) {
  let a = rings[0], b = rings.at(-1);
  for (let i = 0; i < rings.length - 1; i++) if (y >= rings[i].y && y <= rings[i + 1].y) { a = rings[i]; b = rings[i + 1]; break; }
  const t = clamp((y - a.y) / Math.max(.0001, b.y - a.y), 0, 1), rx = mix(a.rx, b.rx, t), rz = mix(a.rz, b.rz, t);
  return mix(a.z || 0, b.z || 0, t) + rz * Math.max(0, 1 - Math.abs(x / rx) ** exponent) ** (1 / exponent);
}

export function createSculptedWorker(options = {}) {
  const f = form(options.variant), rounded = f.variant === 'rounded';
  const appearance = normalizeAppearance(options.appearance || options);
  const orange = colour(appearance.bodyColor, 0x9a6545), yellow = colour(appearance.hatColor, 0xbaa467);
  const pants = colour(appearance.outfitColor, 0x465056), face = colour(appearance.faceColor, 0xcda17f), gloveColor = colour(appearance.gloveColor, 0x796f59);
  const dark = colour(null, 0x3b3833), brown = colour(null, 0x705339), sole = colour(null, 0x303539), steel = colour(null, 0x94a5a9);
  orange.workerRoughness=.97;pants.workerRoughness=.98;gloveColor.workerRoughness=.90;
  yellow.workerRoughness=.57;face.workerRoughness=.86;dark.workerRoughness=.79;brown.workerRoughness=.87;sole.workerRoughness=.99;
  steel.workerRoughness=.48;steel.workerMetalness=.58;
  const rig = createRig(f), { skin, bones } = rig, b = createSurfaceBuilder(rig);
  const bodySkin = (x, y) => {
    if (rounded && y > 1.09) return skin('spine', 'head', smooth(1.09, 1.34, y));
    return skin('hips', 'spine', smooth(f.hip + .08, f.spine, y));
  };
  let bodyRings = rounded ? [
    [.30, .255, .18], [.34, .34, .245], [.45, .425, .295], [.60, .47, .32], [.79, .465, .315],
    [.97, .42, .29], [1.12, .37, .275], [1.26, .355, .29], [1.39, .345, .29],
    [1.50, .32, .275], [1.60, .265, .24], [1.68, .17, .17], [1.72, .045, .06],
  ].map(([y, rx, rz]) => ({ y, rx, rz })) : [
    [.90, .205, .142], [.97, .218, .145], [1.12, .245, .158], [1.29, .26, .16],
    [1.365, .25, .15], [1.412, .183, .122],
  ].map(([y, rx, rz]) => ({ y, rx, rz }));
  if (rounded) {
    const refined = [];
    for (let i = 0; i < bodyRings.length - 1; i++) {
      const a = bodyRings[i], c = bodyRings[i + 1], steps = a.y > 1.1 ? Math.ceil((c.y - a.y) / .035) : 1;
      for (let j = 0; j < steps; j++) refined.push({ y: mix(a.y, c.y, j / steps), rx: mix(a.rx, c.rx, j / steps), rz: mix(a.rz, c.rz, j / steps) });
    }
    bodyRings = [...refined, bodyRings.at(-1)];
  }
  const garmentColor=(x,y,z)=>{
    if(appearance.outfit==='overalls'&&(y<.78||z>.16&&Math.abs(x)<.255&&y<1.115))return pants;
    if(appearance.outfit==='vest'&&y>.59&&y<1.16&&Math.abs(x)>.045)return pants;
    return orange;
  };
  const bodyPaint = rounded ? { base: garmentColor, inside: face,
    region: (x, y, z) => Math.min(1 - (x / (.247*appearance.faceSize)) ** 2 - ((y - f.faceY) / (.205*appearance.faceSize)) ** 2, (z - .17) * 5),
  } : orange;
  b.loft(bodyRings, bodyPaint, bodySkin, { segments: rounded ? 32 : 20, exponent: f.bodyExponent });

  let headRings = bodyRings;
  if (!rounded) {
    b.ellipsoid([0, 1.447, 0], [.076, .069, .076], face, skin('spine', 'head', .6));
    headRings = f.headRings.map(([y, rx, rz]) => ({ y, rx, rz }));
    b.loft(headRings, (x, y, z) => y > 1.73 || z < -.055 && y > 1.58 ? tinted(brown,.70) : face, skin('head'), { segments: 24, exponent: f.headExponent });
    for (const side of [-1, 1]) b.ellipsoid([side * .132, 1.62, -.014], [.021, .039, .026], tinted(face, .93), skin('head'), 12, 8);
  }
  const front = (x, y) => frontAt(headRings, x, y, rounded ? f.bodyExponent : f.headExponent);
  // Small polished eyes and a restrained smile are fitted to the face curve.
  for (const side of [-1, 1]) {
    const fs = appearance.faceSize, x = side * f.eyeX * fs, y = f.eyeY, z = front(x, y);
    b.ellipsoid([x, y, z + .004], [f.eyeSize*fs, f.eyeSize*(appearance.expression==='happy'?.68:1.05)*fs, rounded?.013:.007], dark, skin('head'), 12, 8);
    if (rounded) b.ellipsoid([x - .004, y + .007, z + .020], [.0055, .006, .003], colour(null, 0xfff3d8), skin('head'), 8, 6);
    if (!rounded||appearance.expression==='angry'||appearance.expression==='worried') {
      const slope=appearance.expression==='angry'?-side:appearance.expression==='worried'?side:0;
      const browY=y+(rounded?.054:.026);
      for(let j=-1;j<=1;j++)b.roundedBlock([x+j*.012,browY+j*.005*slope,front(x+j*.012,browY)+.002],[.017,.007,.008],tinted(brown,.7),skin('head'),.002);
    }
  }
  const mouthWidth = (rounded ? .085 : .045)*appearance.faceSize;
  if(appearance.expression==='surprised')b.ellipsoid([0,f.mouthY,front(0,f.mouthY)+.003],[.011,.018,.005],tinted(brown,.75),skin('head'),12,8);
  else for (let i = 0; i < 7; i++) {
    const x = (i / 6 - .5) * mouthWidth, bend=appearance.expression==='happy'?.014:appearance.expression==='worried'||appearance.expression==='angry'?-.009:.002;
    const y = f.mouthY + bend * (2 * x / mouthWidth) ** 2;
    b.ellipsoid([x, y, front(x, y) + .002], [rounded?.010:.0047, rounded?.007:.0033, .004], tinted(brown, .75), skin('head'), 8, 6);
  }
  if (!rounded) b.ellipsoid([0, f.faceY - .004, front(0, f.faceY) + .003], [.015,.026,.020], tinted(face,.96),skin('head'),12,8);

  // A low, continuous hardhat with two deliberate shallow ledges. The narrow
  // ring bevels create the carved outline without texturing the whole model.
  const hy = f.hatY, hw = f.hatW, hd = f.hatD;
  if(appearance.hat==='hardhat'){
  b.loft([
    { y: hy - .027, rx: hw * .94, rz: hd * .96, z: .018 },
    { y: hy - .014, rx: hw, rz: hd, z: .018 },
    { y: hy + .015, rx: hw, rz: hd, z: .018 },
    { y: hy + .030, rx: hw * .90, rz: hd * .89, z: .01 },
  ], tinted(yellow, .96), skin('head'), { segments: 24, exponent: 2.8 });
  b.loft([
    { y: hy + .019, rx: hw * .86, rz: hd * .83 },
    { y: hy + .064, rx: hw * .86, rz: hd * .83 },
    { y: hy + f.hatH * .55, rx: hw * .76, rz: hd * .73 },
    { y: hy + f.hatH * .85, rx: hw * .57, rz: hd * .54 },
    { y: hy + f.hatH, rx: hw * .30, rz: hd * .29 },
  ], yellow, skin('head'), { segments: 24, exponent: 2.55 });
  b.roundedBlock([0, hy + f.hatH + .004, 0], [rounded ? .07 : .045, .012, hd * .5], tinted(yellow, 1.05), skin('head'), .005);
  b.roundedBlock([0, hy + .069, hd * .825], [rounded ? .065 : .045, .034, .018], tinted(yellow, 1.12), skin('head'), .008);
  }else if(appearance.hat==='cap'){
    b.loft([{y:hy-.012,rx:hw*.77,rz:hd*.79},{y:hy+.045,rx:hw*.76,rz:hd*.77},{y:hy+.10,rx:hw*.47,rz:hd*.5}],yellow,skin('head'),{segments:20,exponent:2.6});
    b.roundedBlock([0,hy,.125],[hw*1.53,.026,hd*1.15],tinted(yellow,.87),skin('head'),.012);
  }

  for (const side of [-1, 1]) {
    const name = side < 0 ? 'left' : 'right';
    const armSkin = (x, y) => {
      const t = smooth(f.elbow[1] - .045, f.elbow[1] + .095, y);
      if (y < f.elbow[1] - .045) return skin(`${name}Wrist`, `${name}Elbow`, smooth(f.wrist[1], f.wrist[1] + .115, y));
      return skin(`${name}Elbow`, `${name}Shoulder`, t);
    };
    const armRings = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12, point = t < .5 ? lerp3(f.wrist, f.elbow, t * 2) : lerp3(f.elbow, f.shoulder, (t - .5) * 2);
      const radius = (rounded ? mix(.089, .124, t) : mix(.053, .086, t))*appearance.armSize;
      armRings.push({ x: point[0] * side, y: point[1], z: point[2], rx: radius, rz: radius * (rounded ? .95 : 1.04) });
    }
    b.loft(armRings, (x, y) => !rounded && y < f.elbow[1] + .012 ? face : orange, armSkin, { segments: 16, exponent: rounded ? 2.4 : 2.9 });
    const wx = f.wrist[0] * side, wy = f.wrist[1], wz = f.wrist[2], glove = gloveColor,armScale=appearance.armSize;
    b.loft([{x:wx,y:wy-.019,z:wz,rx:(rounded?.105:.062)*armScale,rz:(rounded?.094:.059)*armScale},
      {x:wx,y:wy+.018,z:wz,rx:(rounded?.102:.059)*armScale,rz:(rounded?.092:.057)*armScale}],tinted(glove,.83),skin(`${name}Wrist`),{segments:16,exponent:3});
    b.ellipsoid([wx,wy-.052,wz+.012],[rounded?.105:.061,rounded?.095:.068,rounded?.098:.058].map(v=>v*armScale),glove,skin(`${name}Wrist`),16,10);
    b.ellipsoid([wx-side*(rounded?.086:.048),wy-.044,wz+.047],[rounded?.042:.025,.044,.035].map(v=>v*armScale),tinted(glove,1.025),skin(`${name}Wrist`),12,8);

    const legSkin = (x, y) => {
      if (y < f.knee - .03) return skin(`${name}Foot`, `${name}Knee`, smooth(f.ankle, f.knee - .03, y));
      return skin(`${name}Knee`, `${name}Hip`, smooth(f.knee - .03, mix(f.knee, f.legTop, .62), y));
    };
    const legRings = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, y = mix(f.ankle, f.legTop, t);
      const radius = rounded ? mix(.09, .13, t) : mix(.078, .107, t);
      legRings.push({ x: side * f.legX, y, z: .01 * Math.sin(t * Math.PI), rx: radius, rz: radius * 1.1 });
    }
    b.loft(legRings,pants,legSkin,{segments:16,exponent:2.9});
    const [bw, bh, bd] = f.boot, bootSkin = skin(`${name}Foot`), bx = side * f.legX;
    b.roundedBlock([bx, .0225, .050], [bw * 1.035, .045, bd], sole, bootSkin, .018);
    b.loft([
      { x: bx, y: .036, z: .051, rx: bw * .50, rz: bd * .485 },
      { x: bx, y: bh * .65, z: .047, rx: bw * .49, rz: bd * .47 },
      { x: bx, y: bh, z: .018, rx: bw * .40, rz: bd * .29 },
    ], rounded ? tinted(brown, .70) : brown, bootSkin, { segments: 16, exponent: 3.8 });
    if (!rounded) b.roundedBlock([bx, f.knee + .025, .139], [.13, .145, .032], tinted(pants, .85), skin(`${name}Knee`, `${name}Hip`, .20), .020);
  }

  // Small garment details follow the torso. There is no procedural grid.
  if (!rounded) {
    b.loft([{y:.906,rx:.209,rz:.145},{y:.952,rx:.216,rz:.148}],brown,skin('hips'),{segments:20,exponent:3.2});
    b.roundedBlock([0,.93,.153],[.062,.035,.014],tinted(steel,.77),skin('hips'),.006);
  }
  const pocketY = rounded ? .91 : 1.23, pocketX = rounded ? -.18 : -.135, pocketZ = frontAt(bodyRings, pocketX, pocketY, f.bodyExponent);
  b.roundedBlock([pocketX, pocketY, pocketZ + .007], [rounded ? .155 : .116, rounded ? .125 : .105, .018], tinted(orange, .90), bodySkin(pocketX, pocketY), .018);
  b.roundedBlock([pocketX, pocketY + (rounded ? .047 : .039), pocketZ + .020], [rounded ? .159 : .12, .018, .012], tinted(orange, 1.06), bodySkin(pocketX, pocketY), .005);
  for(const y of rounded?[.91,.80]:[1.32,1.21,1.10])b.ellipsoid([0,y,frontAt(bodyRings,0,y,f.bodyExponent)+.004],[.006,.006,.005],tinted(brown,.9),bodySkin(0,y),8,6);
  if(!rounded&&appearance.outfit==='overalls'){
    b.roundedBlock([0,1.085,.160],[.30,.25,.018],pants,bodySkin(0,1.085),.02);
    for(const side of [-1,1])for(let i=0;i<7;i++){const y=1.21+i*.027,x=side*.12;b.roundedBlock([x,y,frontAt(bodyRings,x,y,f.bodyExponent)+.009],[.037,.032,.017],pants,bodySkin(x,y),.004);}
  }else if(!rounded&&appearance.outfit==='vest'){
    for(const side of[-1,1]){
      b.roundedBlock([side*.14,1.165,.159],[.20,.40,.022],pants,bodySkin(side*.14,1.165),.025);
      b.roundedBlock([side*.14,1.105,.176],[.19,.033,.009],colour(null,0xb7b6a3),bodySkin(side*.14,1.105),.004);
      b.roundedBlock([side*.13,1.284,.176],[.032,.11,.009],colour(null,0xb7b6a3),bodySkin(side*.13,1.284),.004);
    }
  }else if(!rounded&&appearance.outfit==='satchel'){
    for(let i=0;i<15;i++){const t=i/14,x=mix(-.19,.19,t),y=mix(.99,1.365,t);b.roundedBlock([x,y,frontAt(bodyRings,x,y,f.bodyExponent)+.012],[.047,.037,.013],pants,bodySkin(x,y),.004);}
    b.roundedBlock([-.22,.94,.155],[.20,.225,.09],pants,skin('hips'),.025);
    b.roundedBlock([-.22,1.005,.208],[.20,.068,.014],tinted(pants,1.07),skin('hips'),.006);
  }
  if(rounded&&appearance.outfit==='overalls'){
    for(const side of[-1,1])for(let i=0;i<9;i++){const y=1.02+i*.023,x=side*.23;b.roundedBlock([x,y,frontAt(bodyRings,x,y,f.bodyExponent)+.008],[.047,.028,.014],pants,bodySkin(x,y),.005);}
  }else if(rounded&&appearance.outfit==='vest'){
    for(const side of[-1,1])for(let i=0;i<5;i++){const x=side*(.07+i*.055),y=.82;b.roundedBlock([x,y,frontAt(bodyRings,x,y,f.bodyExponent)+.006],[.057,.035,.009],colour(null,0xb7b6a3),bodySkin(x,y),.004);}
  }else if(rounded&&appearance.outfit==='satchel'){
    for(let i=0;i<19;i++){const t=i/18,x=mix(-.33,.30,t),y=mix(.60,1.17,t);b.roundedBlock([x,y,frontAt(bodyRings,x,y,f.bodyExponent)+.009],[.055,.040,.013],pants,bodySkin(x,y),.005);}
    b.roundedBlock([-.28,.62,.303],[.27,.245,.09],pants,bodySkin(-.28,.62),.025);
    b.roundedBlock([-.28,.70,.356],[.27,.067,.013],tinted(pants,1.08),bodySkin(-.28,.70),.007);
  }

  const geometry = b.finish(), material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .94, metalness: 0 });
  material.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec2 workerSurface; varying vec2 vWorkerSurface;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvWorkerSurface=workerSurface;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec2 vWorkerSurface;')
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=vWorkerSurface.x;')
      .replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=vWorkerSurface.y;');
  };
  material.customProgramCacheKey=()=> 'sculpted-worker-surfaces-v1';
  const mesh = new THREE.SkinnedMesh(geometry, material); mesh.name = `sculpted-worker-${f.variant}`;
  mesh.add(bones.root); mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false;
  const group = new THREE.Group(); group.name = mesh.name; group.add(mesh);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(rig.list); mesh.bind(skeleton); mesh.normalizeSkinWeights();

  const attachments = {};
  for (const side of ['left', 'right']) {
    const hand = new THREE.Group(); hand.name = `${side}-hand-attachment`;
    hand.position.set(0,-.052,rounded?.075:.048);bones[`${side}Wrist`].add(hand);attachments[`${side}Hand`]=hand;
  }
  const hammerBuilder = createSurfaceBuilder(rig), rigid = skin('root');
  if(appearance.prop==='ingot'){
    hammerBuilder.roundedBlock([0,0,.025],[.24,.10,.125],colour(null,0x9b977b),rigid,.018);
  }else if(appearance.prop==='clipboard'){
    hammerBuilder.roundedBlock([0,.025,.018],[.21,.29,.023],brown,rigid,.012);
    hammerBuilder.roundedBlock([0,.025,.033],[.18,.255,.009],colour(null,0xd5cdb8),rigid,.007);
    hammerBuilder.roundedBlock([0,.153,.040],[.065,.036,.010],steel,rigid,.006);
    for(let i=0;i<4;i++)hammerBuilder.roundedBlock([0,.078-i*.034,.040],[.12,.004,.002],colour(null,0x747b75),rigid,.001);
  }else if(appearance.prop==='tape'){
    hammerBuilder.roundedBlock([0,0,.015],[.094,.084,.065],yellow,rigid,.018);
    hammerBuilder.roundedBlock([0,-.06,.018],[.026,.13,.009],colour(null,0xb9b29b),rigid,.004);
    hammerBuilder.roundedBlock([0,-.124,.017],[.032,.014,.019],steel,rigid,.004);
  }else{
  hammerBuilder.roundedBlock([0, -.015, 0], [.038, .36, .040], colour(null, 0xac7a42), rigid, .008);
  hammerBuilder.roundedBlock([0, -.135, 0], [.049, .10, .05], brown, rigid, .009);
  hammerBuilder.roundedBlock([0, .185, 0], [.20, .079, .085], steel, rigid, .012);
  hammerBuilder.roundedBlock([-.102, .185, 0], [.033, .09, .10], tinted(steel, .77), rigid, .010);
  }
  const prop = new THREE.Mesh(hammerBuilder.finish(), material); prop.name = 'worker-hammer'; prop.castShadow = true;
  attachments.leftHand.add(prop);prop.visible=options.prop!==false&&appearance.prop!=='none';

  const restPositions = rig.list.map(bone => bone.position.clone());
  function animate(time, amount = 1) {
    const a = clamp(Number.isFinite(amount) ? amount : 1, 0, 1), t = Number.isFinite(time) ? time : 0, phase = t * 3.7;
    for (let i = 0; i < rig.list.length; i++) { rig.list[i].rotation.set(0, 0, 0); rig.list[i].position.copy(restPositions[i]); }
    bones.root.position.y = .012 * (1 - Math.cos(phase * 2)) * a;
    bones.hips.rotation.y = Math.sin(phase) * .045 * a; bones.spine.rotation.z = Math.sin(phase) * .025 * a;
    bones.head.rotation.y = Math.sin(t * .7) * .07 * a;
    for (const side of [-1, 1]) {
      const name = side < 0 ? 'left' : 'right', swing = Math.sin(phase) * side;
      bones[`${name}Hip`].rotation.x = swing * (rounded ? .33 : .43) * a;
      bones[`${name}Knee`].rotation.x = Math.max(0, -swing) * .63 * a;
      bones[`${name}Foot`].rotation.x = (-swing * .12 - Math.max(0, -swing) * .24) * a;
      bones[`${name}Shoulder`].rotation.x = -swing * .23 * a;
      bones[`${name}Elbow`].rotation.x = (-.22 + Math.sin(phase + .9 * side) * .18) * a;
      bones[`${name}Wrist`].rotation.z = Math.sin(phase + side) * .065 * a;
    }
    group.updateMatrixWorld(true); skeleton.update();
  }
  animate(0, 0);
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const metrics = Object.freeze({ variant: f.variant, height: geometry.boundingBox.max.y, size: size.toArray(),
    vertices: geometry.getAttribute('position').count, triangles: geometry.index.count / 3,
    propVertices: prop.geometry.getAttribute('position').count, propTriangles: prop.geometry.index.count / 3,
    bones: rig.list.length, drawCalls: prop.visible ? 2 : 1, skinned: true, forward: '+Z', footY: geometry.boundingBox.min.y });
  let disposed = false;
  function dispose() {
    if (disposed) return; disposed = true;
    geometry.dispose();prop.geometry.dispose();material.dispose();skeleton.dispose();prop.removeFromParent();group.removeFromParent();
  }
  return { group, mesh, bones, skeleton, prop, attachments, animate, dispose, metrics,
    setPropVisible(visible) { prop.visible = Boolean(visible); } };
}
