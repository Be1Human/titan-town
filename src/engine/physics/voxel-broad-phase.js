// 140523660 / BroadPhaseJob 1400AD920: binary AABB traversal and qualification.
// Trees categorize static/sleeping/active objects; physical identity remains
// separate from render batching and local voxel update pages.
const overlap=(a,b)=>a.min.x<=b.max.x&&a.max.x>=b.min.x&&a.min.y<=b.max.y&&a.max.y>=b.min.y&&a.min.z<=b.max.z&&a.max.z>=b.min.z;
const union=(a,b)=>({min:{x:Math.min(a.min.x,b.min.x),y:Math.min(a.min.y,b.min.y),z:Math.min(a.min.z,b.min.z)},max:{x:Math.max(a.max.x,b.max.x),y:Math.max(a.max.y,b.max.y),z:Math.max(a.max.z,b.max.z)}});
export class VoxelAabbTree {
  constructor(objects=[]){this.rebuild(objects);}
  rebuild(objects){
    const build=list=>{
      if(!list.length)return null;if(list.length===1)return {...list[0].bounds,object:list[0]};
      let bounds=list[0].bounds;for(let i=1;i<list.length;i++)bounds=union(bounds,list[i].bounds);
      const axis=['x','y','z'].sort((a,b)=>(bounds.max[b]-bounds.min[b])-(bounds.max[a]-bounds.min[a]))[0];
      list.sort((a,b)=>(a.bounds.min[axis]+a.bounds.max[axis])-(b.bounds.min[axis]+b.bounds.max[axis]));
      const middle=list.length>>1;return {...bounds,left:build(list.slice(0,middle)),right:build(list.slice(middle))};
    };
    this.root=build([...objects]);this.size=objects.length;return this;
  }
  query(bounds,visit){const stack=this.root?[this.root]:[];while(stack.length){const node=stack.pop();if(!overlap(node,bounds))continue;if(node.object)visit(node.object);else stack.push(node.right,node.left);}}
  pairs(other,visit){
    const same=other===this,stack=this.root&&other.root?[[this.root,other.root]]:[];
    while(stack.length){const [a,b]=stack.pop();if(!overlap(a,b))continue;
      if(a===b){if(!a.object)stack.push([a.left,a.left],[a.left,a.right],[a.right,a.right]);continue;}
      if(a.object&&b.object){visit(a.object,b.object);continue;}
      if(a.object)stack.push([a,b.left],[a,b.right]);
      else if(b.object)stack.push([a.left,b],[a.right,b]);
      else stack.push([a.left,b.left],[a.left,b.right],[a.right,b.left],[a.right,b.right]);
    }
    return same;
  }
}

export class VoxelBroadPhase {
  constructor(){this.static=new VoxelAabbTree();this.sleeping=new VoxelAabbTree();this.active=new VoxelAabbTree();this.stats={pairs:0};}
  update({staticObjects=[],sleeping=[],active=[]}){this.static.rebuild(staticObjects);this.sleeping.rebuild(sleeping);this.active.rebuild(active);}
  collect({qualify=()=>true}={}){
    const pairs=[],visit=(a,b)=>{if(a.bodyId!==undefined&&a.bodyId===b.bodyId)return;if(a.layers!==undefined&&b.layers!==undefined&&(!(a.layers&b.mask)||!(b.layers&a.mask)))return;if(a.group&&a.group===b.group)return;if(qualify(a,b))pairs.push([a,b]);};
    this.active.pairs(this.static,visit);this.active.pairs(this.sleeping,visit);this.active.pairs(this.active,visit);this.stats.pairs=pairs.length;return pairs;
  }
}
