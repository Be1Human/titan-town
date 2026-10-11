// A small, bounded collision model for cosmetic voxel fragments. The samples
// retain the fragment's shape without turning every removed voxel into a body.
const EPSILON = 1e-4;
const MAX_SAMPLES = 30;
// With two fast axes, a long frame needs extra slices to catch a diagonal
// crossing of a single isolated voxel. Straight impacts use the cheaper
// swept-axis test below.
const MAX_STEPS = 48;
const TOPPLE_ANGLE = Math.PI / 2;

export function debrisSamples(cells, center, cellSize, limit = MAX_SAMPLES) {
  if (!cells.length) return [];
  const extrema = [cells[0], cells[0], cells[0], cells[0], cells[0], cells[0]];
  let lowestY = cells[0].y;
  for (const cell of cells) {
    if (cell.x < extrema[0].x) extrema[0] = cell;
    if (cell.x > extrema[1].x) extrema[1] = cell;
    if (cell.y < extrema[2].y) extrema[2] = cell;
    if (cell.y > extrema[3].y) extrema[3] = cell;
    if (cell.z < extrema[4].z) extrema[4] = cell;
    if (cell.z > extrema[5].z) extrema[5] = cell;
    lowestY = Math.min(lowestY, cell.y);
  }
  // Include the spread of the lowest layer so long fragments settle on the
  // actual surface beneath them instead of sinking through between samples.
  const bottom = [null, null, null, null];
  for (const cell of cells) {
    if (cell.y !== lowestY) continue;
    if (!bottom[0] || cell.x < bottom[0].x) bottom[0] = cell;
    if (!bottom[1] || cell.x > bottom[1].x) bottom[1] = cell;
    if (!bottom[2] || cell.z < bottom[2].z) bottom[2] = cell;
    if (!bottom[3] || cell.z > bottom[3].z) bottom[3] = cell;
  }
  const chosen = [], seen = new Set();
  const add = cell => {
    if (!cell || chosen.length >= limit) return;
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (seen.has(key)) return;
    seen.add(key);
    chosen.push({x: (cell.x + .5) * cellSize - center.x,
      y: (cell.y + .5) * cellSize - center.y,
      z: (cell.z + .5) * cellSize - center.z});
  };
  for (const cell of [...extrema, ...bottom]) add(cell);
  // A wide fragment can have support below an interior bottom voxel. Give the
  // bottom footprint priority over upper voxels in the bounded sample budget.
  const bottomCells = cells.filter(cell => cell.y === lowestY);
  const bottomSlots = Math.max(1, limit - chosen.length);
  const bottomStride = Math.max(1, Math.ceil(bottomCells.length / bottomSlots));
  for (let i = 0; i < bottomCells.length && chosen.length < limit; i += bottomStride) add(bottomCells[i]);
  const stride = Math.max(1, Math.ceil(cells.length / Math.max(1, limit - chosen.length)));
  for (let i = 0; i < cells.length && chosen.length < limit; i += stride) add(cells[i]);
  return chosen;
}

