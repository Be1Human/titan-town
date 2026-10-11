import {CELL} from './voxel-world.js';

export const cellKey = c => `${c.x},${c.y},${c.z}`;
export function rotateVector(v, q) {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return {x: v.x + q.w * tx + q.y * tz - q.z * ty, y: v.y + q.w * ty + q.z * tx - q.x * tz, z: v.z + q.w * tz + q.x * ty - q.y * tx};
}
export function sourcePoint(entry, point) {
  const q = entry.rotation, v = rotateVector({x: point.x - entry.position.x, y: point.y - entry.position.y, z: point.z - entry.position.z}, {x: -q.x, y: -q.y, z: -q.z, w: q.w});
  return {x: v.x + entry.center.x, y: v.y + entry.center.y, z: v.z + entry.center.z};
}
export function worldPoint(entry, point) {
  const v = rotateVector({x: point.x - entry.center.x, y: point.y - entry.center.y, z: point.z - entry.center.z}, entry.rotation);
  return {x: v.x + entry.position.x, y: v.y + entry.position.y, z: v.z + entry.position.z};
}
export function cellsCenter(cells, cellSize = CELL) {
  const min = {x: Infinity, y: Infinity, z: Infinity}, max = {x: -Infinity, y: -Infinity, z: -Infinity};
  for (const c of cells) for (const a of ['x', 'y', 'z']) { min[a] = Math.min(min[a], c[a]); max[a] = Math.max(max[a], c[a] + 1); }
  return {x: (min.x + max.x) * cellSize / 2, y: (min.y + max.y) * cellSize / 2, z: (min.z + max.z) * cellSize / 2};
}
export function cellGrid(cells, min, max) {
  const width = max.x - min.x, depth = max.z - min.z, layer = width * depth;
  const grid = {min, max, width, depth, layer, data: new Int32Array(layer * (max.y - min.y))};
  cells.forEach((c, i) => grid.data[gridIndex(grid, c.x, c.y, c.z)] = i + 1);
  return grid;
}
export function gridIndex(g, x, y, z) {
  if (x < g.min.x || x >= g.max.x || y < g.min.y || y >= g.max.y || z < g.min.z || z >= g.max.z) return -1;
  return x - g.min.x + (z - g.min.z) * g.width + (y - g.min.y) * g.layer;
}
export function gridCell(entry, x, y, z) {
  const i = gridIndex(entry.grid, x, y, z);
  return i >= 0 ? entry.cells[entry.grid.data[i] - 1] : undefined;
}
// Deleting vertices from a previously connected six-neighbour graph can only
// create components touching the deleted boundary. Prove that those boundary
// seeds still join, and stop as soon as the last seed is reached. If they do
// not join, the full exact component extractor below remains authoritative.
export function remainsConnectedAfterCut(entry, removedIndices, scratch = {}) {
  if(!entry.connectivityKnown||removedIndices.length>=entry.cells.length)return false;
  const g=entry.grid,data=g.data;
  if(!scratch.marks||scratch.marks.length<data.length)scratch.marks=new Uint32Array(data.length);
  if(!scratch.localQueue||scratch.localQueue.length<entry.cells.length)scratch.localQueue=new Int32Array(entry.cells.length);
  // Three generation states encode removed, boundary seed and visited. This
  // avoids per-neighbour Set hashing while keeping the exact same BFS proof.
  scratch.stamp=(scratch.stamp||0)+3;if(scratch.stamp>=0xfffffffb){scratch.marks.fill(0);scratch.stamp=3;}
  const marks=scratch.marks,stamp=scratch.stamp,seedStamp=stamp+1,visitedStamp=stamp+2,queue=scratch.localQueue;
  let seeds=0,first=-1;
  for(const i of removedIndices)marks[i]=stamp;
  const neighbors=(i,visit)=>{const x=i%g.width,z=Math.floor(i/g.width)%g.depth;
    if(x>0)visit(i-1);if(x+1<g.width)visit(i+1);if(z>0)visit(i-g.width);if(z+1<g.depth)visit(i+g.width);
    if(i>=g.layer)visit(i-g.layer);if(i+g.layer<data.length)visit(i+g.layer);};
  const seed=n=>{if(data[n]&&marks[n]!==stamp&&marks[n]!==seedStamp){marks[n]=seedStamp;seeds++;if(first<0)first=n;}};
  for(const i of removedIndices)neighbors(i,seed);
  if(seeds<2){scratch.visited=0;return true;}
  seeds--;queue[0]=first;marks[first]=visitedStamp;
  let read=0,write=1;
  const visit=n=>{if(data[n]&&marks[n]!==stamp&&marks[n]!==visitedStamp){if(marks[n]===seedStamp)seeds--;marks[n]=visitedStamp;queue[write++]=n;}};
  while(read<write&&seeds)neighbors(queue[read++],visit);
  scratch.visited=read;return seeds===0;
}
// Six-neighbor connectivity uses a bounded dense lookup, never a search of the
// whole map. Original voxel coordinates remain stable after the body rotates.
export function connectedRemainder(entry, removedIndices, scratch = {}) {
  const g = entry.grid, data = g.data, groups = [];
  if(!scratch.seen || scratch.seen.length<data.length)scratch.seen=new Uint8Array(data.length);
  if(!scratch.queue || scratch.queue.length<entry.cells.length)scratch.queue=new Int32Array(entry.cells.length);
  const seen=scratch.seen,queue=scratch.queue;seen.fill(0,0,data.length);
  // Mark removed cells in traversal scratch. Never clone or mutate the source
  // lookup before all replacement colliders have been admitted successfully.
  for (const i of removedIndices) if(i>=0&&i<data.length)seen[i] = 1;
  for (const cell of entry.cells) {
    const start=gridIndex(g,cell.x,cell.y,cell.z);
    if (!data[start] || seen[start]) continue;
    const group = [],min={x:Infinity,y:Infinity,z:Infinity},max={x:-Infinity,y:-Infinity,z:-Infinity}; let read = 0, write = 1;
    queue[0] = start; seen[start] = 1;
    const visit=n=>{if(n>=0&&n<data.length&&data[n]&&!seen[n]){queue[write++]=n;seen[n]=1;}};
    while (read < write) {
      const i = queue[read++], id = data[i];
      const c=entry.cells[id - 1];group.push(c);
      if(c.x<min.x)min.x=c.x;if(c.y<min.y)min.y=c.y;if(c.z<min.z)min.z=c.z;
      if(c.x+1>max.x)max.x=c.x+1;if(c.y+1>max.y)max.y=c.y+1;if(c.z+1>max.z)max.z=c.z+1;
      const x = i % g.width, z = Math.floor(i / g.width) % g.depth;
      if(x>0)visit(i-1);if(x+1<g.width)visit(i+1);
      if(z>0)visit(i-g.width);if(z+1<g.depth)visit(i+g.width);
      visit(i-g.layer);visit(i+g.layer);
    }
    Object.defineProperty(group,'boundingVolume',{value:(max.x-min.x)*(max.y-min.y)*(max.z-min.z)});groups.push(group);
  }
  return groups.sort((a, b) => b.length - a.length);
}
