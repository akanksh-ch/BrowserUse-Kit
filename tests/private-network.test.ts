import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { privateNetworkCommand, privateNetworkEnvironment, privateViewerStream } from '../src/private-network.js';
import { browserCdp } from '../src/server.js';

test('private workers use argument-array rootless namespace launch and exclude control secrets',()=>{
 const args=['--browserUrl=http://10.90.0.2:9223'];
 assert.deepEqual(privateNetworkCommand('/locked/mcp',args,true),{command:'podman',args:['unshare','--rootless-netns','env','HOME=/tmp','/locked/mcp',...args]});
 assert.deepEqual(privateNetworkCommand('/locked/mcp',args,false),{command:'/locked/mcp',args});
 const prior=process.env.BUK_ADMIN_PASSWORD;process.env.BUK_ADMIN_PASSWORD='must-not-propagate';try{
  assert.equal(privateNetworkEnvironment(true).BUK_ADMIN_PASSWORD,undefined);assert.equal(privateNetworkEnvironment(false).HOME,'/tmp');assert.equal(privateNetworkEnvironment(true).HOME,process.env.HOME??'/tmp');
 }finally{if(prior===undefined)delete process.env.BUK_ADMIN_PASSWORD;else process.env.BUK_ADMIN_PASSWORD=prior;}
 assert.throws(()=>privateViewerStream('host.invalid',true),/Invalid private/);
});

test('live backend CDP and viewer relays reach rootless private bridge without published ports',{skip:process.env.BUK_LIVE_PRIVATE_NETWORK!=='1',timeout:40000},async t=>{
 const run=async(file:string,args:string[])=>String((await promisify(execFile)(file,args,{timeout:10000,maxBuffer:256*1024})).stdout);
 const workspace='transport-'+randomUUID(),name=`buk-${workspace}-browser`;let network=false,container=false;
 const program=`import socketserver,threading,json,base64,hashlib,struct
class CDP(socketserver.BaseRequestHandler):
 def handle(self):
  data=b''
  while b'\\r\\n\\r\\n' not in data: data+=self.request.recv(4096)
  if data.startswith(b'GET /json/version '):
   body=json.dumps({'webSocketDebuggerUrl':'ws://'+self.request.getsockname()[0]+':9223/devtools/browser/test'}).encode()
   self.request.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: '+str(len(body)).encode()+b'\\r\\nConnection: close\\r\\n\\r\\n'+body)
  else:
   headers={key.lower():value for key,value in (line.split(b': ',1) for line in data.split(b'\\r\\n')[1:] if b': ' in line)}
   key=base64.b64encode(hashlib.sha1(headers[b'sec-websocket-key']+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
   self.request.sendall(b'HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+b'\\r\\n\\r\\n')
   self.request.recv(4096)
   result=b'{"id":1,"result":{"targetInfos":[]}}'
   self.request.sendall(bytes([129,len(result)])+result)
class VNC(socketserver.BaseRequestHandler):
 def handle(self):
  self.request.sendall(b'RFB 003.008\\n')
  self.request.sendall(self.request.recv(12))
for port,handler in [(9223,CDP),(5900,VNC)]:
 server=socketserver.ThreadingTCPServer(('0.0.0.0',port),handler)
 threading.Thread(target=server.serve_forever,daemon=True).start()
threading.Event().wait()
`;
 try{
  await run('podman',['network','create','--internal',name]);network=true;
  await run('podman',['run','-d','--name',name,'--label',`browseruse.workspace=${workspace}`,'--network',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000','--memory','128m','--pids-limit','32','--cpus','1','--entrypoint','python3',process.env.BUK_CONTROL_TEST_IMAGE??'browseruse-egress:local','-u','-c',program]);container=true;
  const [c]=JSON.parse(await run('podman',['inspect',name]));assert.deepEqual(c.HostConfig.PortBindings??{},{});const address=c.NetworkSettings.Networks[name].IPAddress;
  assert.deepEqual(await browserCdp(workspace,'Target.getTargets',{},run,true),{targetInfos:[]});
  const relay=privateViewerStream(address,true);relay.on('error',()=>{});try{
   assert.equal((await once(relay,'data'))[0].toString(),'RFB 003.008\n');relay.write(Buffer.from('RFB 003.008\n'));assert.equal((await once(relay,'data'))[0].toString(),'RFB 003.008\n');
  }finally{relay.destroy();}
  t.diagnostic('Actual backend namespace CDP command and binary RFB relay passed; fixture is synthetic, not Chrome/sandbox acceptance.');
 }finally{try{if(container)await run('podman',['rm','-f','-t','0',name]);}finally{if(network)await run('podman',['network','rm',name]);}}
});
