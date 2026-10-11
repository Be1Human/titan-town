// Physics keeps advancing independently. This only avoids redrawing an
// unchanged world while its asynchronous fixed step is still outstanding.
// Camera/input, geometry, viewport, epoch and completed poses bypass the wait;
// a bounded refresh also keeps purely visual time-based effects progressing.
export class ReferenceFramePolicy {
  constructor({refreshMs=100}={}){this.refreshMs=refreshMs;this.previous=null;this.stats={skipped:0,rendered:0};}
  shouldRender(current){
    const old=this.previous;if(!old||!current.pending||current.thirdPerson||current.activeInput||current.steps!==old.steps||current.revision!==old.revision||current.epoch!==old.epoch)return true;
    if(current.view.length!==old.view.length)return true;
    for(let i=0;i<current.view.length;i++)if(current.view[i]!==old.view[i])return true;
    // A finished job still queued for its main-thread reply should be consumed
    // before another identical full draw occupies the thread. Input bypasses
    // this gate; results are never written without the normal epoch barrier.
    if(!current.completionReady&&current.now-old.now>=this.refreshMs)return true;
    this.stats.skipped++;return false;
  }
  didRender(current){this.previous={...current,view:current.view.slice()};this.stats.rendered++;}
  reset(){this.previous=null;}
}
