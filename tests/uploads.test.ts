import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { FileService } from '../src/files.js';
import * as uploads from '../src/uploads.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';
import { WebSocket } from 'ws';
import { once } from 'node:events';

async function fixture(t:any) {
 const root=await mkdtemp(join(tmpdir(),'buk-upload-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'files'));await mkdir(join(root,'files','input'));await mkdir(join(root,'staging'),{mode:0o700});
 const actor={workspaceId:'one',agentId:'agent',connectionId:'connection'};
 const files=new FileService({workspaceId:'one',root:join(root,'files'),staging:join(root,'staging'),authorize:()=>{},validateLease:()=>{},audit:()=>{}});
 return {root,actor,files};
}
test('browser upload snapshots approved bytes outside utility mounts and removes temporary copies',async t=>{
 const {root,actor,files}=await fixture(t);await writeFile(join(root,'files/input/paper.pdf'),'%PDF-approved');
 const calls:string[][]=[];let local='';
 const run=async(_file:string,args:string[])=>{calls.push(args);if(args[0]==='cp'){
  local=args[1];assert.equal(await readFile(local,'utf8'),'%PDF-approved');assert.equal((await stat(dirname(local))).mode&0o777,0o700);
  await writeFile(join(root,'files/input/paper.pdf'),'changed after snapshot');
 }return '';};
 const upload=await uploads.prepareBrowserUpload(files,actor,'/workspace/input/paper.pdf',{runtime:'podman',run});
 assert.match(upload.path,/^\/tmp\/buk-upload-[a-f0-9-]+\/paper\.pdf$/);assert.ok(!upload.path.startsWith('/workspace'));
 await assert.rejects(stat(local));assert.equal(calls[1][2],`buk-one-browser:${upload.path}`);
 await upload.cleanup();assert.deepEqual(calls[2].slice(-3),['rm','-rf',dirname(upload.path)]);
});
test('browser uploads reject traversal, symlinks and revoked file authority before runtime access',async t=>{
 const {root,actor,files}=await fixture(t);await writeFile(join(root,'secret'),'secret');await symlink(join(root,'secret'),join(root,'files/input/escape'));
 let calls=0;const options={runtime:'podman' as const,run:async()=>{calls++;return '';}};
 for(const path of ['../secret','/etc/passwd','input/escape'])await assert.rejects(uploads.prepareBrowserUpload(files,actor,path,options));
 assert.equal(calls,0);
 const denied=new FileService({workspaceId:'one',root:join(root,'files'),staging:join(root,'staging'),authorize:()=>{throw Error('revoked');},validateLease:()=>{},audit:()=>{}});
 await assert.rejects(uploads.prepareBrowserUpload(denied,actor,'input/escape',options),/revoked/);assert.equal(calls,0);
});
test('browser copy failures remove remote temporary directory',async t=>{
 const {root,actor,files}=await fixture(t);await writeFile(join(root,'files/input/a'),'data');const calls:string[][]=[];
 await assert.rejects(uploads.prepareBrowserUpload(files,actor,'input/a',{runtime:'podman',run:async(_file,args)=>{calls.push(args);if(args[0]==='cp')throw Error('copy failed');return '';}}),/copy failed/);
 assert.equal(calls.length,3);assert.deepEqual(calls[2].slice(-3),['rm','-rf',dirname(calls[1][2].split(':')[1])]);await assert.rejects(stat(calls[1][1]));
});

test('live OCI copy is readable by browser UID and cleaned without utility-volume access',{skip:process.env.BUK_LIVE_UPLOAD!=='1',timeout:30000},async t=>{
 const {root}=await fixture(t);const runtime=process.env.OCI_RUNTIME==='docker'?'docker':'podman';const run=async(file:string,args:string[])=>String((await promisify(execFile)(file,args,{timeout:10000})).stdout);
 const workspaceId='upload-'+randomUUID(),container=`buk-${workspaceId}-browser`,actor={workspaceId,agentId:'agent',connectionId:'connection'};
 const files=new FileService({workspaceId,root:join(root,'files'),staging:join(root,'staging'),authorize:()=>{},validateLease:()=>{},audit:()=>{}});
 await writeFile(join(root,'files/input/paper.pdf'),'%PDF-approved');
 try{
  await run(runtime,['run','--rm','-d','--name',container,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=16m','--entrypoint','/bin/sh',process.env.BUK_BROWSER_IMAGE??'localhost/browseruse-browser:local','-c','sleep 30']);
  const upload=await uploads.prepareBrowserUpload(files,actor,'input/paper.pdf',{runtime,run});
  try{assert.equal(await run(runtime,['exec','--user','1000:1000',container,'cat',upload.path]),'%PDF-approved');}finally{await upload.cleanup();}
  await assert.rejects(run(runtime,['exec','--user','1000:1000',container,'test','-e',upload.path]));
 }finally{await run(runtime,['rm','-f',container]).catch(()=>{});}
});

test('live sandboxed browser selects protected PDF snapshot with no published CDP ports', {skip:process.env.BUK_LIVE_UPLOAD!=='1',timeout:45000},async t=>{
 const {root,files}=await fixture(t);const runtime=process.env.OCI_RUNTIME==='docker'?'docker':'podman';
 const run=async(file:string,args:string[])=>String((await promisify(execFile)(file,args,{timeout:15000,maxBuffer:1024*1024})).stdout);
 const workspaceId='upload-'+randomUUID(),container=`buk-${workspaceId}-browser`;const actor={workspaceId,agentId:'agent',connectionId:'connection'};
 const scopedFiles=new FileService({workspaceId,root:join(root,'files'),staging:join(root,'staging'),authorize:()=>{},validateLease:()=>{},audit:()=>{}});
 await writeFile(join(root,'files/input/paper.pdf'),'%PDF-1.7 approved snapshot');
 try{
  await run(runtime,['run','-d','--name',container,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--shm-size','256m','--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=256m','--tmpfs','/profile:rw,mode=1777,size=64m','--tmpfs','/workspace:rw,mode=1777,size=16m','--tmpfs','/home/browser:rw,mode=1777,size=64m',process.env.BUK_BROWSER_IMAGE??'localhost/browseruse-browser:local']);
  await run(runtime,['exec',container,'touch','/tmp/network-ready']);
  let pages:any[]=[];const deadline=Date.now()+20000;
  while(!pages.length){try{pages=JSON.parse(await run(runtime,['exec',container,'curl','-fsS','--max-time','1','http://127.0.0.1:9222/json/list']));}catch{if(Date.now()>=deadline){const logs=await promisify(execFile)(runtime,['logs',container]);throw Error('Sandboxed Chrome startup unavailable: '+logs.stdout+logs.stderr);}await new Promise(r=>setTimeout(r,100));}}
  const relay=spawn(runtime,['exec','-i',container,'socat','STDIO','TCP:127.0.0.1:9222'],{stdio:['pipe','pipe','pipe']});
  const socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl,{createConnection:()=>Duplex.from({readable:relay.stdout,writable:relay.stdin}) as any});
  let id=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  socket.on('message',raw=>{const data=JSON.parse(raw.toString());const p=pending.get(data.id);if(p){pending.delete(data.id);clearTimeout(p.timer);data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result);}});
  const cdp=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const serial=++id;const timer=setTimeout(()=>{pending.delete(serial);reject(Error('CDP test deadline'));},5000);pending.set(serial,{resolve,reject,timer});socket.send(JSON.stringify({id:serial,method,params}));});
  try{
   await once(socket,'open');await cdp('Runtime.evaluate',{expression:"document.body.innerHTML='<input id=f type=file>'"});
   const upload=await uploads.prepareBrowserUpload(scopedFiles,actor,'/workspace/input/paper.pdf',{runtime,run});
   try{
    await writeFile(join(root,'files/input/paper.pdf'),'replacement after snapshot');
    const {root:document}=await cdp('DOM.getDocument');const {nodeId}=await cdp('DOM.querySelector',{nodeId:document.nodeId,selector:'#f'});
    await cdp('DOM.setFileInputFiles',{nodeId,files:[upload.path]});
    const result=await cdp('Runtime.evaluate',{expression:"(async()=>({name:f.files[0].name,text:await f.files[0].text()}))()",awaitPromise:true,returnByValue:true});
    assert.deepEqual(result.result.value,{name:'paper.pdf',text:'%PDF-1.7 approved snapshot'});
   }finally{await upload.cleanup();}
   const [inspection]=JSON.parse(await run(runtime,['inspect',container]));assert.deepEqual(inspection.HostConfig.PortBindings??{},{});t.diagnostic('browser image '+inspection.Image);
  }finally{socket.terminate();relay.kill();for(const p of pending.values())clearTimeout(p.timer);}
 }finally{await run(runtime,['rm','-f',container]).catch(()=>{});}
});