export function debrisTopplePlan(bounds, center, cellSize, failure = null, origin = null, count = 0) {
  const width = (bounds.maxX - bounds.minX) * cellSize;
  const height = (bounds.maxY - bounds.minY) * cellSize;
  const depth = (bounds.maxZ - bounds.minZ) * cellSize;
  if (count < 12 || height < .8 || height < Math.min(width, depth) * 1.35) return null;
  const requestedX=Number(failure?.direction?.x),requestedZ=Number(failure?.direction?.z);
  let dx = Number.isFinite(requestedX) ? requestedX : 0;
  let dz = Number.isFinite(requestedZ) ? requestedZ : 0;
  const requested = Math.hypot(dx, dz);
  const footprintRatio=Math.max(width,depth)/Math.max(cellSize,Math.min(width,depth));
  const thinAxis = footprintRatio>1.5 ? width<=depth ? 'x' : 'z' : null;
  if (thinAxis || requested <= .01) {
    // A long wall should fall across its thickness. A structural centroid can
    // otherwise point along the length and make the wall roll sideways.
    const axis = thinAxis || (width <= depth ? 'x' : 'z');
    const preferred=axis==='x'?dx:dz;
    const gap = origin ? center[axis] - origin[axis] : 0;
    const hash = (bounds.minX * 17 + bounds.minZ * 31 + bounds.minY * 7) & 1;
    const sign = Math.abs(preferred)>.05 ? Math.sign(preferred) : Math.abs(gap) > cellSize ? Math.sign(gap) : hash ? 1 : -1;
    dx = axis === 'x' ? sign : 0;
    dz = axis === 'z' ? sign : 0;
  }
  else { dx /= requested; dz /= requested; }
  const hint = failure?.pivot;
  const pivot = {
    x: dx > .01 ? bounds.maxX * cellSize : dx < -.01 ? bounds.minX * cellSize : Number.isFinite(hint?.x) ? Math.max(bounds.minX*cellSize,Math.min(bounds.maxX*cellSize,hint.x)) : center.x,
    y: bounds.minY * cellSize,
    z: dz > .01 ? bounds.maxZ * cellSize : dz < -.01 ? bounds.minZ * cellSize : Number.isFinite(hint?.z) ? Math.max(bounds.minZ*cellSize,Math.min(bounds.maxZ*cellSize,hint.z)) : center.z
  };
  return {bounds:{...bounds},pivot,localArm:{x:center.x-pivot.x,y:center.y-pivot.y,z:center.z-pivot.z},direction:{x:dx,z:dz},axis:{x:dz,z:-dx},angle:0,angularVelocity:.42,pivotVy:0,slide:false,slideDistance:0,blockedSlides:0,flipTried:false,state:'tilting',impactEmitted:false};
}

function rotateTopple(vector, topple, angle) {
  const {x:ax,z:az} = topple.axis, c=Math.cos(angle), s=Math.sin(angle), t=1-c;
  return {
    x:(c+ax*ax*t)*vector.x-az*s*vector.y+ax*az*t*vector.z,
    y:az*s*vector.x+c*vector.y-ax*s*vector.z,
    z:ax*az*t*vector.x+ax*s*vector.y+(c+az*az*t)*vector.z
  };
}

function setTopplePose(body, angle) {
  const topple = body.topple;
  const rotated = rotateTopple(topple.localArm,topple,angle);
  topple.angle = angle;
  body.position.x = topple.pivot.x + rotated.x;
  body.position.y = topple.pivot.y + rotated.y;
  body.position.z = topple.pivot.z + rotated.z;
}

function collisionShape(body, cellSize) {
  const half = cellSize * .5;
  if (body.topple) {
    const {axis,angle} = body.topple, ax=axis.x, az=axis.z;
    const c=Math.cos(angle), s=Math.sin(angle), t=1-c;
    const extents = {
      x:half*(Math.abs(c+ax*ax*t)+Math.abs(az*s)+Math.abs(ax*az*t)),
      y:half*(Math.abs(az*s)+Math.abs(c)+Math.abs(ax*s)),
      z:half*(Math.abs(ax*az*t)+Math.abs(ax*s)+Math.abs(c+az*az*t))
    };
    return {samples:body.samples.map(sample=>rotateTopple(sample,body.topple,angle)),half:extents};
  }
  const ax = body.angleX || 0, az = body.angleZ || 0;
  if (!ax && !az) return {samples:body.samples,half:{x:half,y:half,z:half}};
  const cx = Math.cos(ax), sx = Math.sin(ax), cz = Math.cos(az), sz = Math.sin(az);
  const spread = Math.abs(cz) + Math.abs(sz);
  const extents = {x:half*spread,y:half*(Math.abs(cx)*spread+Math.abs(sx)),z:half*(Math.abs(sx)*spread+Math.abs(cx))};
  const samples = body.samples.map(sample => {
    const y = sz*sample.x + cz*sample.y;
    return {x:cz*sample.x-sz*sample.y,y:cx*y-sx*sample.z,z:sx*y+cx*sample.z};
  });
  return {samples,half:extents};
}

