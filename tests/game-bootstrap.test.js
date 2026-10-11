import test from 'node:test';
import assert from 'node:assert/strict';
import {bootGame} from '../src/game-bootstrap.js';

function fixture(){
  const elements=new Map(['loading','startup-hint','startup-retry','fatal','fatal-message'].map(id=>[id,{hidden:id!=='loading',textContent:''}]));
  const controls=Array.from({length:6},()=>({disabled:false}));
  const doc={documentElement:{dataset:{}},querySelectorAll:()=>controls,getElementById:id=>elements.get(id)};
  let timer,cleared=false,reloads=0;
  return {doc,controls,elements,get cleared(){return cleared;},get reloads(){return reloads;},slow(){timer();},options:{doc,setTimer:fn=>(timer=fn,41),clearTimer:id=>{assert.equal(id,41);cleared=true;},reload:()=>reloads++,report:()=>{}}};
}

test('menu actions unlock only after game initialization and slow startup remains recoverable',async()=>{
  const f=fixture();let finish;
  const ready=bootGame({...f.options,load:()=>new Promise(resolve=>finish=resolve)});
  assert.equal(f.doc.documentElement.dataset.gameStartup,'loading');assert.ok(f.controls.every(b=>b.disabled));
  f.slow();assert.equal(f.elements.get('startup-hint').hidden,false);assert.equal(f.elements.get('startup-retry').hidden,false);
  f.elements.get('startup-retry').onclick();assert.equal(f.reloads,1);
  finish();assert.equal(await ready,true);assert.ok(f.controls.every(b=>!b.disabled));
  assert.equal(f.doc.documentElement.dataset.gameStartup,'ready');assert.equal(f.elements.get('startup-retry').hidden,true);assert.equal(f.cleared,true);
});

test('dependency download and parse failures show a retry instead of a dead menu',async()=>{
  for(const error of [new TypeError('Failed to fetch dynamically imported module'),new SyntaxError('Unexpected token')]){
    const f=fixture();assert.equal(await bootGame({...f.options,load:()=>Promise.reject(error)}),false);
    assert.equal(f.doc.documentElement.dataset.gameStartup,'error');assert.equal(f.elements.get('fatal').hidden,false);
    assert.match(f.elements.get('fatal-message').textContent,/重新加载/);assert.ok(f.elements.get('fatal-message').textContent.includes(error.message));
    assert.ok(f.controls.every(b=>b.disabled));assert.equal(f.cleared,true);
  }
});

test('a renderer error cannot be reported as a ready scene',async()=>{
  const f=fixture();const load=async()=>{f.elements.get('fatal').hidden=false;f.elements.get('fatal-message').textContent='画面初始化失败';};
  assert.equal(await bootGame({...f.options,load}),false);assert.ok(f.controls.every(b=>b.disabled));
  assert.equal(f.doc.documentElement.dataset.gameStartup,'error');
});

test('a departure starts only after initialization unlocks the co-op controls',async()=>{
  const f=fixture();let launched=false;
  assert.equal(await bootGame({...f.options,load:async()=>({launchFromMainMenu(){assert.equal(f.doc.documentElement.dataset.gameStartup,'ready');assert.ok(f.controls.every(button=>!button.disabled));launched=true;}})}),true);
  assert.equal(launched,true);
});

test('co-op controls created during asynchronous initialization remain gated until ready',async()=>{
 const f=fixture(),early=f.controls.slice(),late=[{id:'coop-create',disabled:true},{id:'coop-join',disabled:true}];let finish;
 const queried=[];f.doc.querySelectorAll=selector=>{queried.push(selector);return f.controls;};
 const ready=bootGame({...f.options,load:()=>new Promise(resolve=>finish=resolve)});
 f.controls.push(...late);assert.equal(f.doc.documentElement.dataset.gameStartup,'loading');assert.ok(late.every(button=>button.disabled));
 finish();assert.equal(await ready,true);assert.equal(f.doc.documentElement.dataset.gameStartup,'ready');assert.ok([...early,...late].every(button=>!button.disabled));assert.ok(queried.every(selector=>selector.includes('#coop-create')&&selector.includes('#coop-join')));
});
