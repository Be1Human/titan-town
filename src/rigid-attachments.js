import {CELL} from './voxel-world.js';
import {gridCell, rotateVector} from './rigid-fracture.js';

// Anchors refer to original voxel coordinates, so cutting a rotated body can
// transfer a charge to the correct child without changing its world pose.
export function rebindRigidAttachment(charge, change, entries) {
  if (charge.rigidId !== change.oldId || !Array.isArray(charge.localPoint)) return undefined;
  const local = {x: charge.localPoint[0], y: charge.localPoint[1], z: charge.localPoint[2]};
  const rotated = rotateVector(local, change.oldRotation);
  const position = {x: change.oldPosition.x + rotated.x, y: change.oldPosition.y + rotated.y, z: change.oldPosition.z + rotated.z};
  let anchor = charge.rigidAnchorCell, owner;
  if (anchor) {
    owner = change.newIds.map(id => entries.get(id)).find(entry => entry && gridCell(entry, anchor.x, anchor.y, anchor.z));
  } else {
    // Legacy saves have no exact anchor. Only consider cells immediately
    // below the old mounting point, rather than attaching to a distant piece.
    const source = {x: change.oldCenter.x + local.x, y: change.oldCenter.y + local.y, z: change.oldCenter.z + local.z};
    let nearest = .23 ** 2;
    for (const id of change.newIds) {
      const entry = entries.get(id); if (!entry) continue;
      const cellSize = entry.cellSize || CELL;
      for (const c of entry.cells) {
        const d = ((c.x + .5) * cellSize - source.x) ** 2 + ((c.y + .5) * cellSize - source.y) ** 2 + ((c.z + .5) * cellSize - source.z) ** 2;
        if (d < nearest) { nearest = d; anchor = c; owner = entry; }
      }
    }
  }
  if (!owner) return {detached: true, position, rotation: change.oldRotation};
  // The child retains the old orientation. The origin shift is in source axes.
  return {rigidId: owner.id, localPoint: [local.x + change.oldCenter.x - owner.center.x, local.y + change.oldCenter.y - owner.center.y, local.z + change.oldCenter.z - owner.center.z],
    rigidAnchorCell: {x: anchor.x, y: anchor.y, z: anchor.z}, position, rotation: owner.rotation};
}
