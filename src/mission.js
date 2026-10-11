export class Mission {
  constructor(targets,mode='heist',{duration=60}={}) { this.mode=mode;this.phase=mode==='sandbox'?'sandbox':'planning';this.remaining=duration;this.collected=new Set();this.total=targets.length; }
  collect(id) {
    if(this.phase==='won'||this.phase==='failed'||this.collected.has(id)) return false;
    if(this.phase==='planning') this.phase='alarm';
    this.collected.add(id);return true;
  }
  tick(dt) {
    if(this.phase==='alarm') { this.remaining=Math.max(0,this.remaining-Math.max(0,dt));if(this.remaining===0) this.phase='failed'; }
  }
  escape() {
    if(this.mode==='heist' && this.phase==='alarm' && this.collected.size===this.total && this.remaining>0) {this.phase='won';return true;}return false;
  }
  snapshot() {return {mode:this.mode,phase:this.phase,remaining:this.remaining,collected:[...this.collected]};}
  restore(s) {this.mode=s.mode;this.phase=s.phase;this.remaining=s.remaining;this.collected=new Set(s.collected);}
}
