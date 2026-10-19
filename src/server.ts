import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './core.js';
import { Auth, PERMISSIONS, type Principal as AuthPrincipal } from './auth.js';
import { Lifecycle, OciDeployment } from './lifecycle.js';
import { LeaseManager, type Principal } from './leases.js';
import { McpGateway, connectChromeMcp, createStreamableMcp, MCP_VERSION, SHARED_PROFILE_WARNING } from './mcp.js';
import { RfbInputGate } from './viewer.js';
import { WebSocketServer, WebSocket } from 'ws';
import { connect } from 'node:net';
import { FileService, type FileActor, type SecurityHooks } from './files.js';
import { CommandService } from './commands.js';
import { once } from 'node:events';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { PageOwnership, type PageRecord } from './mcp.js';
const exec = promisify(execFile);
export type HostRunner = (file:string,args:string[])=>Promise<string>;
const hostRun:HostRunner=async(file,args)=>String((await exec(file,args,{timeout:10000,maxBuffer:1024*1024})).stdout);
const runtime=()=>process.env.OCI_RUNTIME==='podman'?'podman':'docker';
function workspaceName(w:string){if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(w))throw Error('Invalid workspace identifier');return `buk-${w}`;}
export async function privateBrowserAddress(w:string,run:HostRunner=hostRun){
 const name=workspaceName(w);const [c]=JSON.parse(await run(runtime(),['inspect',name+'-browser']));
 if(!c?.State?.Running||c.Config?.Labels?.['browseruse.workspace']!==w||Object.keys(c.HostConfig?.PortBindings??{}).length||c.HostConfig?.NetworkMode==='host')throw Error('Unsafe browser routing');
 const networks=c.NetworkSettings?.Networks??{};if(Object.keys(networks).length!==1||!networks[name+'-browser'])throw Error('Browser private network mismatch');
 const ip=networks[name+'-browser'].IPAddress;if(isIP(ip)!==4)throw Error('Private browser address unavailable');return ip as string;
}
export async function validateUtilityIsolation(c:Record<string,any>,w:string,run:HostRunner=hostRun){
 const name=workspaceName(w),h=c.HostConfig;const networks=c.NetworkSettings?.Networks??{};
 if(c.Config?.Labels?.['browseruse.workspace']!==w||c.Config?.User!=='1000:1000'||Object.keys(networks).length!==1||!networks[name+'-utility'])throw Error('Utility workspace identity mismatch');
 if(!c.State?.Running||!h||h.Privileged||h.NetworkMode==='host'||h.PidMode||h.IpcMode==='host'||h.IpcMode?.startsWith('container:')||h.CapAdd?.length||!h.ReadonlyRootfs||!h.CapDrop?.some((x:string)=>x.toUpperCase()==='ALL')||!h.SecurityOpt?.some((x:string)=>/^no-new-privileges(?:[=:]true)?$/.test(x))||Object.keys(h.PortBindings??{}).length)throw Error('Utility isolation missing');
 if(c.Mounts?.length!==1||c.Mounts[0].Type!=='volume'||c.Mounts[0].Name!==name+'-files'||c.Mounts[0].Destination!=='/workspace')throw Error('Utility mounts mismatch');
 if(!(h.Memory>0)||!(h.PidsLimit>0)||!(h.NanoCpus>0||h.CpuQuota>0))throw Error('Utility limits missing');
 if(!Number.isSafeInteger(c.State.Pid)||c.State.Pid<2)throw Error('Utility namespace unavailable');
 // Inspect live namespace policy, not a label claiming the policy was installed.
 const proxy=c.Config.Env?.find((v:string)=>v.startsWith('HTTP_PROXY='))?.slice(11)??c.Config.Env?.find((v:string)=>v.startsWith('http_proxy='))?.slice(11);
 const [egress]=JSON.parse(await run(runtime(),['inspect',name+'-egress']));const ip=egress?.NetworkSettings?.Networks?.[name+'-utility']?.IPAddress;
 if(isIP(ip)!==4||!egress.State?.Running)throw Error('Controlled proxy unavailable');
 for(const family of ['iptables','ip6tables']){
  const rules=await run('nsenter',['-t',String(c.State.Pid),'-n',family,'-S','OUTPUT']);
  const lines=rules.trim().split('\n');const allowed=new Set(['-P OUTPUT DROP','-A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT','-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT','-A OUTPUT -o lo -j ACCEPT',`-A OUTPUT -d ${ip}/32 -p tcp -m tcp --dport 3128 -j ACCEPT`]);
  if(!lines.includes('-P OUTPUT DROP')||lines.some(line=>!allowed.has(line))||(family==='iptables'&&!lines.some(line=>line.includes(`-d ${ip}/32`))))throw Error('Direct egress policy missing or bypassable');
 }
 void proxy;
}

