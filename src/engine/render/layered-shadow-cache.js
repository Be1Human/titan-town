import {NearestFilter, VSMShadowMap, WebGLRenderTarget} from '../../../vendor/three.module.js';

const allLayers = {test: () => true};

function overlayRoots(dynamic) {
  const set = new Set(dynamic), roots = [];
  for (const object of dynamic) {
    let parent = object.parent, nested = false;
    while (parent) { if (set.has(parent)) { nested = true; break; } parent = parent.parent; }
    if (!nested) roots.push(object);
  }
  return roots;
}

/** Splits WebGLShadowMap work into a cached static layer and a dynamic overlay.
 * The plan comes from ShadowDirtyTracker({layered:true}) for the same frame.
 * Static frames render every caster except the dynamic set, then copy colour
 * (packed depth) and depth buffer to a cache target. Other frames copy the
 * cache back and draw only the dynamic set over it. Packed depth is a min over
 * casters, so the result equals a full redraw regardless of draw order.
 * VSM, auto-updating maps, missing plans and replaced maps use the stock path.
 */
export class LayeredShadowCache {
  constructor(renderer) {
    this.renderer = renderer; this.entries = new Map(); this.plan = null; this.enabled = true;
    this.stats = {mode: 'idle', dynamic: 0, roots: 0, staticRenders: 0, cachedRenders: 0, fullRenders: 0, copies: 0};
  }
  install() {
    const shadowMap = this.renderer.shadowMap, original = shadowMap.render, cache = this;
    shadowMap.render = function(lights, scene, camera) { return cache.render(original, this, lights, scene, camera); };
    this.uninstall = () => { shadowMap.render = original; this.uninstall = null; };
    return this;
  }
  /** A plan left unconsumed (no shadow render happened) keeps its static request. */
  setPlan(plan) {
    if (plan && this.plan?.static) plan = {...plan, static: true};
    this.plan = plan || null;
  }
  invalidate() { for (const entry of this.entries.values()) entry.filled = false; }
  render(original, shadowMap, lights, scene, camera) {
    // Passes that run with shadow updates suppressed must not consume this frame's plan.
    if (!shadowMap.enabled || !shadowMap.autoUpdate && !shadowMap.needsUpdate || !lights.length) return original.call(shadowMap, lights, scene, camera);
    const plan = this.plan; this.plan = null;
    const gl = this.renderer.getContext();
    const managed = lights.every(light => light.shadow && (light.shadow.autoUpdate || light.shadow.needsUpdate));
    if (!plan || !this.enabled || !managed || shadowMap.autoUpdate || shadowMap.type === VSMShadowMap || typeof gl.blitFramebuffer !== 'function') {
      this.invalidate(); this.stats.mode = 'full'; this.stats.fullRenders++;
      return original.call(shadowMap, lights, scene, camera);
    }
    const reuse = !plan.static && lights.every(light => this.valid(light));
    const lightUpdates = lights.map(light => light.shadow.needsUpdate);
    if (!reuse) {
      const hidden = [];
      try {
        for (const object of plan.dynamic) if (object.castShadow) { object.castShadow = false; hidden.push(object); }
        original.call(shadowMap, lights, scene, camera);
      } finally { for (const object of hidden) object.castShadow = true; }
      for (const light of lights) this.store(light);
      this.stats.mode = 'static'; this.stats.staticRenders++;
    } else {
      for (const light of lights) this.copy(this.entries.get(light).target, light.shadow.map);
      this.stats.mode = 'cached'; this.stats.cachedRenders++;
    }
    const roots = overlayRoots(plan.dynamic);
    this.stats.dynamic = plan.dynamic.length; this.stats.roots = roots.length;
    if (!roots.length) { shadowMap.needsUpdate = false; for (const light of lights) light.shadow.needsUpdate = false; return; }
    const renderer = this.renderer, clear = renderer.clear;
    try {
      renderer.clear = () => {};
      shadowMap.needsUpdate = true;
      lights.forEach((light, i) => { light.shadow.needsUpdate = lightUpdates[i]; });
      original.call(shadowMap, lights, {visible: true, layers: allLayers, children: roots}, camera);
    } finally { renderer.clear = clear; shadowMap.needsUpdate = false; }
  }
  valid(light) {
    const entry = this.entries.get(light), map = light.shadow?.map;
    return !!(entry?.filled && map && entry.map === map && entry.target.width === map.width && entry.target.height === map.height);
  }
  store(light) {
    const map = light.shadow.map; if (!map) return;
    let entry = this.entries.get(light);
    if (!entry || entry.map !== map || entry.target.width !== map.width || entry.target.height !== map.height) {
      entry?.target.dispose();
      const target = new WebGLRenderTarget(map.width, map.height, {minFilter: NearestFilter, magFilter: NearestFilter, type: map.texture.type,
        format: map.texture.format, depthBuffer: map.depthBuffer, stencilBuffer: map.stencilBuffer});
      target.texture.name = (map.texture.name || 'shadow') + '.staticCache';
      this.entries.set(light, entry = {map, target, filled: false});
    }
    this.copy(map, entry.target); entry.filled = true;
  }
  copy(source, destination) {
    const renderer = this.renderer, gl = renderer.getContext(), state = renderer.state;
    const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
    try {
      renderer.setRenderTarget(destination);
      const from = renderer.properties.get(source).__webglFramebuffer, to = renderer.properties.get(destination).__webglFramebuffer;
      state.bindFramebuffer(gl.READ_FRAMEBUFFER, from); state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
      state.setScissorTest(false);
      let mask = gl.COLOR_BUFFER_BIT; if (source.depthBuffer && destination.depthBuffer) mask |= gl.DEPTH_BUFFER_BIT;
      gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, destination.width, destination.height, mask, gl.NEAREST);
      this.stats.copies++;
    } finally { state.bindFramebuffer(gl.READ_FRAMEBUFFER, null); renderer.setRenderTarget(previous, face, level); }
  }
  dispose() { this.uninstall?.(); for (const entry of this.entries.values()) entry.target.dispose(); this.entries.clear(); }
}
