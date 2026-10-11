# Project renderer modification

`three.module.js` includes a local correction in `WebGLBindingStates`.
WebGL generic vertex attribute values are context state, not vertex array
object state. Reusing a cached VAO now restores the current material's
defaults for attributes without a geometry or instance buffer. The list of
missing attributes is cached with the binding, so this does not rebuild or
upload vertex buffers on every draw.

The correction also reads current default values when a material changes or
its defaults are edited. Explicit geometry and instance attributes retain
their original buffer bindings. No textures, palettes, LUTs or shaders are
replaced. The original Three.js MIT license is preserved in THREE-LICENSE.txt.

Validation: a screenshot A/B in the original project. Before
the correction, first switching to tools 2 and 4 changed 128 world pixels
while geometry and camera matrices were unchanged. Reapplying the generic
values in a diagnostic A/B restored identical geometry and albedo through
the same eleven tool switches.
