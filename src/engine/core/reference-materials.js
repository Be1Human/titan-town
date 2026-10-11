// Independently implemented material configuration from the verified
// research table. These are reference coefficients, not SI strength values.
const types = {
  none: [3, 0, 1], glass: [0, .2, 1.5], wood: [0, 1, .8],
  masonry: [1, 2, 2], plaster: [0, 1, 2], metal: [1, 3, 3],
  heavymetal: [3, 0, 3], rock: [3, 0, 3], dirt: [0, 3, 1.5],
  foliage: [0, .2, .7], plastic: [0, .6, .7], hardmetal: [2, 0, 3],
  hardmasonry: [2, 0, 2], ice: [0, .5, .8], unphysical: [0, 0, 1]
};
export const REFERENCE_MATERIALS = Object.freeze(Object.fromEntries(Object.entries(types).map(([name, [holeCategory, contactCoefficient, densityCoefficient]]) =>
  [name, Object.freeze({name, holeCategory, contactCoefficient, densityCoefficient, physical: name !== 'unphysical'})])));

// The project's thirteen visual/gameplay IDs stay stable. Sandstone is mapped
// to breakable masonry; it is not the reference indestructible rock material.
export const PHYSICAL_MATERIAL_TYPES = Object.freeze({
  plaster: 'plaster', stone: 'masonry', brick: 'masonry', concrete: 'hardmasonry',
  wood: 'wood', darkwood: 'wood', roof: 'masonry', metal: 'metal',
  rust: 'metal', dark: 'heavymetal', glass: 'glass', leaf: 'foliage', fuel: 'metal'
});

export function physicalTypeForMaterial(material) {
  return PHYSICAL_MATERIAL_TYPES[material] || (REFERENCE_MATERIALS[material] ? material : 'masonry');
}
export function referenceMaterialFor(material) { return REFERENCE_MATERIALS[physicalTypeForMaterial(material)]; }

// radii is [soft, medium, hard]. Category 3 is excluded from this cut branch.
export function makeHoleRadiusForMaterial(material, radii) {
  const category = referenceMaterialFor(material).holeCategory;
  if (category === 3 || !Array.isArray(radii)) return 0;
  return Number.isFinite(radii[category]) ? Math.max(0, radii[category]) : 0;
}

export function contactBreakageCap(material, strength = 1) {
  const coefficient = referenceMaterialFor(material).contactCoefficient;
  return coefficient > 0 ? coefficient * 1200 * Math.max(0, strength) : Infinity;
}