// Sweep each sampled cell's leading face through every crossed voxel, so a
// fast blast cannot jump over a one-cell floor even with a long update step.
// Axis-separated movement lets a fragment slide along a wall after impact.
function moveAxis(body, world, axis, delta, cellSize, shape) {
  if (!delta) return false;
  const start = body.position[axis], candidate = start + delta;
  const positive = delta > 0, step = positive ? 1 : -1;
  let allowed = candidate, hit = false;
  for (const sample of shape.samples) {
    const leading = start + sample[axis] + (positive ? 1 : -1)*(shape.half[axis]-EPSILON);
    const bias = positive ? 0 : -EPSILON;
    const first = Math.floor((leading+bias)/cellSize),last = Math.floor((leading+delta+bias)/cellSize);
    const ranges = {};
    for (const other of ['x','y','z']) if (other !== axis) {
      const center = body.position[other]+sample[other],radius = shape.half[other]-EPSILON;
      ranges[other] = [Math.floor((center-radius)/cellSize),Math.floor((center+radius)/cellSize)];
    }
    for (let coordinate = first; positive ? coordinate <= last : coordinate >= last; coordinate += step) {
      const xs = axis === 'x' ? [coordinate,coordinate] : ranges.x;
      const ys = axis === 'y' ? [coordinate,coordinate] : ranges.y;
      const zs = axis === 'z' ? [coordinate,coordinate] : ranges.z;
      let blocked = false;
      for (let x = xs[0]; x <= xs[1] && !blocked; x++) for (let y = ys[0]; y <= ys[1] && !blocked; y++) for (let z = zs[0]; z <= zs[1]; z++) {
        if (world.getId(x,y,z)) {blocked = true;break;}
      }
      if (!blocked) continue;
      const contact = (positive ? coordinate : coordinate + 1) * cellSize - sample[axis] + (positive ? -shape.half[axis] : shape.half[axis]);
      allowed = positive ? Math.min(allowed,contact) : Math.max(allowed,contact);
      hit = true;
      break;
    }
  }
  if (axis === 'y' && !positive) {
    let floor = body.topple ? -Infinity : body.halfY;
    for (const sample of shape.samples) floor = Math.max(floor,shape.half.y-sample.y);
    if (allowed < floor) {allowed = floor;hit = true;}
  }
  body.position[axis] = allowed;
  return hit;
}

function overlapsStatic(body, world, cellSize, shape, drop = 0) {
  for (const sample of shape.samples) {
    const x=body.position.x+sample.x,y=body.position.y+sample.y-drop,z=body.position.z+sample.z;
    const x0=Math.floor((x-shape.half.x+EPSILON)/cellSize),x1=Math.floor((x+shape.half.x-EPSILON)/cellSize);
    const y0=Math.floor((y-shape.half.y+EPSILON)/cellSize),y1=Math.floor((y+shape.half.y-EPSILON)/cellSize);
    const z0=Math.floor((z-shape.half.z+EPSILON)/cellSize),z1=Math.floor((z+shape.half.z-EPSILON)/cellSize);
    if (y-shape.half.y < -EPSILON) return {blocked:true,ground:true,ceiling:false};
    for (let ix=x0;ix<=x1;ix++) for(let iy=y0;iy<=y1;iy++) for(let iz=z0;iz<=z1;iz++) {
      if (world.getId(ix,iy,iz)) return {
        blocked:true,
        ground:y-shape.half.y >= (iy+1)*cellSize-cellSize*.5,
        ceiling:y < iy*cellSize && y+shape.half.y > iy*cellSize
      };
    }
  }
  return {blocked:false,ground:false,ceiling:false};
}

