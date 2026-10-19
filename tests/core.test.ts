import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core.js';
import { Auth, assertHost, hashPassword, verifyPassword, sessionCookie } from '../src/auth.js';
import { Lifecycle, OciDeployment, type Deployment } from '../src/lifecycle.js';

test('durable workspaces, events, credentials, revocation and atomic audit failure',()=>{
 const dir=mkdtempSync(join(tmpdir(),'buk-core-'));let s=new Store(join(dir,'db.sqlite'));
 try{const w=s.createWorkspace('test','owner');const auth=new Auth(s);const c=auth.issue('agent',w.id,['view']);s.close();s=new Store(join(dir,'db.sqlite'));assert.equal(s.workspace(w.id)?.profileVolume,w.profileVolume);const a=new Auth(s),p=a.authenticate(c.token);a.authorize(p,'view',w.id);assert.throws(()=>a.authorize(p,'shell',w.id));assert.throws(()=>a.authorize(p,'view','other'));a.revoke(c.id);assert.throws(()=>a.authenticate(c.token));assert.throws(()=>a.authorize(p,'view',w.id));
 s.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'disk full'); END");assert.throws(()=>s.createWorkspace('blocked','owner'));assert.throws(()=>a.issue('agent',w.id,['view']));assert.equal(s.listWorkspaces().length,1);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('salted scrypt bootstrap, login, CSRF, exact host, cookie and idle session validation',()=>{
 const s=new Store(':memory:');try{const a=new Auth(s);a.bootstrap('admin','correct horse battery staple');assert.throws(()=>a.bootstrap('other','correct horse battery staple'));const x=hashPassword('correct horse battery staple'),y=hashPassword('correct horse battery staple');assert.notEqual(x,y);assert(verifyPassword('correct horse battery staple',x));assert(!verifyPassword('wrong',x));assert.throws(()=>a.login('admin','wrong','client'));assert.throws(()=>a.login('admin','correct horse battery staple','client'));const c=a.login('admin','correct horse battery staple','other-client');const p=a.authenticate(c.token);assert.throws(()=>a.csrf(p,undefined));a.csrf(p,c.csrf!);a.authorize(p,'workspace:manage');assertHost('localhost:3000',['localhost:3000']);assert.throws(()=>assertHost('localhost:3000.evil',['localhost:3000']));assert.throws(()=>assertHost('localhost:3000@evil',['localhost:3000']));assert(sessionCookie(c.token).includes('; Secure;'));assert(!sessionCookie(c.token).includes('Domain='));s.db.prepare('UPDATE credentials SET lastActivity=0 WHERE id=?').run(c.id);assert.throws(()=>a.authenticate(c.token));assert.throws(()=>a.authorize(p,'view'));}finally{s.close();}
});
test('workspace ownership and delegated token issuance use durable authority',()=>{
 const s=new Store(':memory:');try{const a=new Auth(s),w=s.createWorkspace('owned','alice');const c=a.issue('bob',null,['view','workspace:manage']);const p=a.authenticate(c.token);assert.throws(()=>a.authorize(p,'view',w.id));p.permissions.push('*');assert.throws(()=>a.issueFor(p,w.id,['view']));const owner=a.authenticate(a.issue('alice',null,['view','workspace:manage']).token);assert.throws(()=>a.issueFor(owner,w.id,['shell']));const scoped=a.issueFor(owner,w.id,['view']);a.authorize(a.authenticate(scoped.token),'view',w.id);s.setState(w.id,'deleting','deleted');assert.throws(()=>a.authorize(a.authenticate(scoped.token),'view',w.id));}finally{s.close();}
});
test('delegated issuance throttles by durable subject across credentials and audits denials',()=>{
 const s=new Store(':memory:');try{
  let now=Date.now();const original=Date.now;Date.now=()=>now;
  try{const a=new Auth(s),w=s.createWorkspace('rate','owner');const p=a.authenticate(a.issue('owner',null,['*']).token);
   for(let i=0;i<20;i++)a.issueFor(p,w.id,['view']);
   const before=Number(s.db.prepare('SELECT COUNT(*) n FROM credentials').get()!.n);
   assert.throws(()=>a.issueFor(p,w.id,['view']),/temporarily unavailable/);
   assert.equal(Number(s.db.prepare('SELECT COUNT(*) n FROM credentials').get()!.n),before);
   const other=new Auth(s).authenticate(a.issue('owner',null,['*']).token);
   assert.throws(()=>new Auth(s).issueFor(other,w.id,['view']),/temporarily unavailable/);
   assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='auth.issue_limited'").get()!.n,2);
   now+=60001;a.issueFor(other,w.id,['view']);
  }finally{Date.now=original;}
 }finally{s.close();}
});
test('human leases and tracked requests prevent idle shutdown, stale holds expire',async()=>{
 const s=new Store(':memory:');try{const f=fake();let human:{expiresAt:number}|undefined={expiresAt:Date.now()+30000};const l=new Lifecycle(s,f.d,{humanLease:()=>human});await l.reconcile();const w=l.create('test','owner',1);await l.start(w.id);s.db.prepare('UPDATE workspaces SET lastActivity=0 WHERE id=?').run(w.id);await l.tick();assert.equal(s.workspace(w.id)?.state,'ready');human=undefined;const end=l.beginOperation(w.id);s.db.prepare('UPDATE workspaces SET lastActivity=0 WHERE id=?').run(w.id);await l.tick();assert.equal(s.workspace(w.id)?.state,'ready');end();l.holdActivity(w.id,'task',Date.now()+30000);s.db.prepare('UPDATE workspaces SET lastActivity=0 WHERE id=?').run(w.id);await l.tick();assert.equal(s.workspace(w.id)?.state,'ready');l.releaseActivity(w.id,'task');s.db.prepare('UPDATE workspaces SET lastActivity=0 WHERE id=?').run(w.id);await l.tick();assert.equal(s.workspace(w.id)?.state,'stopped');}finally{s.close();}
});
test('operation gate requires reconciliation; stop cancels and drains before runtime exit',async()=>{
 const s=new Store(':memory:');try{const f=fake(),l=new Lifecycle(s,f.d,{drainMs:30});const w=l.create('test','owner');await l.start(w.id);assert.throws(()=>l.beginOperation(w.id));await l.reconcile();let end!:()=>void;end=l.beginOperation(w.id,()=>end());await l.stop(w.id);assert.equal(s.workspace(w.id)?.state,'stopped');assert.throws(()=>l.beginOperation(w.id));await l.start(w.id);const stuck=l.beginOperation(w.id);const stops=f.calls.filter(x=>x==='stop').length;await assert.rejects(l.stop(w.id),/drain/);assert.equal(f.calls.filter(x=>x==='stop').length,stops);assert.equal(s.workspace(w.id)?.state,'failed');stuck();}finally{s.close();}
});
test('reconciliation closes admission and concurrent lifecycle operations',async()=>{
 const s=new Store(':memory:');try{const f=fake(),l=new Lifecycle(s,f.d);const w=l.create('test','owner');await l.start(w.id);let release!:()=>void;const wait=new Promise<void>(r=>release=r);f.d.healthy=async()=>{await wait;return true;};const reconciliation=l.reconcile();assert.throws(()=>l.beginOperation(w.id));await assert.rejects(l.stop(w.id),/conflict/);release();await reconciliation;const end=l.beginOperation(w.id);end();}finally{s.close();}
});
function fake(){let running=false;const calls:string[]=[];const d:Deployment={async start(){calls.push('start');running=true;},async stop(){calls.push('stop');running=false;},async remove(){calls.push('delete');},async healthy(){return running;}};return {d,calls,fail(){running=false;}};}
test('lifecycle serializes, waits healthy, persists volumes, idles and revokes on deletion',async()=>{
 const s=new Store(':memory:');try{const f=fake();let busy=true;const l=new Lifecycle(s,f.d,{busy:()=>busy});const w=l.create('workspace','owner',1);await l.start(w.id);assert.equal(s.workspace(w.id)?.state,'ready');await l.restart(w.id);assert.equal(s.workspace(w.id)?.profileVolume,w.profileVolume);s.db.prepare('UPDATE workspaces SET lastActivity=0 WHERE id=?').run(w.id);await l.tick();assert.equal(s.workspace(w.id)?.state,'ready');busy=false;s.db.prepare('UPDATE workspaces SET lastActivity=0 WHERE id=?').run(w.id);await l.tick();assert.equal(s.workspace(w.id)?.state,'stopped');const a=new Auth(s),c=a.issue('agent',w.id,['view']);await l.delete(w.id);assert.throws(()=>a.authenticate(c.token));assert.equal(s.workspace(w.id)?.state,'deleted');assert(f.calls.includes('delete'));}finally{s.close();}
});
test('lifecycle conflict and bounded durable recovery',async()=>{
 const s=new Store(':memory:');try{const f=fake(),l=new Lifecycle(s,f.d);const w=l.create('test','owner');const starting=l.start(w.id);await assert.rejects(l.start(w.id),/conflict/);await starting;for(let i=0;i<4;i++){f.fail();await l.recover(w.id);}assert.equal(s.workspace(w.id)?.state,'failed');assert.equal(s.workspace(w.id)?.desiredState,'stopped');assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='workspace.recovering'").get()?.n,3);}finally{s.close();}
});
test('deployment invokes private runtime script, audit failure prevents deployment',async()=>{
 const s=new Store(':memory:');try{const calls:unknown[]=[];const d=new OciDeployment('podman','/trusted/workspace.sh',async(file,args,options)=>{calls.push({file,args,options});return {stdout:JSON.stringify(Array.from({length:3},()=>({State:{Running:true,Health:{Status:'healthy'}},HostConfig:{PortBindings:{}}}))),stderr:''};},async()=>true);const l=new Lifecycle(s,d);const w=l.create('test','owner');await l.start(w.id);assert.equal((calls[0] as {file:string}).file,'bash');assert.deepEqual((calls[0] as {args:string[]}).args,['/trusted/workspace.sh','start',w.id]);s.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'disk full'); END");const n=calls.length;await assert.rejects(l.stop(w.id));assert.equal(calls.length,n);}finally{s.close();}
});
test('credentials reject expiry, audience mismatch and forged permission snapshots; role change revokes',()=>{
 const s=new Store(':memory:');try{const a=new Auth(s),c=a.issue('agent',null,['view']);const p=a.authenticate(c.token);p.permissions.push('shell');assert.throws(()=>a.authorize(p,'shell'));assert.throws(()=>new Auth(s,'other-audience').authenticate(c.token));s.db.prepare('UPDATE credentials SET expiresAt=0 WHERE id=?').run(c.id);assert.throws(()=>a.authenticate(c.token));a.defineRole('observer',['view']);const u=a.createUser('viewer','correct horse battery staple','observer'),session=a.login('viewer','correct horse battery staple','viewer-client');a.setUserRole(u,'observer');assert.throws(()=>a.authenticate(session.token));}finally{s.close();}
});
test('failed readiness preserves durable workspace and no missing control health can be ready',async()=>{
 const s=new Store(':memory:');try{const f=fake();f.d.healthy=async()=>false;const l=new Lifecycle(s,f.d,{readinessMs:0});const w=l.create('test','owner');await assert.rejects(l.start(w.id),/Readiness/);assert.equal(s.workspace(w.id)?.state,'failed');assert.equal(s.workspace(w.id)?.filesVolume,w.filesVolume);assert(f.calls.includes('stop'));const d=new OciDeployment('docker','/trusted/script',async()=>({stdout:JSON.stringify(Array.from({length:3},()=>({State:{Running:true,Health:{Status:'healthy'}},HostConfig:{}}))),stderr:''}));assert.equal(await d.healthy(w),false);}finally{s.close();}
});
