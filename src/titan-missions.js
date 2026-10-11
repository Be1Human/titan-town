// "夺回城墙" mission run: seven starred missions, three lives, nearest
// safehouse respawn and a graded result. Pure logic; the game supplies the
// player, world queries and events.
export const MISSION_RULES={lives:3,interactRadius:2.2,rescueSaveRadius:4,rescueFollow:1.6,rescueSpeed:4.2,rescueLeash:26,rescueTrailStep:.4,rescueTrailMax:240,sealEvery:.5,starPoints:100,deathPenalty:80,minutePenalty:5,
  grades:[['S',1800],['A',1300],['B',800],['C',300]],failCap:'C'};

export function scoreRun({stars,deaths,seconds,failed=false}){
  const score=Math.round(stars*MISSION_RULES.starPoints-deaths*MISSION_RULES.deathPenalty-seconds/60*MISSION_RULES.minutePenalty);
  let grade=MISSION_RULES.grades.find(([,min])=>score>=min)?.[0]??'D';
  if(failed&&['S','A','B'].includes(grade))grade=MISSION_RULES.failCap;
  return {score,grade};
}

// Occupancy of the breach box: share of (x, y) columns that hold any static
// voxel or rigid debris along z. `solidAt(x,y,z)` answers both.
export function sealRatio(box,solidAt,{step=.25,depthStep=.2}={}){
  let filled=0,total=0;
  for(let x=box.min[0]+step/2;x<box.max[0];x+=step)for(let y=box.min[1]+step/2;y<box.max[1];y+=step){
    total++;for(let z=box.min[2];z<=box.max[2];z+=depthStep)if(solidAt(x,y,z)){filled++;break;}
  }
  return total?filled/total:0;
}

// Standing height for a walker at (x, z) near height y: a solid cell with
// 1.7 m of air above, at most 0.6 m up or 3 m down; null inside walls.
export function standHeight(getId,x,z,y){
  const cx=Math.floor(x/.1),cz=Math.floor(z/.1),top=Math.floor((y+.6)/.1+1e-6),bottom=Math.floor((y-3)/.1);
  for(let cy=top;cy>=Math.max(1,bottom);cy--){
    if(!getId(cx,cy-1,cz))continue;
    for(let k=0;k<17;k++)if(getId(cx,cy+k,cz))return null;
    return cy*.1;
  }
  return null;
}