export interface Identity { id:string; subject:string; workspaceId?:string|null; permissions:readonly string[]; csrf?:string|null; kind?:string; reconnectId?:string }
export interface ServerServices {
  authenticate(token:string):Identity;
  login(username:string,password:string,address:string):Promise<{token:string;csrf:string}>|{token:string;csrf:string};
  revoke(identity:Identity,id:string):unknown;
  issue(identity:Identity,body:Record<string,unknown>):unknown;
  list(identity:Identity):unknown;
  create(identity:Identity,body:Record<string,unknown>):unknown;
  workspace(id:string):unknown;
  operation(name:string,workspace:string,identity:Identity,body:any,req:Request,res:Response):unknown|Promise<unknown>;
  bootstrap?(username:string,password:string):unknown;
}
export interface ServerOptions { hosts:string[]; secure?:boolean; publicDir?:string }
const cookieName='buk_session';
function cookie(req:Request):string|undefined { const entries=(req.headers.cookie??'').split(';').map(s=>s.trim()); const entry=entries.find(s=>s.startsWith(cookieName+'=')); return entry?.slice(cookieName.length+1); }
export function createApp(services:ServerServices,options:ServerOptions) {
  const app=express(); app.disable('x-powered-by'); app.set('trust proxy',false);
  app.use((req,res,next)=>{
    if(!req.headers.host||!options.hosts.includes(req.headers.host)){res.status(421).json({error:'Unknown host'});return;}
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; style-src 'self'; frame-ancestors 'none'"});
    next();
  });
  app.use(express.json({limit:'64kb'}));
  app.get('/health',(_req,res)=>res.json({status:'ok'}));
  app.post('/api/login',async(req,res,next)=>{try{
    const {username,password}=req.body??{}; if(typeof username!=='string'||typeof password!=='string'||username.length>128||password.length>1024){res.status(400).json({error:'Invalid credentials'});return;}
    const result=await services.login(username,password,req.socket.remoteAddress??'unknown');
    res.setHeader('Set-Cookie',`${cookieName}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${options.secure?'; Secure':''}`);res.json({csrf:result.csrf,csrfToken:result.csrf});
  }catch(e){next(e);}});
  app.use('/api',(req,res,next)=>{try{
    const authorization=req.headers.authorization; const token=authorization?.startsWith('Bearer ')?authorization.slice(7):cookie(req);
    if(!token){res.status(401).json({error:'Authentication required'});return;}
    const identity=services.authenticate(token);res.locals.identity=identity;
    if(!authorization?.startsWith('Bearer ')&&!['GET','HEAD','OPTIONS'].includes(req.method)&&(!identity.csrf||req.headers['x-csrf-token']!==identity.csrf)){res.status(403).json({error:'CSRF validation failed'});return;}
    next();
  }catch{res.status(401).json({error:'Invalid or expired credential'});}});
  const handler=(fn:(req:Request,res:Response,p:Identity)=>unknown)=>async(req:Request,res:Response,next:NextFunction)=>{try{const value=await fn(req,res,res.locals.identity);if(!res.headersSent&&value!==undefined)res.json(value);}catch(e){next(e);}};
  app.get(['/api/session','/api/me'],handler((_r,_s,p)=>({subject:p.subject,permissions:p.permissions,csrf:p.csrf,csrfToken:p.csrf})));
  app.post('/api/logout',handler((req,res,p)=>{services.revoke(p,p.id);res.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${options.secure?'; Secure':''}`);return {ok:true};}));
  app.post('/api/tokens',handler((req,_res,p)=>services.issue(p,req.body)));
  app.delete('/api/tokens/:tokenId',handler((req,_res,p)=>services.revoke(p,String(req.params.tokenId))));
  app.get('/api/workspaces',handler((_req,_res,p)=>services.list(p)));
  app.post('/api/workspaces',handler((req,_res,p)=>services.create(p,req.body)));
  app.use('/api/workspaces/:id',(req,res,next)=>{try{
    const p:Identity=res.locals.identity; const id=String(req.params.id);
    if(!/^[a-zA-Z0-9-]{1,80}$/.test(id)) {res.status(400).json({error:'Invalid workspace identifier'});return;}
    if(p.workspaceId&&p.workspaceId!==id){res.status(403).json({error:'Workspace scope mismatch'});return;}
    if(!services.workspace(id)){res.status(404).json({error:'Workspace not found'});return;}
    res.locals.workspace=id;next();
  }catch(e){next(e);}});
  const route=(method:'get'|'post'|'delete'|'put',path:string,operation:string,permission:string)=>app[method]('/api/workspaces/:id'+path,handler((req,res,p)=>{
    if(!p.permissions.includes(permission)&&!p.permissions.includes('admin')&&!p.permissions.includes('*')){res.status(403).json({error:'Permission denied'});return;}
    return services.operation(operation,res.locals.workspace,p,req.body,req,res);
  }));
  route('get','','inspect','view');route('delete','','delete','workspace:manage');
  for(const action of ['start','stop','restart'])route('post','/'+action,action,'workspace:manage');
  route('get','/health','health','view');route('get','/events','events','view');route('post','/events','status','automation');
  route('get','/pages','pages','view');route('post','/pages','claimPage','automation');route('put','/pages/:pageId','transferPage','takeover');route('put','/pages/:pageId/owner','transferPage','takeover');
  route('get','/tokens','tokens','workspace:manage');route('post','/tokens','issueToken','workspace:manage');route('delete','/tokens/:tokenId','revokeToken','workspace:manage');
  route('post','/emergency-stop','emergencyStop','takeover');
  route('get','/files','listFiles','files:read');route('get','/files/download','download','files:read');route('put','/files','upload','files:write');route('delete','/files','deleteFile','files:write');
  route('get','/quota','quota','files:read');route('post','/commands','command','shell');route('get','/commands','commands','view');route('get','/commands/:commandId','commandStatus','shell');route('delete','/commands/:commandId','cancelCommand','shell');route('post','/commands/:commandId/cancel','cancelCommand','shell');
  for(const kind of ['automation','human']) { const permission=kind==='human'?'takeover':'automation';route('post',`/leases/${kind}`,`acquire:${kind}`,permission);route('put',`/leases/${kind}`,`renew:${kind}`,permission);route('post',`/leases/${kind}/renew`,`renew:${kind}`,permission);route('delete',`/leases/${kind}`,`release:${kind}`,permission); }
  route('post','/keep-alive','keepAlive','automation');route('delete','/keep-alive','releaseKeepAlive','automation');
  route('post','/mcp','mcp','automation');route('get','/mcp','mcp','automation');route('delete','/mcp','mcp','automation');route('get','/viewer','viewer','view');route('get','/screenshots','screenshots','view');
  app.use('/api',(_req,res)=>res.status(404).json({error:'Unknown API route'}));
  app.use('/novnc',express.static(resolve('node_modules/@novnc/novnc'),{dotfiles:'deny',index:false}));
  app.use(express.static(options.publicDir??resolve('public'),{index:'index.html'}));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{if(res.headersSent){res.end();return;}const status=typeof error==='object'&&error!==null&&'status' in error?Number(error.status):500;res.status(status>=400&&status<=599?status:500).json({error:status>=400&&status<500?'Request rejected':'Operation failed; inspect diagnostics'});});
  return app;
}
export function createHttpServer(services:ServerServices,options:ServerOptions){return createServer(createApp(services,options));}

export async function browserCdp(w:string,method:string,params:Record<string,unknown>={},run:HostRunner=hostRun):Promise<any>{
 const ip=await privateBrowserAddress(w,run);const response=await fetch(`http://${ip}:9223/json/version`,{signal:AbortSignal.timeout(3000),redirect:'error'});if(!response.ok)throw Error('Private CDP unavailable');
 const version=await response.json() as {webSocketDebuggerUrl?:string};const endpoint=new URL(version.webSocketDebuggerUrl??'');if(endpoint.protocol!=='ws:'||!/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint.pathname))throw Error('Unexpected CDP endpoint');endpoint.hostname=ip;endpoint.port='9223';
 return new Promise((resolve,reject)=>{const socket=new WebSocket(endpoint);const timer=setTimeout(()=>{socket.terminate();reject(Error('CDP timeout'));},5000);const done=(error:unknown,result?:unknown)=>{clearTimeout(timer);socket.close();error?reject(error):resolve(result);};socket.on('open',()=>socket.send(JSON.stringify({id:1,method,params})));socket.on('message',raw=>{try{const data=JSON.parse(raw.toString());if(data.id===1)done(data.error?Error('CDP operation failed'):null,data.result);}catch(e){done(e);}});socket.on('error',e=>done(e));socket.on('close',()=>{clearTimeout(timer);reject(Error('CDP closed'));});});
}

export function defaultServices(store=new Store(process.env.BUK_DATABASE??'data/control.sqlite')) {
 const auth=new Auth(store); const principals=new Map<string,AuthPrincipal>();
 const asPrincipal=(p:Identity,w:string):Principal=>{principals.set(p.id,p as AuthPrincipal);return {workspaceId:w,connectionId:p.id,subject:p.subject,reconnectId:p.reconnectId??p.id,permissions:p.permissions.includes('*')?[...PERMISSIONS]:p.permissions};};
 const validate=(p:Principal)=>{const credential=principals.get(p.connectionId);if(!credential)throw Error('Unknown connection');auth.authorize(credential,'view',p.workspaceId);};
 const leases=new LeaseManager((w,t,s,m)=>{store.audit(w,t,s,m);},validate);
 const active=new Map<string,number>();const keepAlive=new Map<string,number>();
 const commandServices=new Map<string,CommandService>();const fileServices=new Map<string,FileService>();
 const baseDeployment=new OciDeployment(runtime());
 const deployment={start:(w:any)=>baseDeployment.start(w),stop:(w:any)=>baseDeployment.stop(w),remove:(w:any)=>baseDeployment.remove(w),healthy:async(w:any)=>{try{await controlHealth(w.id);return true;}catch{return false;}}};
 const lifecycle=new Lifecycle(store,deployment,{revoke:w=>auth.revokeWorkspace(w),busy:w=>(active.get(w)??0)>0||(keepAlive.get(w)??0)>Date.now(),quiesce:async w=>{await commandServices.get(w)?.cancelAll();}});
 const hooks=(w:string):SecurityHooks=>({authorize:(actor,permission)=>{const p=principals.get(actor.connectionId);if(!p)throw Error('Unknown identity');auth.authorize(p,permission.startsWith('shell:')?'shell':permission,w);},validateLease:actor=>{const p=principals.get(actor.connectionId);if(!p)throw Error('Unknown identity');leases.assertAutomation(asPrincipal(p,w));},audit:event=>{store.audit(w,event.type,event.sourceId,event.summary);}});
 const files=async(w:string)=>{let service=fileServices.get(w);if(!service){
  let root:string,staging:string;
  if(process.env.BUK_FILES_ROOT){root=resolve(process.env.BUK_FILES_ROOT,w,'files');staging=resolve(process.env.BUK_FILES_ROOT,w,'staging');}
  else{const [volume]=JSON.parse(await hostRun(runtime(),['volume','inspect',workspaceName(w)+'-files']));if(volume.Name!==workspaceName(w)+'-files'||typeof volume.Mountpoint!=='string'||!volume.Mountpoint.startsWith('/'))throw Error('Workspace volume unavailable');root=volume.Mountpoint;staging=resolve(dirname(root),'.buk-control-staging');}
  await mkdir(staging,{recursive:true,mode:0o700});const metadata=await stat(staging);if(metadata.uid!==process.getuid!()||(metadata.mode&0o077)!==0)throw Error('Unprotected staging directory');
  service=new FileService({workspaceId:w,root,staging,...hooks(w)});fileServices.set(w,service);
 }return service;};
 const commands=(w:string)=>{let service=commandServices.get(w);if(!service){service=new CommandService({workspaceId:w,runtime:runtime(),container:`buk-${w}-utility`,user:'1000:1000',...hooks(w),validateIsolation:inspection=>validateUtilityIsolation(inspection,w)});commandServices.set(w,service);}return service;};
 store.db.exec('CREATE TABLE IF NOT EXISTS page_ownership(workspaceId TEXT PRIMARY KEY,pages TEXT NOT NULL); CREATE TABLE IF NOT EXISTS agent_reconnect(credentialId TEXT PRIMARY KEY,reconnectId TEXT NOT NULL,subject TEXT NOT NULL,workspaceId TEXT NOT NULL)');
 const ownership=new PageOwnership((w,t,s,m)=>{store.audit(w,t,s,m);},w=>{const row=store.db.prepare('SELECT pages FROM page_ownership WHERE workspaceId=?').get(w) as {pages:string}|undefined;return row?JSON.parse(row.pages):[];},(w,pages)=>{store.db.prepare('INSERT OR REPLACE INTO page_ownership VALUES(?,?)').run(w,JSON.stringify(pages));});
 const refreshPages=async(w:string)=>{const result=await browserCdp(w,'Target.getTargets');const targets=(result.targetInfos??[]).filter((t:any)=>t.type==='page');for(const old of ownership.pages(w))if(!targets.some((t:any)=>t.targetId===old.targetId))ownership.closed(w,old.targetId,old.generation);for(const t of targets)if(!ownership.pages(w).some(p=>p.targetId===t.targetId))ownership.opened(w,t.targetId,t.openerId);return ownership.pages(w).map(page=>({...page,owner:page.connectionId??page.reconnectId??null}));};
 const leaseIds=new Map<string,string>();
 const sessions=new Map<string,{owner:string;workspace:string;connection:Awaited<ReturnType<typeof createStreamableMcp>>}>();
 const controlHealth=async(w:string)=>{
  const ip=await privateBrowserAddress(w);const [utility]=JSON.parse(await hostRun(runtime(),['inspect',workspaceName(w)+'-utility']));await validateUtilityIsolation(utility,w);
  await hostRun(runtime(),['exec',workspaceName(w)+'-browser','/usr/local/bin/healthcheck.sh']);
  await hostRun(runtime(),['exec',workspaceName(w)+'-browser','unshare','-Ur','true']);
  const response=await fetch(`http://${ip}:9223/json/version`,{signal:AbortSignal.timeout(3000),redirect:'error'});if(!response.ok)throw Error('CDP unhealthy');
  const upstream=await connectChromeMcp({executable:process.env.BUK_MCP_EXECUTABLE??resolve('node_modules/.bin/chrome-devtools-mcp'),version:MCP_VERSION,browserUrl:`http://${ip}:9223`});try{const tools=await upstream.listTools();if(!tools.tools.some(t=>t.name==='list_pages'))throw Error('MCP unsupported');}finally{await upstream.close();}
  await files(w);store.audit(w,'health.checked','system','Chrome/display/VNC/CDP/MCP/utility/egress/storage readiness checked');
  // Prove the installed gate rejects a forged key, not just that the class loads.
  let forwarded=false;const gate=new RfbInputGate({workspaceId:w,connectionId:'probe',subject:'probe',reconnectId:'probe',permissions:[]},()=>{},()=>{throw Error('deny');},()=>{forwarded=true;},true);gate.push(Buffer.from([4,1,0,0,0,0,0,65]));gate.close();if(forwarded)throw Error('Input gate unsafe');
 };
 const services:ServerServices={
 authenticate:token=>{const p=auth.authenticate(token);const row=store.db.prepare('SELECT reconnectId FROM agent_reconnect WHERE credentialId=?').get(p.id);return {...p,reconnectId:row?String(row.reconnectId):p.id};},
 login:(u,p,address)=>{const result=auth.login(u,p,address);return {token:result.token,csrf:result.csrf!};},
 bootstrap:(u,p)=>auth.bootstrap(u,p),
 revoke:(p,id)=>{if(id!==p.id){const target=store.db.prepare('SELECT workspaceId FROM credentials WHERE id=?').get(id) as {workspaceId:string|null}|undefined;if(!target)throw Error('Unknown credential');auth.authorize(p as AuthPrincipal,'workspace:manage',target.workspaceId??undefined);if(target.workspaceId===null)auth.authorize(p as AuthPrincipal,'*');}auth.revoke(id,p.subject);return {ok:true};},
 issue:(p,b)=>{const w=typeof b.workspaceId==='string'?b.workspaceId:null;const permissions=Array.isArray(b.permissions)?b.permissions:[];if(!w||!store.workspace(w)||permissions.some(x=>typeof x!=='string'||(!p.permissions.includes('*')&&!p.permissions.includes(x))))throw Error('Invalid token scope');let reconnectId:string=randomUUID();if(b.reconnectId!==undefined){if(typeof b.reconnectId!=='string'||!store.db.prepare('SELECT 1 FROM agent_reconnect WHERE reconnectId=? AND subject=? AND workspaceId=?').get(b.reconnectId,p.subject,w))throw Error('Invalid reconnect identity');reconnectId=b.reconnectId;}const issued=auth.issueFor(p as AuthPrincipal,w,permissions,{ttlMs:900000});store.db.prepare('INSERT INTO agent_reconnect VALUES(?,?,?,?)').run(issued.id,reconnectId,p.subject,w);return {...issued,reconnectId};},
 list:p=>store.listWorkspaces().filter(w=>(!p.workspaceId||p.workspaceId===w.id)&&(p.permissions.includes('*')||w.ownerId===p.subject)),
 create:(p,b)=>{auth.authorize(p as AuthPrincipal,'workspace:manage');return lifecycle.create(String(b.name??''),p.subject);},
 workspace:id=>store.workspace(id),
 async operation(name,w,p,body,req,res){
  const credential=p as AuthPrincipal; const workspace=store.workspace(w)!;
  if(!p.permissions.includes('*')&&!p.workspaceId&&workspace.ownerId!==p.subject)throw Error('Workspace access denied');
  const principal=asPrincipal(p,w);if(!['inspect','health','events','pages','screenshots','tokens','viewer','commands','commandStatus'].includes(name))store.touch(w);
  if(name==='inspect')return {...workspace,warning:SHARED_PROFILE_WARNING};
  if(name==='health')return {state:workspace.state,diagnostic:workspace.diagnostic};
  if(['start','stop','restart','delete'].includes(name)){auth.authorize(credential,'workspace:manage',w);return lifecycle[name as 'start'|'stop'|'restart'|'delete'](w);}
  if(name==='events'){const after=Number(req.query.after??0);if(!Number.isSafeInteger(after)||after<0)throw Error('Invalid cursor');return store.events(w,after);}
  if(name==='status'){const allowed=['task_started','status','decision','waiting_for_human','task_completed','task_failed'];if(!allowed.includes(body.type))throw Error('Invalid event');return {id:store.audit(w,'agent.'+body.type,p.subject,'Agent-authored claim: '+String(body.summary??'').replace(/[\r\n]/g,' ').slice(0,512))};}
  if(name==='acquire:automation'){const lease=leases.acquireAutomation(principal);leaseIds.set(`${w}:${p.id}:automation`,lease.id);return {...lease,expiresAt:Date.now()+60000};}
  if(name==='renew:automation'){const lease=leases.renewAutomation(principal,String(body?.id??leaseIds.get(`${w}:${p.id}:automation`)));return {...lease,expiresAt:Date.now()+60000};}
  if(name==='acquire:human'){const lease=await leases.acquireHuman(principal);leaseIds.set(`${w}:${p.id}:human`,lease.id);keepAlive.set(w,Date.now()+30000);return {...lease,expiresAt:Date.now()+30000};}
  if(name==='renew:human'){const lease=leases.renewHuman(principal,String(body?.id??leaseIds.get(`${w}:${p.id}:human`)));keepAlive.set(w,Date.now()+30000);return {...lease,expiresAt:Date.now()+30000};}
  if(name.startsWith('release:')){leases.release(principal);if(name==='release:human')keepAlive.delete(w);return {ok:true};}
  if(name==='mcp'){
   auth.authorize(credential,'automation',w);if(workspace.state!=='ready')throw Error('Workspace not ready');
   const sid=req.headers['mcp-session-id']; if(Array.isArray(sid))throw Error('Invalid session');let session=sid?sessions.get(sid):undefined;
   if(session&&(session.owner!==p.id||session.workspace!==w))throw Error('Session identity mismatch');
   if(!session){if(sid||req.method!=='POST')throw Error('Session not found');const browserUrl=`http://${await privateBrowserAddress(w)}:9223`;
    const upstream=await connectChromeMcp({executable:process.env.BUK_MCP_EXECUTABLE??resolve('node_modules/.bin/chrome-devtools-mcp'),version:MCP_VERSION,browserUrl});
    try{ownership.reconnect(principal);const pages=await refreshPages(w);if(!pages.some(page=>page.connectionId===p.id)){let page=pages.find(page=>!page.reconnectId);if(!page){const created=await browserCdp(w,'Target.createTarget',{url:'about:blank'});ownership.opened(w,created.targetId);page=ownership.pages(w).find(page=>page.targetId===created.targetId) as any;}if(page)ownership.claim(principal,page.targetId);}}catch(e){await upstream.close();throw e;}
    const gateway=new McpGateway({principal,leases,validate,audit:(a,b,c,d)=>{store.audit(a,b,c,d);},upstream:upstream as any,validateUpload:async()=>{throw Error('Upload mount routing unavailable');}});
    session={owner:p.id,workspace:w,connection:await createStreamableMcp(gateway)};
   }
   await session.connection.transport.handleRequest(req,res,req.body);const id=session.connection.transport.sessionId;if(id)sessions.set(id,session);if(req.method==='DELETE'&&id){await session.connection.close();sessions.delete(id);}return;
  }
  if(name==='keepAlive'){leases.assertAutomation(principal);store.audit(w,'keepalive.renewed',p.subject,'Task keepalive 60 seconds');keepAlive.set(w,Date.now()+60000);return {expiresAt:Date.now()+60000};}
  if(name==='releaseKeepAlive'){keepAlive.delete(w);return {ok:true};}
  const actor:FileActor={workspaceId:w,agentId:p.subject,connectionId:p.id};
  const path=typeof req.query.path==='string'?req.query.path:'';
  if(['listFiles','quota','download','upload','deleteFile'].includes(name)){
   const service=await files(w);active.set(w,(active.get(w)??0)+1);try{
    if(name==='listFiles')return service.list(actor,path);if(name==='quota')return service.quota(actor);
    if(name==='deleteFile'){await service.delete(actor,path);return {ok:true};}
    const abort=new AbortController();req.once('aborted',()=>abort.abort());
    if(name==='upload'){if(req.headers['content-type']!=='application/octet-stream')throw Object.assign(Error('Binary upload required'),{status:415});let settled!:()=>void;const done=new Promise<void>(r=>{settled=r;});const end=leases.beginMutation(principal,async()=>{abort.abort();await done;});try{return await service.upload(actor,path,req,{signal:abort.signal});}finally{end();settled();}}
    res.set({'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="download"'});for await(const chunk of service.download(actor,path,{signal:abort.signal})){if(!res.write(chunk))await once(res,'drain');}res.end();return;
   }finally{active.set(w,Math.max(0,(active.get(w)??1)-1));}
  }
  if(['command','commands','commandStatus','cancelCommand'].includes(name)){
   const service=commands(w);const id=String(req.params.commandId??'');
   if(name==='commands')return service.list(actor);if(name==='commandStatus')return service.inspect(actor,id);if(name==='cancelCommand'){await service.cancel(actor,id);return {ok:true};}
   const end=leases.beginMutation(principal,async()=>{await service.cancelAll();});active.set(w,(active.get(w)??0)+1);
   try{const result=await service.start(actor,body);void service.wait(actor,result.id).catch(()=>{}).finally(()=>{end();active.set(w,Math.max(0,(active.get(w)??1)-1));});return result;}catch(e){end();active.set(w,Math.max(0,(active.get(w)??1)-1));throw e;}
  }
  if(name==='viewer')return {url:`/api/workspaces/${w}/viewer/ws`,warning:SHARED_PROFILE_WARNING};
  if(name==='screenshots')return {enabled:false,captureEnabled:false,artifacts:[],reason:'Optional content capture is disabled; mandatory security audit remains enabled.'};
  if(name==='pages'){if(workspace.state!=='ready')return {pages:ownership.pages(w),warning:SHARED_PROFILE_WARNING,stale:true};return {pages:await refreshPages(w),warning:SHARED_PROFILE_WARNING};}
  if(name==='claimPage'){leases.assertAutomation(principal);await refreshPages(w);ownership.claim(principal,String(body.targetId));return {pages:ownership.pages(w)};}
  if(name==='transferPage'){await refreshPages(w);const owner=body?.owner?principals.get(String(body.owner)):undefined;if(body?.owner&&!owner)throw Error('Unknown owner');if(owner)auth.authorize(owner,'automation',w);ownership.transfer(principal,String(req.params.pageId),owner?asPrincipal(owner,w):undefined);return {pages:ownership.pages(w)};}
  if(name==='tokens'){auth.authorize(credential,'workspace:manage',w);return store.db.prepare('SELECT id,subject,expiresAt,revoked FROM credentials WHERE workspaceId=?').all(w);}
  if(name==='issueToken')return services.issue(p,{...body,workspaceId:w});
  if(name==='revokeToken'){auth.authorize(credential,'workspace:manage',w);const row=store.db.prepare('SELECT workspaceId FROM credentials WHERE id=?').get(String(req.params.tokenId));if(row?.workspaceId!==w)throw Error('Wrong workspace');return services.revoke(p,String(req.params.tokenId));}
  if(name==='emergencyStop'){auth.authorize(credential,'takeover',w);store.audit(w,'operator.emergency_stop',p.subject,'Workspace stopping and credentials revoked');leases.release(principal);auth.revokeWorkspace(w);return lifecycle.stop(w);}
  const error=new Error('Configured isolated service unavailable');Object.assign(error,{status:503});throw error;
 }
 };
 const timer=setInterval(()=>{for(const [id,s] of sessions){try{const p=principals.get(s.owner);if(!p)throw Error();auth.authorize(p,'automation',s.workspace);}catch{const credential=principals.get(s.owner);if(credential){try{ownership.disconnect(asPrincipal(credential,s.workspace));}catch{/* Audit failure still closes the connection. */}}void s.connection.close();sessions.delete(id);}}},1000);timer.unref();
 return {services,store,auth,leases,lifecycle,principals,controlHealth,close:async()=>{clearInterval(timer);lifecycle.close();for(const s of sessions.values())await s.connection.close();store.close();}};
}

export function attachViewer(server:ReturnType<typeof createHttpServer>,context:ReturnType<typeof defaultServices>,options:ServerOptions){
 const sockets=new WebSocketServer({noServer:true,maxPayload:1024*1024});
 server.on('upgrade',async(req,socket,head)=>{try{
  if(!req.headers.host||!options.hosts.includes(req.headers.host))throw Error();
  const match=/^\/api\/workspaces\/([a-zA-Z0-9-]+)\/viewer(?:\/ws)?$/.exec(req.url??'');if(!match)throw Error();
  if(req.headers.origin&&req.headers.origin!==`${options.secure?'https':'http'}://${req.headers.host}`)throw Error();
  const token=req.headers.authorization?.replace(/^Bearer /,'')??cookie(req as Request);if(!token)throw Error();const p=context.auth.authenticate(token);context.auth.authorize(p,'view',match[1]);
  const ip=await privateBrowserAddress(match[1]);context.auth.authorize(p,'view',match[1]);
  const workspace=context.store.workspace(match[1]);if(!workspace||workspace.state!=='ready'||(!p.permissions.includes('*')&&!p.workspaceId&&workspace.ownerId!==p.subject))throw Error('Workspace unavailable');
  context.principals.set(p.id,p);const principal:Principal={workspaceId:match[1],subject:p.subject,connectionId:p.id,reconnectId:p.subject,permissions:p.permissions.includes('*')?[...PERMISSIONS]:p.permissions};
  sockets.handleUpgrade(req,socket,head,ws=>{const tcp=connect({host:ip,port:5900});let connected=false;const gate=new RfbInputGate(principal,()=>context.auth.authorize(p,'view',match[1]),(_p,clipboard)=>{context.auth.authorize(p,'takeover',match[1]);context.leases.assertHuman(principal);if(clipboard)context.auth.authorize(p,'clipboard',match[1]);},data=>{if(!connected||tcp.writableLength>1024*1024)throw Error('Viewer backpressure');tcp.write(data);});
   const close=()=>{clearInterval(timer);gate.close();tcp.destroy();ws.close();};const timer=setInterval(()=>{try{context.auth.authorize(p,'view',match[1]);}catch{close();}},1000);
   tcp.on('connect',()=>{connected=true;});tcp.on('data',data=>{if(ws.bufferedAmount>1024*1024){close();return;}ws.send(data,{binary:true});});tcp.on('error',close);tcp.on('close',close);ws.on('close',()=>{clearInterval(timer);gate.close();tcp.destroy();});ws.on('error',close);ws.on('message',(data,binary)=>{try{if(!binary)throw Error();gate.push(Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer));}catch{close();}});
  });
 }catch{socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy();}});return sockets;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  // The composition root is loaded only by the CLI; createApp remains independently testable.
  const entry=process.env.BUK_COMPOSITION_MODULE;
  {const context=entry?undefined:defaultServices();const {services,options}=entry?await import(pathToFileURL(resolve(entry)).href):{services:context!.services,options:{hosts:(process.env.BUK_HOSTS??'localhost:3000,127.0.0.1:3000').split(','),secure:process.env.BUK_SECURE==='1'}};if(process.argv[2]==='control-health'){if(!context)throw Error('Built-in deployment required');await context.controlHealth(process.argv[3]??'');await context.close();}else if(process.argv[2]==='bootstrap'){if(!services.bootstrap)throw new Error('Bootstrap unavailable');const password=process.env.BUK_ADMIN_PASSWORD;if(!password)throw new Error('BUK_ADMIN_PASSWORD required');await services.bootstrap(process.argv[3]??'admin',password);}else{const host=process.env.BUK_BIND??'127.0.0.1';if(!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Direct non-loopback HTTP forbidden; use a local TLS gateway');const server=createHttpServer(services,options);if(context){attachViewer(server,context,options);await context.lifecycle.reconcile();context.lifecycle.monitor();}server.listen(Number(process.env.PORT??3000),host);}}
}