function toppleImpact(body, speed, cellSize) {
  if (body.topple.impactEmitted || speed < 1.1) return null;
  body.topple.impactEmitted = true;
  const shape=collisionShape(body,cellSize);
  let point={x:body.position.x,y:body.position.y,z:body.position.z};
  for(const sample of shape.samples) {
    const y=body.position.y+sample.y-shape.half.y;
    if(y<point.y)point={x:body.position.x+sample.x,y,z:body.position.z+sample.z};
  }
  return {...point,y:Math.max(0,point.y),speed};
}

function tryOppositeTopple(body,cellSize) {
  const topple=body.topple;
  if(topple.flipTried || topple.slideDistance>.001) return false;
  topple.flipTried=true;
  const saved={direction:topple.direction,pivot:topple.pivot};
  setTopplePose(body,0);
  const upright={...body.position};
  const direction={x:-saved.direction.x,z:-saved.direction.z};
  const bounds=topple.bounds;
  const pivot={
    x:direction.x>.01?bounds.maxX*cellSize:direction.x<-.01?bounds.minX*cellSize:saved.pivot.x,
    y:saved.pivot.y,
    z:direction.z>.01?bounds.maxZ*cellSize:direction.z<-.01?bounds.minZ*cellSize:saved.pivot.z
  };
  topple.direction=direction;
  topple.axis={x:direction.z,z:-direction.x};
  topple.pivot=pivot;
  topple.localArm={x:upright.x-pivot.x,y:upright.y-pivot.y,z:upright.z-pivot.z};
  // Keep the original occupied cells in place; the next fixed step tests the
  // opposite rotation against the full static field. It may hit an eave and
  // slide, or stop if the other side is genuinely walled off.
  setTopplePose(body,0);
  return true;
}

function stepTopple(body, world, dt, cellSize) {
  const topple=body.topple;
  if(topple.slide && topple.slideDistance<1.5 && topple.blockedSlides<8) {
    const shape=collisionShape(body,cellSize),distance=Math.min(.8*dt,1.5-topple.slideDistance);
    const beforeX=body.position.x,beforeZ=body.position.z;
    moveAxis(body,world,'x',topple.direction.x*distance,cellSize,shape);
    moveAxis(body,world,'z',topple.direction.z*distance,cellSize,shape);
    const movedX=body.position.x-beforeX,movedZ=body.position.z-beforeZ;
    topple.pivot.x+=movedX;
    topple.pivot.z+=movedZ;
    const moved=Math.hypot(movedX,movedZ);
    topple.slideDistance+=moved;
    topple.blockedSlides=moved<distance*.2?topple.blockedSlides+1:0;
  }
  // The hinge belongs to the detached body, not the world. Move the entire
  // rotated shape under gravity unless the floor or remaining voxels hold it.
  topple.pivotVy=Math.max(-30,topple.pivotVy-14*dt);
  const beforeY=body.position.y,fallSpeed=-topple.pivotVy;
  const landed=moveAxis(body,world,'y',topple.pivotVy*dt,cellSize,collisionShape(body,cellSize));
  topple.pivot.y+=body.position.y-beforeY;
  let impact=landed?toppleImpact(body,fallSpeed,cellSize):null;
  if(landed)topple.pivotVy=0;
  topple.angularVelocity=Math.min(4.5,topple.angularVelocity+(2.6+3.8*Math.sin(topple.angle))*dt);
  const target=Math.min(TOPPLE_ANGLE,topple.angle+topple.angularVelocity*dt);
  const steps=Math.min(MAX_STEPS,Math.max(1,Math.ceil((target-topple.angle)/.045)));
  for(let i=0;i<steps;i++) {
    const from=topple.angle,to=Math.min(target,from+(target-from)/(steps-i));
    setTopplePose(body,to);
    const collision=overlapsStatic(body,world,cellSize,collisionShape(body,cellSize));
    if(collision.blocked) {
      let low=from,high=to;
      for(let j=0;j<6;j++) {
        const mid=(low+high)*.5;
        setTopplePose(body,mid);
        if(overlapsStatic(body,world,cellSize,collisionShape(body,cellSize)).blocked)high=mid;
        else low=mid;
      }
      setTopplePose(body,low);
      if(collision.ceiling && low<.65 && topple.slideDistance<1.5 && topple.blockedSlides<8) {
        topple.slide=true;
        return impact;
      }
      if(!collision.ceiling && low<.02 && tryOppositeTopple(body,cellSize))return impact;
      topple.state='fallen';
      body.vx=topple.direction.x*Math.min(1,topple.angularVelocity*.25);
      body.vz=topple.direction.z*Math.min(1,topple.angularVelocity*.25);
      body.vy=topple.pivotVy;
      return impact || (collision.ground ? toppleImpact(body,topple.angularVelocity,cellSize) : null);
    }
  }
  if(topple.angle>.12)topple.slide=false;
  if(topple.angle >= TOPPLE_ANGLE-1e-6) {
    topple.state='fallen';
    body.vx=topple.direction.x*Math.min(1,topple.angularVelocity*.25);
    body.vz=topple.direction.z*Math.min(1,topple.angularVelocity*.25);
    body.vy=topple.pivotVy;
    if(overlapsStatic(body,world,cellSize,collisionShape(body,cellSize),cellSize*.08).blocked) {
      body.vx=body.vz=body.vy=0;
      body.rest=true;
      body.restRevision=world.revision;
      return impact || toppleImpact(body,topple.angularVelocity,cellSize);
    }
  }
  return impact;
}