export function createMissionRun(definition,{lives=MISSION_RULES.lives,events=null}={}){
  const emit=(type,data)=>events?.(type,data);
  const run={
    missions:(definition.missions??[]).map(m=>({...m,at:{...m.at},status:'todo',progress:0})),
    safehouses:(definition.safehouses??[]).map(s=>({...s,spawn:{...s.spawn}})),
    lives,deaths:0,seconds:0,downs:0,sealRatio:0,sealClock:0,result:null,log:[],
    rescue:definition.rescue?{id:definition.rescue.id,name:definition.rescue.name,x:definition.rescue.x,y:definition.rescue.y,z:definition.rescue.z,state:'waiting'}:null,
    get stars(){return run.missions.filter(m=>m.status==='done').reduce((n,m)=>n+m.stars,0);},
    get completed(){return run.missions.filter(m=>m.status==='done').length;},
    mission(id){return run.missions.find(m=>m.id===id);},
    complete,interactionAt,interact,update,die,nearestSafehouse,finish,titanDown,apeRepelled,snapshot,save,restore
  };
  // Quicksave state (F5/F9): plain data; restoring clears a finished result.
  function save(){return structuredClone({lives:run.lives,deaths:run.deaths,seconds:run.seconds,downs:run.downs,sealRatio:run.sealRatio,log:run.log,rescue:run.rescue,missions:run.missions.map(m=>({id:m.id,status:m.status,progress:m.progress,doneAt:m.doneAt??null}))});}
  function restore(s){
    if(!s)return false;
    Object.assign(run,{lives:s.lives,deaths:s.deaths,seconds:s.seconds,downs:s.downs,sealRatio:s.sealRatio,sealClock:0,result:null,log:structuredClone(s.log??[])});
    run.rescue=s.rescue?structuredClone(s.rescue):run.rescue;
    for(const m of run.missions){const saved=s.missions.find(x=>x.id===m.id);if(saved){m.status=saved.status;m.progress=saved.progress;if(saved.doneAt!=null)m.doneAt=saved.doneAt;else delete m.doneAt;}}
    return true;
  }
  function complete(id){
    const m=run.mission(id);if(!m||m.status==='done'||run.result)return false;
    m.status='done';m.progress=1;m.doneAt=+run.seconds.toFixed(1);run.log.push({t:m.doneAt,done:id});emit('complete',m);
    if(run.missions.every(x=>x.status==='done'))finish('complete');
    return true;
  }
  function near(p,player,r=MISSION_RULES.interactRadius,reachY=2.2){return Math.hypot(p.x-player.x,p.z-player.z)<r&&Math.abs((p.y??player.y)-player.y)<reachY;}
  // E-key target: a mission point, the rescue villager or the start board.
  function interactionAt(player){
    if(run.result)return null;
    for(const m of run.missions){
      if(m.status==='done')continue;
      if(m.kind==='interact'&&near(m.at,player,undefined,m.reachY))return {type:'mission',mission:m,label:m.id==='signal'?'点燃信号烟':m.id==='supply'?'领取补给':m.id==='documents'?'取走文件':m.name};
    }
    const r=run.rescue;if(r&&r.state!=='saved'&&r.state!=='following'&&near(r,player))return {type:'rescue',label:`让${r.name}跟着你`};
    const home=run.safehouses[0];if(home&&run.completed>0&&near(home.spawn,player,2.6))return {type:'board',label:'任务板 · 提前结算'};
    return null;
  }
  function interact(target){
    if(!target)return false;
    if(target.type==='mission'){emit('interact',target.mission);return complete(target.mission.id);}
    if(target.type==='rescue'){run.rescue.state='following';run.rescue.trail=[];run.mission('rescue').status='active';emit('rescue-follow',run.rescue);return true;}
    if(target.type==='board'){finish('early');return true;}
    return false;
  }
  // `ctx`: {player, standAt(x,z,y) -> y|null, groundAt(x,z,y), solidAt(x,y,z), apeRepelled}.
  // The villager walks the player's footprint trail, so she uses the same doors
  // and stairs; `standAt` returns null where she cannot stand (walls, ledges).
  function update(dt,ctx){
    if(run.result)return;run.seconds+=dt;
    const r=run.rescue,player=ctx.player;
    if(r&&r.state==='following'){
      const trail=r.trail??=[],last=trail.at(-1)??r;
      if(Math.hypot(player.x-last.x,player.z-last.z)>MISSION_RULES.rescueTrailStep)trail.push({x:player.x,y:player.y,z:player.z});
      if(trail.length>MISSION_RULES.rescueTrailMax)trail.shift();
      const d=Math.hypot(player.x-r.x,player.z-r.z);
      if(d>MISSION_RULES.rescueLeash||Math.abs(player.y-r.y)>6){r.state='waiting';r.trail=[];run.mission('rescue').status='todo';emit('rescue-lost',r);}
      else{
        const stand=(x,z,y)=>ctx.standAt?ctx.standAt(x,z,y):ctx.groundAt?.(x,z,y)??player.y;
        let budget=MISSION_RULES.rescueSpeed*dt;
        while(budget>1e-4&&trail.length&&Math.hypot(player.x-r.x,player.z-r.z)>MISSION_RULES.rescueFollow){
          const t=trail[0],tx=t.x-r.x,tz=t.z-r.z,td=Math.hypot(tx,tz);
          if(td<.05){trail.shift();continue;}
          const s=Math.min(td,budget),nx=r.x+tx/td*s,nz=r.z+tz/td*s,ny=stand(nx,nz,r.y);
          if(ny==null)break;
          r.x=nx;r.z=nz;r.y=ny;budget-=s;if(s>=td)trail.shift();
        }
      }
      for(const s of run.safehouses)if(Math.hypot(r.x-s.spawn.x,r.z-s.spawn.z)<MISSION_RULES.rescueSaveRadius){r.state='saved';r.trail=[];complete('rescue');break;}
    }
    const seal=run.mission('seal');
    if(seal&&seal.status!=='done'&&ctx.solidAt){
      run.sealClock-=dt;
      if(run.sealClock<=0){run.sealClock=MISSION_RULES.sealEvery;run.sealRatio=sealRatio(seal.box,ctx.solidAt);seal.progress=Math.min(1,run.sealRatio/seal.threshold);if(run.sealRatio>=seal.threshold)complete('seal');}
    }
  }
  function titanDown(){run.downs++;const hunt=run.mission('hunt');if(hunt&&hunt.status!=='done'){hunt.progress=Math.min(1,run.downs/hunt.count);hunt.status=run.downs>=hunt.count?hunt.status:'active';if(run.downs>=hunt.count)complete('hunt');}}
  function apeRepelled(player){const m=run.mission('reclaim');if(m&&m.status!=='done'&&player.y>=m.minY)return complete('reclaim');return false;}
  function nearestSafehouse(p){let best=null;for(const s of run.safehouses){const d=Math.hypot(s.spawn.x-p.x,s.spawn.z-p.z);if(!best||d<best.d)best={s,d};}return best?.s??null;}
  // Death: one life, nearest-safehouse respawn, progress kept.
  function die(reason,at){
    if(run.result)return null;
    run.lives=Math.max(0,run.lives-1);run.deaths++;run.log.push({t:+run.seconds.toFixed(1),death:reason});
    if(run.rescue?.state==='following'){run.rescue.state='waiting';run.mission('rescue').status='todo';}
    if(run.lives<=0){finish('failed');return {failed:true,reason};}
    const s=nearestSafehouse(at);emit('death',{reason,safehouse:s});return {failed:false,reason,safehouse:s};
  }
  function finish(kind){
    if(run.result)return run.result;
    const failed=kind==='failed',{score,grade}=scoreRun({stars:run.stars,deaths:run.deaths,seconds:run.seconds,failed});
    run.result={kind,failed,completed:run.completed,total:run.missions.length,stars:run.stars,deaths:run.deaths,lives:run.lives,seconds:+run.seconds.toFixed(1),score,grade};
    emit('finish',run.result);return run.result;
  }
  function snapshot(){return {lives:run.lives,deaths:run.deaths,seconds:+run.seconds.toFixed(1),stars:run.stars,completed:run.completed,downs:run.downs,sealRatio:+run.sealRatio.toFixed(3),rescue:run.rescue&&{...run.rescue},missions:run.missions.map(m=>({id:m.id,status:m.status,progress:+m.progress.toFixed(2)})),result:run.result};}
  return run;
}
