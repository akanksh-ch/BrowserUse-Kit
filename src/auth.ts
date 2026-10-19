import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { Store } from './core.js';

export const PERMISSIONS=['view','automation','files:read','files:write','shell','takeover','browser:admin','workspace:manage','script','clipboard'] as const;
export interface Principal { id:string; subject:string; workspaceId:string|null; audience:string; permissions:string[]; expiresAt:number; kind:string; csrf:string|null; }
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function equal(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function hashPassword(password:string){if(password.length<12||password.length>1024)throw new Error('Password must be 12–1024 characters');const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;}
export function verifyPassword(password:string,encoded:string){if(password.length>1024)return false;const [salt,digest]=encoded.split(':');if(!salt||!digest)return false;return equal(scryptSync(password,salt,64).toString('hex'),digest);}
export function validateHost(host:string|undefined,allowed:readonly string[]):boolean { if(!host||/[\s/@\\,#?]/.test(host))return false; return allowed.includes(host)&&allowed.every(x=>/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::[0-9]{1,5})?$/.test(x)); }
export function assertHost(host:string|undefined,allowed:readonly string[]){if(!validateHost(host,allowed))throw new Error('Invalid Host');}
export function sessionCookie(token:string,secure=true){return `buk_session=${token}; Path=/; HttpOnly; SameSite=Strict${secure?'; Secure':''}; Max-Age=28800`;}
export class Auth {
  constructor(readonly store:Store,readonly audience='browseruse-kit',readonly sessionIdleMs=1800000){}
  bootstrap(username:string,password:string){return this.store.transaction(()=>{if(this.store.db.prepare('SELECT 1 FROM users LIMIT 1').get())throw new Error('Already bootstrapped');if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(username))throw new Error('Invalid username');const id=randomUUID();this.store.audit(null,'auth.bootstrap',id,'Administrator created');this.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,username,hashPassword(password),JSON.stringify(['*']));return id;});}
  issue(subject:string,workspaceId:string|null,permissions:string[],options:{ttlMs?:number;kind?:'bearer'|'session'}={}) {
    const ttl=options.ttlMs??900000;if(!subject||!Number.isSafeInteger(ttl)||ttl<=0||ttl>28800000||permissions.some(p=>p!=='*'&&!PERMISSIONS.includes(p as typeof PERMISSIONS[number])))throw new Error('Invalid credential');
    const token=randomBytes(32).toString('base64url'),id=randomUUID(),csrf=options.kind==='session'?randomBytes(32).toString('base64url'):null,expiresAt=Date.now()+ttl;
    this.store.transaction(()=>{this.store.audit(workspaceId,'auth.issued',subject,'Credential issued');this.store.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?,?,0,?,?,?)').run(hash(token),id,subject,workspaceId,this.audience,JSON.stringify(permissions),expiresAt,options.kind??'bearer',csrf,Date.now());});
    return {token,id,csrf,expiresAt};
  }
  defineRole(name:string,permissions:string[],sourceId='system'){if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(name)||permissions.some(p=>p!=='*'&&!PERMISSIONS.includes(p as typeof PERMISSIONS[number])))throw new Error('Invalid role');this.store.transaction(()=>{this.store.audit(null,'auth.role',sourceId,'Role defined');this.store.db.prepare('INSERT OR REPLACE INTO roles VALUES(?,?)').run(name,JSON.stringify(permissions));});}
  createUser(username:string,password:string,role:string){const r=this.store.db.prepare('SELECT permissions FROM roles WHERE name=?').get(role) as {permissions:string}|undefined;if(!r||!/^[a-zA-Z0-9_.-]{1,64}$/.test(username))throw new Error('Invalid user/role');return this.store.transaction(()=>{const id=randomUUID();this.store.audit(null,'auth.user','system','User created');this.store.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id,username,hashPassword(password),r.permissions);return id;});}
  setUserRole(subject:string,role:string){const r=this.store.db.prepare('SELECT permissions FROM roles WHERE name=?').get(role) as {permissions:string}|undefined;if(!r)throw new Error('Unknown role');this.store.transaction(()=>{this.store.audit(null,'auth.privilege',subject,'Permissions changed; credentials revoked');this.store.db.prepare('UPDATE users SET permissions=? WHERE id=?').run(r.permissions,subject);this.store.db.prepare('UPDATE credentials SET revoked=1 WHERE subject=?').run(subject);});}
  /** Public token issuance must use this method, not the trusted bootstrap issue(). */
  issueFor(issuer:Principal,workspaceId:string,permissions:string[],options:{ttlMs?:number}={}){
    this.authorize(issuer,'workspace:manage',workspaceId);
    const row=this.store.db.prepare('SELECT permissions,expiresAt FROM credentials WHERE id=?').get(issuer.id) as {permissions:string;expiresAt:number};
    const granted:string[]=JSON.parse(row.permissions);
    if(permissions.some(p=>!granted.includes('*')&&!granted.includes(p)))throw new Error('Permission escalation denied');
    const w=this.store.workspace(workspaceId);if(!w||w.state==='deleted'||w.state==='deleting')throw new Error('Workspace unavailable');
    // Subject-wide durable budget prevents rotating delegated credentials to bypass limits.
    const limited=this.store.transaction(()=>{
      const now=Date.now();const prior=this.store.db.prepare('SELECT * FROM token_limits WHERE subject=?').get(issuer.subject) as {attempts:number;windowStart:number;nextAttempt:number}|undefined;
      const current=prior&&(now-prior.windowStart<60000||prior.nextAttempt>now)?prior:{attempts:0,windowStart:now,nextAttempt:0};
      const attempts=current.attempts+1;const denied=attempts>20||current.nextAttempt>now;
      const nextAttempt=denied?now+Math.min(60000,250*2**Math.min(attempts-20,8)):0;
      this.store.audit(workspaceId,denied?'auth.issue_limited':'auth.issue_requested',issuer.subject,denied?'Token issuance throttled':'Token issuance requested');
      this.store.db.prepare('INSERT OR REPLACE INTO token_limits VALUES(?,?,?,?)').run(issuer.subject,attempts,current.windowStart,nextAttempt);
      return denied;
    });
    if(limited)throw Object.assign(new Error('Token issuance temporarily unavailable'),{status:429});
    return this.issue(issuer.subject,workspaceId,permissions,{ttlMs:Math.min(options.ttlMs??900000,row.expiresAt-Date.now())});
  }
  login(username:string,password:string,rateKey:string){if(username.length>64||password.length>1024)throw new Error('Invalid credentials');const key=hash(rateKey),now=Date.now();const limit=this.store.db.prepare('SELECT * FROM login_limits WHERE key=?').get(key) as {failures:number;nextAttempt:number}|undefined;
    if(limit&&limit.nextAttempt>now)throw new Error('Login temporarily unavailable');
    const user=this.store.db.prepare('SELECT * FROM users WHERE username=?').get(username) as {id:string;password:string;permissions:string}|undefined;
    // Perform a real scrypt on unknown accounts as well.
    const valid=verifyPassword(password,user?.password??'00000000000000000000000000000000:'+'0'.repeat(128));
    if(!user||!valid){this.store.transaction(()=>{this.store.audit(null,'auth.denied','anonymous','Login failed');const n=(limit?.failures??0)+1;this.store.db.prepare('INSERT OR REPLACE INTO login_limits VALUES(?,?,?)').run(key,n,now+Math.min(60000,250*2**Math.min(n,8)));});throw new Error('Invalid credentials');}
    const result=this.issue(user.id,null,JSON.parse(user.permissions),{kind:'session',ttlMs:28800000});this.store.db.prepare('DELETE FROM login_limits WHERE key=?').run(key);return result;
  }
  authenticate(token:string):Principal {const row=this.store.db.prepare('SELECT * FROM credentials WHERE hash=?').get(hash(token)) as Record<string,unknown>|undefined;const now=Date.now();if(!row||row.revoked||Number(row.expiresAt)<=now||row.audience!==this.audience||(row.kind==='session'&&now-Number(row.lastActivity)>this.sessionIdleMs))throw new Error('Unauthorized');
    this.store.db.prepare('UPDATE credentials SET lastActivity=? WHERE hash=?').run(now,hash(token));return {id:String(row.id),subject:String(row.subject),workspaceId:row.workspaceId as string|null,audience:String(row.audience),permissions:JSON.parse(String(row.permissions)),expiresAt:Number(row.expiresAt),kind:String(row.kind),csrf:row.csrf as string|null}; }
  authorize(principal:Principal,permission:string,workspaceId?:string){ // Revalidate even previously authenticated handles.
    const row=this.store.db.prepare('SELECT * FROM credentials WHERE id=?').get(principal.id) as {revoked:number;expiresAt:number;lastActivity:number;workspaceId:string|null;kind:string;permissions:string;audience:string;subject:string}|undefined;
    const permissions:string[]=row?JSON.parse(row.permissions):[];
    const workspace=workspaceId?this.store.workspace(workspaceId):undefined;
    const deniedWorkspace=workspaceId!==undefined&&(!workspace||workspace.state==='deleted'||workspace.state==='deleting'||(row?.workspaceId===null&&!permissions.includes('*')&&workspace.ownerId!==row?.subject));
    if(deniedWorkspace||!row||row.revoked||row.subject!==principal.subject||row.audience!==this.audience||row.expiresAt<=Date.now()||(row.kind==='session'&&Date.now()-row.lastActivity>this.sessionIdleMs)|| (row.workspaceId!==null&&row.workspaceId!==workspaceId)||(!permissions.includes('*')&&!permissions.includes(permission))) {this.store.audit(workspaceId??null,'auth.denied',principal.subject,'Permission denied');throw new Error('Forbidden');}
  }
  csrf(principal:Principal,value:string|undefined){const row=this.store.db.prepare('SELECT kind,csrf,revoked,expiresAt FROM credentials WHERE id=?').get(principal.id) as {kind:string;csrf:string|null;revoked:number;expiresAt:number}|undefined;if(!row||row.revoked||row.expiresAt<=Date.now()||(row.kind==='session'&&(!value||!row.csrf||!equal(value,row.csrf))))throw new Error('Invalid CSRF token');}
  revoke(id:string,sourceId='system'){this.store.transaction(()=>{this.store.audit(null,'auth.revoked',sourceId,'Credential revoked');this.store.db.prepare('UPDATE credentials SET revoked=1 WHERE id=?').run(id);});}
  revokeWorkspace(id:string){this.store.transaction(()=>{this.store.audit(id,'auth.revoked','system','Workspace credentials revoked');this.store.db.prepare('UPDATE credentials SET revoked=1 WHERE workspaceId=?').run(id);});}
}
