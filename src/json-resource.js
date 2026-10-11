// Browser fetch avoids relying on support for JSON module import attributes.
// Node tools share immutable baselines through its JSON module cache. Browser
// loading continues to use fetch, without requiring import-attribute support.
export async function loadJSONResource(url,{fetchResource=globalThis.fetch}={}){
  const resource=new URL(url);
  if(resource.protocol==='file:'&&typeof process!=='undefined'&&process.versions?.node){
    return (await import(resource.href,{with:{type:'json'}})).default;
  }
  const response=await fetchResource(resource);
  if(!response.ok)throw new Error(`地图资源加载失败（${response.status}）：${resource.pathname}`);
  try{return await response.json();}
  catch{throw new Error(`地图资源格式错误：${resource.pathname}`);}
}
