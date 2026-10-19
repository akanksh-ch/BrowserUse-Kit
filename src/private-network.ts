import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { connect, isIP } from 'node:net';

/** Only trusted control workers enter this namespace; public HTTP stays on the host.
 * Preserve Podman's configuration environment, never control-plane credentials. */
export function privateNetworkCommand(executable:string,args:string[],rootless:boolean) {
 return rootless?{command:'podman',args:['unshare','--rootless-netns','env','HOME=/tmp',executable,...args]}:{command:executable,args};
}
export function privateNetworkEnvironment(rootless:boolean):Record<string,string> {
 const env:Record<string,string>={PATH:process.env.PATH??'/usr/bin:/bin',HOME:'/tmp'};
 if(rootless)for(const name of ['HOME','XDG_RUNTIME_DIR','USER','LOGNAME','DBUS_SESSION_BUS_ADDRESS','CONTAINERS_CONF','CONTAINERS_STORAGE_CONF'])if(process.env[name])env[name]=process.env[name]!;
 return env;
}
export function privateViewerStream(address:string,rootless:boolean) {
 if(isIP(address)!==4)throw Error('Invalid private browser address');
 if(!rootless)return connect({host:address,port:5900});
 const script="const s=require('node:net').connect({host:process.argv[1],port:5900});const t=setTimeout(()=>process.exit(1),5000);s.on('connect',()=>clearTimeout(t));s.on('error',()=>process.exit(1));s.on('close',()=>process.exit());process.stdin.pipe(s);s.pipe(process.stdout);process.stdin.on('end',()=>s.destroy());";
 const plan=privateNetworkCommand(process.execPath,['-e',script,address],true);
 const child=spawn(plan.command,plan.args,{env:privateNetworkEnvironment(true),stdio:['pipe','pipe','ignore']});
 const stream=Duplex.from({readable:child.stdout,writable:child.stdin});
 child.on('error',error=>stream.destroy(error));child.on('exit',code=>{if(code)stream.destroy(Error('Private viewer relay failed'));else stream.destroy();});stream.on('close',()=>child.kill());
 return stream;
}

/** Runs via the helper's bounded trusted namespace probe; no listener or public port. */
export const CDP_PROBE = `
const [address,method,encoded]=process.argv.slice(1);
async function main(){
 const response=await fetch('http://'+address+':9223/json/version',{signal:AbortSignal.timeout(3000),redirect:'error'});
 if(!response.ok)throw Error('CDP unavailable');const version=await response.json();const url=new URL(version.webSocketDebuggerUrl);
 if(url.protocol!=='ws:'||!/^\\/devtools\\/browser\\/[a-zA-Z0-9-]+$/.test(url.pathname))throw Error('Invalid private CDP endpoint');url.hostname=address;url.port='9223';
 return new Promise((resolve,reject)=>{const socket=new WebSocket(url);let done=false;const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);socket.close();error?reject(error):resolve(result);};const timer=setTimeout(()=>finish(Error('CDP timeout')),5000);
 socket.onopen=()=>socket.send(JSON.stringify({id:1,method,params:JSON.parse(encoded)}));socket.onmessage=event=>{try{const data=JSON.parse(event.data);if(data.id===1)finish(data.error?Error('CDP operation failed'):null,data.result);}catch(error){finish(error);}};socket.onerror=()=>finish(Error('CDP error'));socket.onclose=()=>finish(Error('CDP closed'));});
}
main().then(result=>process.stdout.write(JSON.stringify(result))).catch(()=>{process.stderr.write('Private CDP operation failed');process.exitCode=1;});
`;
