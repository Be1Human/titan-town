const DATABASE='titan-town-saves';
const STORE='snapshots';
const FORMAT='titan-town-save-record-v1';

function browserStorage(name){
  try{return globalThis[name];}catch{return undefined;}
}
function message(error){return error?.message||String(error);}
function record(value){
  if(value==null)return null;
  return value.format===FORMAT&&Number.isFinite(value.savedAt)&&Object.hasOwn(value,'save')
    ?value:{format:FORMAT,savedAt:0,save:value};
}

// Dependencies are injectable so transaction ordering can be tested without a
// browser or another package. The production module only uses browser APIs.
export function createSaveStore(environment,{mapId='titan-town-v1'}={}){
  const key=mapId,legacyKey='save-'+mapId;
  const indexedDB=environment?environment.indexedDB:browserStorage('indexedDB');
  const localStorage=environment?environment.localStorage:browserStorage('localStorage');
  let opening=null,queue=Promise.resolve(),lastSavedAt=0;

  function ordered(operation){
    const result=queue.then(operation);
    queue=result.catch(()=>{});
    return result;
  }
  function openDatabase(){
    if(!indexedDB?.open)return Promise.reject(new Error('IndexedDB 不可用'));
    if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      let request,settled=false;
      const fail=error=>{if(settled)return;settled=true;reject(error);};
      try{request=indexedDB.open(DATABASE,1);}catch(error){fail(error);return;}
      request.onupgradeneeded=()=>{
        try{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);}
        catch(error){fail(error);try{request.transaction?.abort();}catch{}}
      };
      request.onerror=()=>fail(request.error||new Error('无法打开存档数据库'));
      request.onblocked=()=>fail(new Error('存档数据库被另一个窗口占用'));
      request.onsuccess=()=>{
        const database=request.result;
        if(settled){database.close();return;}
        settled=true;
        database.onversionchange=()=>{database.close();opening=null;};
        database.onclose=()=>{opening=null;};
        resolve(database);
      };
    });
    opening.catch(()=>{opening=null;});
    return opening;
  }
  async function transaction(mode,operation){
    const database=await openDatabase();
    return new Promise((resolve,reject)=>{
      let tx,value,failure=null;
      try{
        tx=database.transaction(STORE,mode);
        tx.oncomplete=()=>failure?reject(failure):resolve(value);
        tx.onabort=()=>reject(failure||tx.error||new Error('存档事务已取消'));
        tx.onerror=()=>{failure=tx.error||failure||new Error('存档事务失败');};
        const request=operation(tx.objectStore(STORE));
        request.onsuccess=()=>{value=request.result;};
        request.onerror=()=>{failure=request.error||new Error('无法读写存档');};
      }catch(error){
        reject(error);
        try{tx?.abort();}catch{}
      }
    });
  }
  function legacySave(){
    const text=localStorage?.getItem(legacyKey);
    if(text==null)return null;
    try{return record(JSON.parse(text));}catch(error){throw new Error('旧存档内容损坏，无法读取',{cause:error});}
  }
  function readGameSave(){
    return ordered(async()=>{
      let current=null,legacy=null;
      try{
        current=record(await transaction('readonly',store=>store.get(key)));
      }catch{}
      try{legacy=legacySave();}catch(error){if(!current)throw error;}
      const latest=legacy&&(!current||legacy.savedAt>current.savedAt)?legacy:current;
      if(latest)lastSavedAt=Math.max(lastSavedAt,latest.savedAt);
      if(latest&&latest===legacy){
        // A failed migration must not hide an otherwise usable legacy save.
        // Keep the old copy, including after a successful IndexedDB commit.
        try{await transaction('readwrite',store=>store.put(legacy,key));}catch{}
      }
      return latest?.save??null;
    });
  }
  function writeGameSave(save){
    if(save===null||typeof save!=='object')return Promise.reject(new TypeError('存档必须是有效对象'));
    return ordered(async()=>{
      // Metadata lets a successful fallback write supersede an older IDB copy.
      // The read API unwraps it, and still understands pre-migration raw saves.
      const savedAt=Math.max(Date.now(),lastSavedAt+1);lastSavedAt=savedAt;
      const value={format:FORMAT,savedAt,save};
      let databaseError;
      try{
        await transaction('readwrite',store=>store.put(value,key));
        return {backend:'indexedDB'};
      }catch(error){databaseError=error;}
      try{
        if(!localStorage?.setItem)throw new Error('localStorage 不可用');
        const text=JSON.stringify(value);
        if(text===undefined)throw new Error('存档内容无效');
        localStorage.setItem(legacyKey,text);
        return {backend:'localStorage'};
      }catch(error){
        throw new Error(`无法持久保存进度：IndexedDB：${message(databaseError)}；localStorage：${message(error)}`,{cause:error});
      }
    });
  }
  return {readGameSave,writeGameSave};
}

const defaultStore=createSaveStore();
export const readGameSave=()=>defaultStore.readGameSave();
export const writeGameSave=save=>defaultStore.writeGameSave(save);
