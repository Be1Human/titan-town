// Broad-phase candidates only. Exact voxel colliders remain the authority.
// Sleeping entries retain their buckets; only moved bodies update the index.
export class BodySpatialIndex {
  constructor(size = 3.2) { this.size = size; this.buckets = new Map(); this.records = new Map(); this.large = new Set(); }
  clear() { this.buckets.clear(); this.records.clear(); this.large.clear(); }
  keys(min, max) {
    const lo = {}, hi = {}; let count = 1;
    for (const a of ['x','y','z']) { lo[a] = Math.floor(min[a] / this.size); hi[a] = Math.floor(max[a] / this.size); count *= hi[a] - lo[a] + 1; }
    if (count > 512) return null;
    const keys = [];
    for (let y=lo.y;y<=hi.y;y++) for (let z=lo.z;z<=hi.z;z++) for (let x=lo.x;x<=hi.x;x++) keys.push(`${x},${y},${z}`);
    return keys;
  }
  remove(id) {
    const record = this.records.get(id); if (!record) return;
    for (const key of record.keys || []) { const bucket = this.buckets.get(key); bucket.delete(id); if (!bucket.size) this.buckets.delete(key); }
    this.large.delete(id); this.records.delete(id);
  }
  update(entry, min, max) {
    const old = this.records.get(entry.id), keys = this.keys(min, max);
    if (old && ((keys === null && old.keys === null) || (keys && old.keys && keys.length === old.keys.length && keys.every((key,i)=>key===old.keys[i])))) {
      old.min = min; old.max = max; old.entry = entry; return;
    }
    this.remove(entry.id); this.records.set(entry.id,{entry,min,max,keys});
    if (!keys) this.large.add(entry.id);
    else for (const key of keys) { if (!this.buckets.has(key)) this.buckets.set(key,new Set()); this.buckets.get(key).add(entry.id); }
  }
  query(min, max) {
    const keys = this.keys(min,max), ids = new Set(this.large);
    if (!keys) for (const id of this.records.keys()) ids.add(id);
    else for (const key of keys) for (const id of this.buckets.get(key) || []) ids.add(id);
    const result = [];
    for (const id of ids) { const r = this.records.get(id); if (r && ['x','y','z'].every(a=>r.max[a]>=min[a] && r.min[a]<=max[a])) result.push(r.entry); }
    return result;
  }
  segment(origin, direction, distance) {
    const steps = Math.max(1,Math.ceil(Math.max(Math.abs(direction.x),Math.abs(direction.y),Math.abs(direction.z))*distance/this.size)), entries = new Map();
    for (let n=0;n<steps;n++) {
      const min={},max={};
      for (const a of ['x','y','z']) { const p=origin[a]+direction[a]*distance*n/steps,q=origin[a]+direction[a]*distance*(n+1)/steps; min[a]=Math.min(p,q)-1e-6;max[a]=Math.max(p,q)+1e-6; }
      for (const entry of this.query(min,max)) entries.set(entry.id,entry);
    }
    return [...entries.values()];
  }
}
