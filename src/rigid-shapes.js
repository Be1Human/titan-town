// Exact greedy boxes: only occupied cells are merged, so holes remain holes.
// The output uses voxel coordinates; no renderer or physics runtime is needed.
export function mergeVoxelBoxes(source, width, height, depth, limit = Infinity) {
  return mergeOwnedVoxelBoxes(Uint8Array.from(source),width,height,depth,limit);
}

// Ownership stays private: public callers retain their voxel buffer. Cooking
// already owns its occupancy scratch, so copying it again is unnecessary.
function mergeOwnedVoxelBoxes(data, width, height, depth, limit) {
  const boxes = [], layer = width * depth;
  for (let start=0;start<width*height*depth;start++) {
    if (!data[start]) continue;
    if (boxes.length >= limit) return null;
    const x=start%width,y=Math.floor(start/layer),z=Math.floor((start-y*layer)/width);
    let w = 1, d = 1, h = 1;
    while (x + w < width && data[start + w]) w++;
    depthLoop: while (z + d < depth) {
      for (let a = 0; a < w; a++) if (!data[start + a + d * width]) break depthLoop;
      d++;
    }
    heightLoop: while (y + h < height) {
      for (let b = 0; b < d; b++) for (let a = 0; a < w; a++) {
        if (!data[start + a + b * width + h * layer]) break heightLoop;
      }
      h++;
    }
    for (let b = 0; b < h; b++) for (let c = 0; c < d; c++) {
      data.fill(0, start + c * width + b * layer, start + c * width + b * layer + w);
    }
    boxes.push({x, y, z, w, h, d});
  }
  return boxes;
}

export function shapeFromCells(cells, {maxParts = 96, maxCells = Infinity, maxVolume = Infinity, allowVoxelFallback = true} = {}) {
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > maxCells) return null;
  const min = {x: Infinity, y: Infinity, z: Infinity}, max = {x: -Infinity, y: -Infinity, z: -Infinity};
  for (const cell of cells) for (const axis of ['x', 'y', 'z']) {
    if (!Number.isSafeInteger(cell?.[axis]) || Math.abs(cell[axis]) > 8192) return null;
    min[axis] = Math.min(min[axis], cell[axis]); max[axis] = Math.max(max[axis], cell[axis] + 1);
  }
  const w = max.x - min.x, h = max.y - min.y, d = max.z - min.z;
  if (w * h * d > maxVolume) return null;
  const data = new Uint8Array(w * h * d), clean = [];
  for (const c of cells) {
    const i = c.x - min.x + (c.z - min.z) * w + (c.y - min.y) * w * d;
    if (data[i]) continue;
    if(c.paletteIndex!==undefined&&(!Number.isInteger(c.paletteIndex)||c.paletteIndex<1||c.paletteIndex>65535))return null;
    data[i] = 1; clean.push({x: c.x, y: c.y, z: c.z, mat: c.mat || 'stone',...(c.paletteIndex===undefined?{}:{paletteIndex:c.paletteIndex}),...(c.sourceShape?{sourceShape:c.sourceShape}:{})});
  }
  if (!clean.length) return null;
  const boxes = mergeOwnedVoxelBoxes(data, w, h, d, maxParts);
  if (!boxes && !allowVoxelFallback) return null;
  return {cells: clean, boxes: boxes || [], min, max, volume: w * h * d, colliderKind: boxes ? 'compound' : 'voxels', parts: boxes ? boxes.length : 1};
}

// Loading/collapse preparation owns its scratch and yields inside expensive
// scans, including the interior of one large greedy box. Public synchronous
// cooking above keeps its existing contract. The caller drives this iterator
// with a measured frame budget and never exposes its half-built shape.
export function* prepareVoxelShape(cells, {maxParts = 96, maxCells = Infinity, maxVolume = Infinity, allowVoxelFallback = true,
  batchSize = 256, validateCell, checkBounds} = {}) {
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > maxCells) return null;
  const min = {x: Infinity, y: Infinity, z: Infinity}, max = {x: -Infinity, y: -Infinity, z: -Infinity};
  let work = 0;
  const batch = Math.max(1, Math.floor(batchSize));
  for (const cell of cells) {
    if (validateCell && !validateCell(cell)) return null;
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isSafeInteger(cell?.[axis]) || Math.abs(cell[axis]) > 8192) return null;
      min[axis] = Math.min(min[axis], cell[axis]); max[axis] = Math.max(max[axis], cell[axis] + 1);
    }
    if (++work >= batch) { work = 0; yield 'bounds'; }
  }
  const w = max.x - min.x, h = max.y - min.y, d = max.z - min.z, volume = w * h * d;
  if (volume > maxVolume) return null;
  checkBounds?.(volume, cells.length);
  const data = new Uint8Array(volume), clean = [];
  for (const c of cells) {
    const i = c.x - min.x + (c.z - min.z) * w + (c.y - min.y) * w * d;
    if (!data[i]) {
      if (c.paletteIndex !== undefined && (!Number.isInteger(c.paletteIndex) || c.paletteIndex < 1 || c.paletteIndex > 65535)) return null;
      data[i] = 1; clean.push({x: c.x, y: c.y, z: c.z, mat: c.mat || 'stone', ...(c.paletteIndex === undefined ? {} : {paletteIndex: c.paletteIndex}),...(c.sourceShape?{sourceShape:c.sourceShape}:{})});
    }
    if (++work >= batch) { work = 0; yield 'occupancy'; }
  }
  if (!clean.length) return null;
  const boxes = [], layer = w * d;
  let overflow = false;
  for (let start = 0; start < volume; start++) {
    if (++work >= batch) { work = 0; yield 'boxes'; }
    if (!data[start]) continue;
    if (boxes.length >= maxParts) { overflow = true; break; }
    const x = start % w, y = Math.floor(start / layer), z = Math.floor((start - y * layer) / w);
    let bw = 1, bd = 1, bh = 1;
    while (x + bw < w && data[start + bw]) {
      bw++; if (++work >= batch) { work = 0; yield 'boxes'; }
    }
    depthLoop: while (z + bd < d) {
      for (let a = 0; a < bw; a++) {
        if (!data[start + a + bd * w]) break depthLoop;
        if (++work >= batch) { work = 0; yield 'boxes'; }
      }
      bd++;
    }
    heightLoop: while (y + bh < h) {
      for (let b = 0; b < bd; b++) for (let a = 0; a < bw; a++) {
        if (!data[start + a + b * w + bh * layer]) break heightLoop;
        if (++work >= batch) { work = 0; yield 'boxes'; }
      }
      bh++;
    }
    for (let b = 0; b < bh; b++) for (let c = 0; c < bd; c++) {
      data.fill(0, start + c * w + b * layer, start + c * w + b * layer + bw);
      if (++work >= batch) { work = 0; yield 'boxes'; }
    }
    boxes.push({x, y, z, w: bw, h: bh, d: bd});
  }
  if (overflow && !allowVoxelFallback) return null;
  return {cells: clean, boxes: overflow ? [] : boxes, min, max, volume,
    colliderKind: overflow ? 'voxels' : 'compound', parts: overflow ? 1 : boxes.length};
}
