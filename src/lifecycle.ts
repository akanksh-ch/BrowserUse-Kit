import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Store, type Workspace } from './core.js';
const exec=promisify(execFile);
export type Runner=(file:string,args:string[],options?:{env?:NodeJS.ProcessEnv;timeout?:number})=>Promise<{stdout:string;stderr:string}>;
export interface Deployment { start(workspace:Workspace):Promise<void>; stop(workspace:Workspace):Promise<void>; remove(workspace:Workspace):Promise<void>; healthy(workspace:Workspace):Promise<boolean>; }
/** Runtime-owned script provisions private networks, firewall rules and volumes.
 * controlHealth must verify MCP, input gate and protected storage before ready.
 * No fallback to unfiltered containers is permitted if deployment is absent.
 */
export class OciDeployment implements Deployment {
  constructor(readonly runtime:'docker'|'podman'='docker',readonly script=resolve('scripts/workspace.sh'),readonly runner:Runner=async(file,args,options)=>{const result=await exec(file,args,{...options,maxBuffer:1024*1024});return {stdout:String(result.stdout),stderr:String(result.stderr)};},readonly controlHealth?:((w:Workspace)=>Promise<boolean>)){}
  private async invoke(action:string,w:Workspace){if(!/^[0-9a-f-]{36}$/.test(w.id))throw new Error('Invalid workspace id');await this.runner('bash',[this.script,action,w.id],{env:{...process.env,OCI_RUNTIME:this.runtime,PROFILE_VOLUME:w.profileVolume,FILES_VOLUME:w.filesVolume},timeout:120000});}
  start(w:Workspace){return this.invoke('start',w);}
  async stop(w:Workspace){await this.invoke('stop',w);const remaining=await this.runner(this.runtime,['ps','--all','--filter',`label=browseruse.workspace=${w.id}`,'--format','{{.Names}}'],{timeout:5000});if(remaining.stdout.trim())throw new Error('Runtime cleanup incomplete; profile lock must remain protected');}
  remove(w:Workspace){return this.invoke('delete',w);}
  async healthy(w:Workspace){try{
    const result=await this.runner(this.runtime,['inspect',`buk-${w.id}-browser`,`buk-${w.id}-utility`,`buk-${w.id}-egress`],{timeout:5000});
    const containers=JSON.parse(result.stdout) as {State:{Running:boolean;Health?:{Status:string}};HostConfig:{PortBindings?:Record<string,unknown>}}[];
    if(containers.length!==3||containers.some(c=>!c.State.Running||Object.keys(c.HostConfig.PortBindings??{}).length>0)||containers[0]?.State.Health?.Status!=='healthy')return false;
    if(this.controlHealth)return await this.controlHealth(w);
    if(!process.env.BROWSERUSE_CONTROL_HEALTHCHECK)return false;
    await this.invoke('health',w);return true;
  }catch{return false;}}
}
export interface LifecycleOptions {
  readinessMs?:number; pollMs?:number; drainMs?:number;
  humanLease?:(id:string)=>{expiresAt:number}|undefined;
  // Must include all MCP requests, commands, transfers, human/viewer/task leases.
  busy?:(id:string)=>boolean|Promise<boolean>;
  revoke?:(id:string)=>void|Promise<void>;
  quiesce?:(id:string)=>void|Promise<void>;
  now?:()=>number;
}
export class Lifecycle {
  private active=new Set<string>();
  private recoveries=new Map<string,number[]>();
  private timer:ReturnType<typeof setInterval>|undefined;
  private ticking=false;
  private reconciling=false;
  private initialized=false;
  private operations=new Map<string,Set<{cancel?:()=>void|Promise<void>}>>();
  private holds=new Map<string,Map<string,number>>();
  constructor(readonly store:Store,readonly deployment:Deployment=new OciDeployment(),readonly options:LifecycleOptions={}){}
  private get(id:string){const w=this.store.workspace(id);if(!w||w.state==='deleted')throw new Error('Workspace not found');return w;}
  private async exclusive<T>(id:string,fn:()=>Promise<T>,reconciliation=false):Promise<T>{
    if((this.reconciling&&!reconciliation)||this.active.has(id))throw new Error('Lifecycle conflict');const holder=randomUUID();
    // This durable lock is never stolen on timeout: a surviving runtime may hold the profile.
    this.store.transaction(()=>{this.store.audit(id,'lifecycle.lock','system','Lifecycle operation accepted');try{this.store.db.prepare('INSERT INTO lifecycle_locks VALUES(?,?)').run(id,holder);}catch{throw new Error('Lifecycle conflict; reconciliation required');}});
    this.active.add(id);try{return await fn();}finally{this.active.delete(id);this.store.db.prepare('DELETE FROM lifecycle_locks WHERE workspaceId=? AND holder=?').run(id,holder);}
  }
  assertReady(id:string){if(!this.initialized||this.reconciling||this.active.has(id)||this.get(id).state!=='ready')throw new Error('Workspace is not accepting operations');}
  /** Hold every MCP request, transfer and running command through actual completion. */
  beginOperation(id:string,cancel?:()=>void|Promise<void>){this.assertReady(id);const entry={cancel};let entries=this.operations.get(id);if(!entries){entries=new Set();this.operations.set(id,entries);}entries.add(entry);this.store.touch(id);let ended=false;return ()=>{if(ended)return;ended=true;entries!.delete(entry);this.store.touch(id);};}
  holdActivity(id:string,key:string,expiresAt:number){this.assertReady(id);if(!key||!Number.isFinite(expiresAt)||expiresAt<=(this.options.now??Date.now)())throw new Error('Invalid activity lease');let holds=this.holds.get(id);if(!holds){holds=new Map();this.holds.set(id,holds);}holds.set(key,expiresAt);this.store.touch(id);}
  releaseActivity(id:string,key:string){this.holds.get(id)?.delete(key);this.store.touch(id);}
  async isBusy(id:string){const external=Boolean(await this.options.busy?.(id));const now=(this.options.now??Date.now)();const holds=this.holds.get(id);if(holds)for(const [key,expiresAt] of holds)if(expiresAt<=now)holds.delete(key);return (this.operations.get(id)?.size??0)>0||(holds?.size??0)>0||(this.options.humanLease?.(id)?.expiresAt??0)>now||external;}
  private async drain(id:string){const deadline=Date.now()+(this.options.drainMs??10000);let timeout:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([(async()=>{await this.options.quiesce?.(id);await Promise.all([...this.operations.get(id)??[]].map(op=>op.cancel?.()));while(this.operations.get(id)?.size){if(Date.now()>=deadline)throw new Error('Operations did not drain');await new Promise(r=>setTimeout(r,10));}})(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Operations did not drain')),Math.max(0,deadline-Date.now()));})]);this.holds.delete(id);}finally{if(timeout)clearTimeout(timeout);}}
  create(name:string,ownerId:string,inactivityMs?:number){return this.store.createWorkspace(name,ownerId,inactivityMs);}
  async start(id:string){return this.exclusive(id,async()=>this.startUnlocked(id));}
  private async startUnlocked(id:string){let w=this.get(id);if(w.state==='ready'&&await this.deployment.healthy(w))return w;if(w.state==='deleting')throw new Error('Workspace deleting');
    this.store.setState(id,'starting','ready');w=this.get(id);
    try {await this.deployment.start(w);const deadline=Date.now()+(this.options.readinessMs??30000);while(!await this.deployment.healthy(w)){if(Date.now()>=deadline)throw new Error('Readiness checks failed');await new Promise(r=>setTimeout(r,this.options.pollMs??250));}this.store.setState(id,'ready','ready');this.store.touch(id);return this.get(id);}
    catch(e){try{await this.deployment.stop(w);}catch{/* Preserve volumes and failed state if shutdown also fails. */}this.store.setState(id,'failed','ready','Startup failed; inspect private deployment diagnostics');throw e;}
  }
  async stop(id:string){return this.exclusive(id,async()=>this.stopUnlocked(id));}
  private async stopUnlocked(id:string){const w=this.get(id);if(w.state==='stopped'||w.state==='created') {this.store.setState(id,'stopped','stopped');return this.get(id);}
    this.store.setState(id,'stopping','stopped');try{await this.drain(id);await this.deployment.stop(w);this.store.setState(id,'stopped','stopped');return this.get(id);}catch(e){this.store.setState(id,'failed','stopped','Shutdown failed; runtime/profile lock may remain');throw e;}}
  async restart(id:string){return this.exclusive(id,async()=>{await this.stopUnlocked(id);return this.startUnlocked(id);});}
  async delete(id:string){return this.exclusive(id,()=>this.deleteUnlocked(id));}
  private async deleteUnlocked(id:string){const w=this.get(id);this.store.transaction(()=>{this.store.audit(id,'auth.revoked','system','Workspace deletion revokes credentials');this.store.db.prepare('UPDATE credentials SET revoked=1 WHERE workspaceId=?').run(id);});await this.options.revoke?.(id);this.store.setState(id,'deleting','deleted');await this.drain(id);await this.deployment.stop(w);await this.deployment.remove(w);this.store.setState(id,'deleted','deleted');}
  async recover(id:string){return this.exclusive(id,()=>this.recoverUnlocked(id));}
  private async recoverUnlocked(id:string){const w=this.get(id);if(w.desiredState!=='ready')return;const now=(this.options.now??Date.now)(),attempts=(this.recoveries.get(id)??[]).filter(t=>now-t<600000);
    // Count from durable events as well, so restarting the supervisor cannot reset the budget.
    const count=this.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE workspaceId=? AND type='workspace.recovering' AND timestamp>?").get(id,now-600000) as {n:number};
    if(Math.max(attempts.length,Number(count.n))>=3){this.store.setState(id,'failed','stopped','Recovery limit reached (3 attempts / 10 minutes)');return;}
    attempts.push(now);this.recoveries.set(id,attempts);this.store.setState(id,'recovering','ready');await this.drain(id);await this.deployment.stop(w);try{return await this.startUnlocked(id);}catch{return this.get(id);}}
  /** Run on startup before accepting lifecycle requests. Requires a single host supervisor. */
  async reconcile(){if(this.reconciling||this.active.size)throw new Error('Lifecycle conflict');this.reconciling=true;this.initialized=false;try{for(const w of this.store.listWorkspaces()){
    if(this.active.has(w.id))continue;
    // Explicit reconciliation, not TTL stealing: stop guarantees Chrome has exited first.
    const lock=this.store.db.prepare('SELECT holder FROM lifecycle_locks WHERE workspaceId=?').get(w.id);
    if(lock){this.store.audit(w.id,'lifecycle.reconcile','system','Reconciling interrupted lifecycle operation');await this.deployment.stop(w);this.store.db.prepare('DELETE FROM lifecycle_locks WHERE workspaceId=?').run(w.id);}
    if(w.state==='deleting'){await this.exclusive(w.id,()=>this.deleteUnlocked(w.id),true);continue;}
    if(w.desiredState==='ready'){if(await this.deployment.healthy(w)){this.store.setState(w.id,'ready','ready');}else await this.exclusive(w.id,()=>this.recoverUnlocked(w.id),true);}
    else if(!['created','stopped','failed'].includes(w.state))await this.exclusive(w.id,()=>this.stopUnlocked(w.id),true);
  }this.initialized=true;}finally{this.reconciling=false;}}
  async tick(){if(this.ticking||this.reconciling)return;this.ticking=true;try{for(const w of this.store.listWorkspaces()){if(this.active.has(w.id)||w.state!=='ready')continue;if(!await this.deployment.healthy(w)){await this.recover(w.id);continue;}const now=(this.options.now??Date.now)();if(await this.isBusy(w.id)){this.store.touch(w.id);continue;}if(w.inactivityMs>0&&now-w.lastActivity>=w.inactivityMs){this.store.audit(w.id,'shutdown.pending','system','Inactivity timeout reached');await this.stop(w.id);}}}finally{this.ticking=false;}}
  monitor(intervalMs=1000,onError:(e:unknown)=>void=console.error){if(this.timer)throw new Error('Already monitoring');this.timer=setInterval(()=>{void this.tick().catch(onError);},intervalMs);this.timer.unref();return ()=>this.close();}
  close(){if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}
