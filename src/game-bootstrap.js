import {t,applyDom,bindLangToggle} from './i18n.js';
// Keep the menu honest while the large game module graph initializes. Dynamic
// import also catches dependency download, syntax and initialization failures.
export async function bootGame({doc=globalThis.document,load=()=>import('./game.js'),setTimer=setTimeout,clearTimer=clearTimeout,reload=()=>globalThis.location.reload(),report=console.error}={}){
  const selector='.main-options button:not(#physics-lab), #coop-create, #coop-join';
  const controls=[...doc.querySelectorAll(selector)];
  const loading=doc.getElementById('loading'),hint=doc.getElementById('startup-hint'),retry=doc.getElementById('startup-retry');
  doc.documentElement.dataset.gameStartup='loading';
  controls.forEach(button=>button.disabled=true);
  retry.onclick=reload;
  const slowTimer=setTimer(()=>{hint.hidden=false;retry.hidden=false;},20000);
  try{
    const runtime=await load();
    // A renderer failure may already have displayed the existing error panel.
    if(!doc.getElementById('fatal').hidden)throw new Error(doc.getElementById('fatal-message').textContent||t('画面初始化失败'));
    doc.documentElement.dataset.gameStartup='ready';
    // The co-op form is created inside game.js while load() is awaiting shader
    // preparation. Query again so those late controls unlock only now.
    [...doc.querySelectorAll(selector)].forEach(button=>button.disabled=false);
    hint.hidden=true;retry.hidden=true;
    await runtime?.launchFromMainMenu?.();
    return true;
  }catch(error){
    doc.documentElement.dataset.gameStartup='error';
    loading.textContent=t('游戏加载失败');hint.hidden=true;retry.hidden=false;
    doc.getElementById('fatal-message').textContent=`${t('游戏未能启动，请重新加载。')}${error?.message?'\n'+error.message:''}`;
    doc.getElementById('fatal').hidden=false;
    report('Game startup failed:',error);
    return false;
  }finally{clearTimer(slowTimer);}
}

if(typeof document!=='undefined'){applyDom(document);bindLangToggle(document);bootGame();}
