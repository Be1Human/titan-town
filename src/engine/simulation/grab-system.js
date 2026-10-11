import {stepGrabConstraint} from './grab-constraint.js';

export {stepGrabConstraint};

// localPoint is in the model's original source coordinates, not an offset
// from COM. The constraint changes momentum only; it never teleports a body.
export function applyGrabForce(physics,{id,localPoint,target,maxForce,stiffness,damping,maxDistance},dt){
  return stepGrabConstraint(physics,id,[{localPoint,target}],dt,{maxForce,stiffness,damping,maxDistance});
}
