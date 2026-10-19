import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
async function fetch(url:string,init:{method?:string;headers?:Record<string,string>;body?:string}={}){return new Promise<{status:number;json:()=>Promise<any>;headers:{get:(name:string)=>string|null}}>((resolve,reject)=>{const req=request(url,{method:init.method,headers:init.headers},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode!,json:async()=>JSON.parse(Buffer.concat(chunks).toString()),headers:{get(name){const v=res.headers[name];return Array.isArray(v)?v.join('; '):v??null;}}}));});req.on('error',reject);req.end(init.body);});}
import { createHttpServer, defaultServices, privateBrowserAddress, validateUtilityIsolation, type HostRunner, type ServerServices } from '../src/server.js';
import { Store } from '../src/core.js';
const identity={id:'credential',subject:'owner',workspaceId:'one',permissions:['view'],csrf:'secret'};
async function fixture(run:(base:string)=>Promise<void>){
 const services:ServerServices={authenticate(token){if(token!=='valid')throw Error();return identity;},login(){return {token:'valid',csrf:'secret'};},revoke(){return {};},issue(){return {};},list(){return [];},create(){return {};},workspace(){return {id:'one'};},operation(name){return {operation:name};}};
 const server=createHttpServer(services,{hosts:['workspace.test']});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address!=='string');try{await run(`http://127.0.0.1:${address.port}`);}finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}
test('HTTP boundaries deny unknown hosts unauthenticated access wrong scope and viewer mutation',async()=>fixture(async base=>{
 assert.equal((await fetch(base+'/health')).status,421);
 const headers={host:'workspace.test'};
 assert.equal((await fetch(base+'/api/workspaces',{headers})).status,401);
 const auth={...headers,authorization:'Bearer valid'};
 assert.equal((await fetch(base+'/api/workspaces/other',{headers:auth})).status,403);
 assert.equal((await fetch(base+'/api/workspaces/one/start',{method:'POST',headers:auth})).status,403);
 assert.deepEqual(await (await fetch(base+'/api/workspaces/one',{headers:auth})).json(),{operation:'inspect'});
}));
test('composition bootstrap durable credentials workspace creation and revocation',async()=>{
 const context=defaultServices(new Store(':memory:'));try{
 context.services.bootstrap!('admin','a-long-password-123');assert.throws(()=>context.services.bootstrap!('another','a-long-password-123'));
 const login=await context.services.login('admin','a-long-password-123','local');const p=context.services.authenticate(login.token);
 const workspace=await context.services.create(p,{name:'integration'}) as {id:string};assert.ok(workspace.id);
 const token=await context.services.issue(p,{workspaceId:workspace.id,permissions:['view']}) as {token:string;id:string};assert.equal(context.services.authenticate(token.token).workspaceId,workspace.id);
 context.services.revoke(p,token.id);assert.throws(()=>context.services.authenticate(token.token));
 }finally{await context.close();}
});
test('private routing uses inspected workspace network and rejects exposed or mixed networks',async()=>{
 const c={State:{Running:true},Config:{Labels:{'browseruse.workspace':'one'}},HostConfig:{PortBindings:{}},NetworkSettings:{Networks:{'buk-one-browser':{IPAddress:'10.90.0.2'}}}};
 const run:HostRunner=async(file,args)=>{assert.ok(['docker','podman'].includes(file));assert.deepEqual(args,['inspect','buk-one-browser']);return JSON.stringify([c]);};
 assert.equal(await privateBrowserAddress('one',run),'10.90.0.2');c.HostConfig.PortBindings={'9223/tcp':[]} as any;await assert.rejects(privateBrowserAddress('one',run));c.HostConfig.PortBindings={};(c.NetworkSettings.Networks as any).other={IPAddress:'10.90.1.2'};await assert.rejects(privateBrowserAddress('one',run));await assert.rejects(privateBrowserAddress('../escape',run));
});
test('utility verification checks live IPv4/IPv6 firewall and rejects bypasses',async()=>{
 const c={State:{Running:true,Pid:123},Config:{User:'1000:1000',Labels:{'browseruse.workspace':'one'},Env:[]},HostConfig:{CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],ReadonlyRootfs:true,Memory:100,PidsLimit:100,NanoCpus:100,PortBindings:{}},Mounts:[{Type:'volume',Name:'buk-one-files',Destination:'/workspace'}],NetworkSettings:{Networks:{'buk-one-utility':{IPAddress:'10.91.0.3'}}}};
 let bypass=false;const run:HostRunner=async(file,args)=>{if(file==='nsenter')return '-P OUTPUT DROP\n-A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n-A OUTPUT -o lo -j ACCEPT\n'+(args.includes('iptables')?'-A OUTPUT -d 10.91.0.2/32 -p tcp -m tcp --dport 3128 -j ACCEPT\n':'')+(bypass?'-A OUTPUT -j ACCEPT\n':'');return JSON.stringify([{State:{Running:true},NetworkSettings:{Networks:{'buk-one-utility':{IPAddress:'10.91.0.2'}}}}]);};
 await validateUtilityIsolation(c,'one',run);bypass=true;await assert.rejects(validateUtilityIsolation(c,'one',run));bypass=false;c.Config.User='10002:10002';await assert.rejects(validateUtilityIsolation(c,'one',run));
});
test('cookie mutations require CSRF; login cookie is host-only HttpOnly SameSite',async()=>fixture(async base=>{
 const headers={host:'workspace.test','content-type':'application/json'};
 const login=await fetch(base+'/api/login',{method:'POST',headers,body:JSON.stringify({username:'admin',password:'password'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.doesNotMatch(cookie,/Domain=/);
 assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{host:'workspace.test',cookie:'buk_session=valid'}})).status,403);
 assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{host:'workspace.test',cookie:'buk_session=valid',authorization:'Basic forged'}})).status,403);
 assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{host:'workspace.test',cookie:'buk_session=valid','x-csrf-token':'secret'}})).status,200);
}));

test('public delegation enforces ownership, workspace scope and issuer expiry',async()=>{
 const context=defaultServices(new Store(':memory:'));try{
 const owner=context.auth.bootstrap('admin','a-long-password-123');
 const one=context.lifecycle.create('one',owner),other=context.lifecycle.create('other','someone-else');
 const issued=context.auth.issue(owner,null,['workspace:manage','view'],{ttlMs:60000});
 const p=context.services.authenticate(issued.token);
 assert.throws(()=>context.services.issue(p,{workspaceId:other.id,permissions:['view']}));
 const scoped=context.auth.issue(owner,one.id,['workspace:manage','view'],{ttlMs:60000});
 const delegate=context.services.issue(context.services.authenticate(scoped.token),{workspaceId:one.id,permissions:['view']}) as {token:string;expiresAt:number};
 assert.ok(delegate.expiresAt<=scoped.expiresAt);
 assert.equal(context.services.authenticate(delegate.token).workspaceId,one.id);
 assert.throws(()=>context.services.issue(context.services.authenticate(scoped.token),{workspaceId:other.id,permissions:['view']}));
 }finally{await context.close();}
});
