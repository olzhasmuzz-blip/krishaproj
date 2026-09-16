import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(root, 'dist', name), 'utf8');
const assets = { index: read('index.html'), styles: read('styles.css'), app: read('app.js'), favicon: read('favicon.svg') };
const safe = value => JSON.stringify(value).replace(/<\//g, '<\\/');

const worker = `const assets={"/":{body:${safe(assets.index)},type:"text/html; charset=utf-8"},"/index.html":{body:${safe(assets.index)},type:"text/html; charset=utf-8"},"/styles.css":{body:${safe(assets.styles)},type:"text/css; charset=utf-8"},"/app.js":{body:${safe(assets.app)},type:"application/javascript; charset=utf-8"},"/favicon.svg":{body:${safe(assets.favicon)},type:"image/svg+xml"}};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const strip=v=>String(v||"").replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\\s+/g," ").trim();
const sourceInfo=env=>({mode:env.KRISHA_SOURCE_MODE||"demo",source:"krisha.kz",status:env.KRISHA_SOURCE_URL?"configured":"awaiting_configuration",message:env.KRISHA_SOURCE_URL?"Авторизованный канал настроен; доступ проверяется по расписанию.":"Укажите KRISHA_SOURCE_URL и KRISHA_SOURCE_MODE в секретах Site.",last_successful_observation:null});
async function readSource(env){const status=sourceInfo(env);if(!env.KRISHA_SOURCE_URL)return {items:[],source:status};const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Number(env.KRISHA_SOURCE_TIMEOUT_MS||12000));try{const response=await fetch(env.KRISHA_SOURCE_URL,{headers:{accept:"application/json, text/html;q=0.9"},signal:controller.signal});if(!response.ok)throw new Error("source_http_"+response.status);const type=response.headers.get("content-type")||"";const raw=await response.text();let items=[];if(type.includes("json")){const parsed=JSON.parse(raw);items=Array.isArray(parsed)?parsed:(parsed.items||parsed.data||[])}else{const seen=new Set();for(const match of raw.matchAll(/href=["']([^"']*\\/a\\/show\\/([0-9]+))[^"']*["'][^>]*>([\\s\\S]{0,400})<\\/a>/gi)){const id=match[2];if(seen.has(id))continue;seen.add(id);items.push({source_id:id,url:new URL(match[1],env.KRISHA_SOURCE_URL).toString(),title:strip(match[3])})}}return {items,source:{...status,status:"healthy",last_successful_observation:new Date().toISOString(),count:items.length}}}catch(error){return {items:[],source:{...status,status:"error",message:String(error.message||error)}}}finally{clearTimeout(timer)}}
export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname==="/api/health")return json({service:"estate-radar",status:"ok",version:"1.1.0",source_mode:env.KRISHA_SOURCE_MODE||"demo"});if(url.pathname==="/api/source-status"){const result=await readSource(env);return json(result.source,result.source.status==="error"?502:200)}if(url.pathname==="/api/events"&&request.method==="GET")return json(await readSource(env));if(url.pathname==="/api/telegram/webhook"&&request.method==="POST")return json({ok:false,error:"telegram_not_configured"},501);const asset=assets[url.pathname]||assets["/"];return new Response(asset.body,{headers:{"content-type":asset.type,"cache-control":"no-cache"}})}};`;
fs.mkdirSync(path.join(root, 'dist', 'server'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'server', 'index.js'), worker);
console.log('Generated dist/server/index.js');

