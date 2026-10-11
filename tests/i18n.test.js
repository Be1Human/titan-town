import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EN,t,translate,detectLang,normalizeLang} from '../src/i18n.js';
import {MATERIALS} from '../src/voxel-world.js';
import {PROJECTILE_TOOLS} from '../src/projectiles.js';

const CJK=/[\u4e00-\u9fff]/;
const read=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const clean=s=>s.replace(/&nbsp;/g,' ').replace(/[\s\u00a0]+/g,' ').trim();
const holes=s=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort().join(',');

function collectKeys(){
  const keys=new Set();
  for(const f of ['src/game.js','src/titan-campaign.js','src/titan-missions.js','src/local-cargo.js','src/game-bootstrap.js'])
    for(const m of read(f).matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g))keys.add(m[1].replace(/\\'/g,"'"));
  const html=read('game.html');
  for(const m of html.matchAll(/>([^<>]+)</g)){const k=clean(m[1]);if(CJK.test(k))keys.add(k);}
  for(const m of html.matchAll(/(?:aria-label|title)="([^"]+)"/g))if(CJK.test(m[1]))keys.add(clean(m[1]));
  const scene=JSON.parse(read('assets/scenes/titan-town.scene.json'));
  keys.add(scene.name);keys.add(scene.ape.name);keys.add(scene.rescue?.name??'');
  for(const l of scene.mapLabels)keys.add(l.text);
  for(const s of scene.safehouses)keys.add(s.name);
  for(const m of scene.missions){keys.add(m.name);keys.add(m.danger);}
  for(const m of Object.values(MATERIALS)){keys.add(m.name);if(m.hardness)keys.add(m.hardness);}
  for(const p of PROJECTILE_TOOLS){keys.add(p.name);keys.add(p.action);}
  for(const m of read('src/titan-town.js').match(/NAMES=\[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g))keys.add(m[1]);
  for(const f of ['src/engine/assets/original-cargo.js','src/engine/assets/original-props.js','src/engine/assets/original-door.js'])
    for(const m of read(f).matchAll(/name:\s*'([^']*)'/g))if(CJK.test(m[1]))keys.add(m[1]);
  keys.add('镇民');
  keys.delete('');
  return [...keys].filter(k=>CJK.test(k));
}

test('every player-visible Chinese string has an English entry with matching placeholders',()=>{
  const missing=collectKeys().filter(k=>!(k in EN));
  assert.deepEqual(missing,[]);
  for(const [zh,en] of Object.entries(EN)){
    assert.ok(en&&!CJK.test(en),'English text must not contain Chinese: '+zh);
    assert.equal(holes(en),holes(zh),'placeholder mismatch: '+zh);
  }
});

test('translate fills placeholders and falls back to the source text',()=>{
  assert.equal(translate('zh','已引爆 {n} 份炸药',{n:3}),'已引爆 3 份炸药');
  assert.equal(translate('en','已引爆 {n} 份炸药',{n:3}),'Detonated 3 charges');
  assert.equal(translate('en','没有翻译的句子'),'没有翻译的句子');
  assert.equal(translate('en',undefined),undefined);
  assert.equal(t('已引爆 {n} 份炸药',{n:1}),'已引爆 1 份炸药','Node keeps the Chinese source language');
});

test('language detection: ?lang wins over saved choice and browser language',()=>{
  assert.equal(detectLang({search:'?lang=en',stored:'zh',nav:'zh-CN'}),'en');
  assert.equal(detectLang({search:'?lang=zh',stored:'en',nav:'en-US'}),'zh');
  assert.equal(detectLang({stored:'zh',nav:'en-US'}),'zh');
  assert.equal(detectLang({nav:'zh-TW'}),'zh');
  assert.equal(detectLang({nav:'en-GB'}),'en');
  assert.equal(detectLang({nav:'fr-FR'}),'en');
  assert.equal(detectLang({}),'en');
  assert.equal(normalizeLang('ZH-hans'),'zh');
});