export function stepDebris(body, world, dt, cellSize) {
  if (dt <= 0) return null;
  if (body.rest) {
    if (body.restRevision === world.revision) return null;
    body.restRevision = world.revision;
    // A later explosion may remove the support under a settled fragment.
    if (moveAxis(body, world, 'y', -cellSize * .08, cellSize,collisionShape(body,cellSize))) return null;
    body.rest = false;
    body.vy = 0;
  }
  if (body.topple?.state === 'tilting') return stepTopple(body,world,dt,cellSize);
  if (body.spin) {
    body.angleX = (body.angleX || 0) + body.spin*dt;
    body.angleZ = (body.angleZ || 0) + body.spin*.8*dt;
  }
  const shape = collisionShape(body,cellSize);
  body.vy = Math.max(-30, body.vy - 14 * dt);
  const ax = Math.abs(body.vx), ay = Math.abs(body.vy), az = Math.abs(body.vz);
  const speed = Math.max(ax, ay, az);
  const secondSpeed = Math.max(Math.min(ax, ay), Math.min(Math.max(ax, ay), az));
  const baseSteps = Math.min(8, Math.max(1, Math.ceil(speed * dt / (cellSize * .75))));
  const diagonalSteps = Math.min(MAX_STEPS, Math.ceil(secondSpeed * dt / (cellSize * .75)));
  const steps = Math.max(baseSteps, diagonalSteps);
  const slice = dt / steps;
  let impactEvent=null;
  for (let i = 0; i < steps; i++) {
    if (moveAxis(body, world, 'x', body.vx * slice, cellSize,shape)) {
      body.vx = Math.abs(body.vx) > .8 ? -body.vx * .12 : 0;
      body.vz *= .85;
    }
    if (moveAxis(body, world, 'z', body.vz * slice, cellSize,shape)) {
      body.vz = Math.abs(body.vz) > .8 ? -body.vz * .12 : 0;
      body.vx *= .85;
    }
    const falling = body.vy < 0;
    if (moveAxis(body, world, 'y', body.vy * slice, cellSize,shape)) {
      if (falling) {
        const impact = -body.vy;
        if (body.topple) impactEvent ||= toppleImpact(body,impact,cellSize);
        body.vy = impact > .9 ? impact * .12 : 0;
        body.vx *= .55;
        body.vz *= .55;
        if (impact <= .9 && Math.hypot(body.vx, body.vz) < .16) {
          body.vx = body.vz = 0;
          body.rest = true;
          body.restRevision = world.revision;
          break;
        }
      } else body.vy = -body.vy * .08;
    }
    const drag = Math.exp(-.8 * slice);
    body.vx *= drag;
    body.vz *= drag;
  }
  return impactEvent;
}
