import {MATERIAL_KEYS} from '../../voxel-world.js';
import {fragmentGeometry,fragmentChunks,fragmentChunkGeometry} from './fragment-geometry.js';
import {buildVoxelPaletteFragment} from './voxel-palette-view.js';
import {styleVoxelGeometry} from '../../voxel-material.js';
import {transferFragmentGeometry} from './fragment-transfer.js';
import {batchFragmentMaterials} from './fragment-material-batches.js';
self.onmessage=({data:{id,packed,center,cellSize,palette}})=>{
  try{
    const start=performance.now(),cells=[];
    for(let i=0;i<packed.length;i+=6)cells.push({x:packed[i],y:packed[i+1],z:packed[i+2],mat:MATERIAL_KEYS[packed[i+3]],...(packed[i+4]?{paletteIndex:packed[i+4]}:{}),...(packed[i+5]?{sourceShape:packed[i+5]}:{})});
    if(!palette&&cells.length>=2048){
      const chunks=fragmentChunks(cells),result={chunks:[]},buffers=[];
      for(const c of chunks.values()){const g=styleVoxelGeometry(fragmentChunkGeometry(chunks,c,center,cellSize),{cell:cellSize}),geometry=transferFragmentGeometry(g);
        result.chunks.push({...c,sourceShapes:[...c.sourceShapes],geometry});buffers.push(c.data.buffer,...Object.values(geometry.attributes).map(a=>a.array.buffer),geometry.index.buffer);g.dispose();}
      self.postMessage({id,geometry:result,workerMs:performance.now()-start},[...new Set(buffers)]);return;
    }
    const geometry=styleVoxelGeometry(batchFragmentMaterials(palette?buildVoxelPaletteFragment(cells,center,cellSize,palette):fragmentGeometry(cells,center,cellSize),palette),{cell:cellSize});
    const result=transferFragmentGeometry(geometry),buffers=[...new Set([...Object.values(result.attributes).map(a=>a.array.buffer),result.index?.buffer].filter(Boolean))];
    self.postMessage({id,geometry:result,workerMs:performance.now()-start},buffers);geometry.dispose();
  }catch(error){self.postMessage({id,error:error.message});}
};
