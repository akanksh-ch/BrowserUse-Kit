import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type WorkspaceState = 'created'|'starting'|'ready'|'stopping'|'stopped'|'recovering'|'failed'|'deleting'|'deleted';
export interface Workspace { id:string; name:string; ownerId:string; state:WorkspaceState; desiredState:string; createdAt:number; updatedAt:number; lastActivity:number; inactivityMs:number; profileVolume:string; filesVolume:string; diagnostic:string|null; }
export class Store {
  readonly db: DatabaseSync;
  constructor(path:string) {
    if(path!==':memory:') mkdirSync(dirname(path), {recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if(path!==':memory:')for(const file of [path,`${path}-wal`,`${path}-shm`])if(existsSync(file))chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,ownerId TEXT NOT NULL,state TEXT NOT NULL,desiredState TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,lastActivity INTEGER NOT NULL,inactivityMs INTEGER NOT NULL,profileVolume TEXT NOT NULL UNIQUE,filesVolume TEXT NOT NULL UNIQUE,diagnostic TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,workspaceId TEXT,type TEXT NOT NULL,sourceId TEXT NOT NULL,summary TEXT NOT NULL,timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,permissions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roles(name TEXT PRIMARY KEY,permissions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(hash TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,subject TEXT NOT NULL,workspaceId TEXT,audience TEXT NOT NULL,permissions TEXT NOT NULL,expiresAt INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,kind TEXT NOT NULL,csrf TEXT,lastActivity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lifecycle_locks(workspaceId TEXT PRIMARY KEY,holder TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS login_limits(key TEXT PRIMARY KEY,failures INTEGER NOT NULL,nextAttempt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS token_limits(subject TEXT PRIMARY KEY,attempts INTEGER NOT NULL,windowStart INTEGER NOT NULL,nextAttempt INTEGER NOT NULL);`);
  }
  transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try { const result=fn(); this.db.exec('COMMIT'); return result; } catch(e){this.db.exec('ROLLBACK');throw e;} }
  audit(workspaceId:string|null,type:string,sourceId:string,summary:string) {
    // Mandatory audit deliberately accepts metadata, never arbitrary request bodies.
    return Number(this.db.prepare('INSERT INTO events(workspaceId,type,sourceId,summary,timestamp) VALUES(?,?,?,?,?)').run(workspaceId,type,sourceId,summary.slice(0,2048),Date.now()).lastInsertRowid);
  }
  createWorkspace(name:string,ownerId:string,inactivityMs=3600000):Workspace {
    if(!name.trim()||name.length>128||!ownerId||!Number.isSafeInteger(inactivityMs)||inactivityMs<0) throw new Error('Invalid workspace');
    return this.transaction(()=>{ const id=randomUUID(),now=Date.now(); this.audit(id,'workspace.created',ownerId,'Workspace created'); this.db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,name,ownerId,'created','stopped',now,now,now,inactivityMs,`buk-${id}-profile`,`buk-${id}-files`,null); return this.workspace(id)!; });
  }
  workspace(id:string):Workspace|undefined { return this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id) as unknown as Workspace|undefined; }
  listWorkspaces():Workspace[] {return this.db.prepare("SELECT * FROM workspaces WHERE state != 'deleted' ORDER BY createdAt").all() as unknown as Workspace[];}
  setState(id:string,state:WorkspaceState,desiredState?:string,diagnostic:string|null=null) { this.transaction(()=>{ if(!this.workspace(id))throw new Error('Workspace not found');this.audit(id,`workspace.${state}`,'system',diagnostic??state); this.db.prepare('UPDATE workspaces SET state=?,desiredState=COALESCE(?,desiredState),diagnostic=?,updatedAt=? WHERE id=?').run(state,desiredState??null,diagnostic,Date.now(),id); }); }
  touch(id:string){this.db.prepare('UPDATE workspaces SET lastActivity=? WHERE id=?').run(Date.now(),id);}
  events(workspaceId:string,after=0,limit=1000){return this.db.prepare('SELECT * FROM events WHERE workspaceId=? AND id>? ORDER BY id LIMIT ?').all(workspaceId,after,Math.min(1000,Math.max(1,limit)));}
  close(){this.db.close();}
}
