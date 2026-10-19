import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileActor, FileService } from './files.js';

/** Never forward a mutable utility-volume path to Chrome. Snapshot through descriptor-safe
 * FileService.download, then copy to a browser-only, mode-0700 temporary directory.
 * Caller must validate the live browser identity before invoking this trusted OCI adapter. */
export async function prepareBrowserUpload(files:FileService,actor:FileActor,path:string,options:{runtime:'docker'|'podman';run:(file:string,args:string[])=>Promise<string>}):Promise<{path:string;cleanup:()=>Promise<void>}> {
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(actor.workspaceId))throw Error('Invalid workspace identifier');
 const container=`buk-${actor.workspaceId}-browser`,remote=`/tmp/buk-upload-${randomUUID()}`;
 const local=await mkdtemp(join(tmpdir(),'buk-upload-'));let created=false;
 const cleanup=async()=>{if(created){await options.run(options.runtime,['exec','--user','1000:1000',container,'rm','-rf',remote]);created=false;}};
 try {
  const snapshot=join(local,'payload');const file=await open(snapshot,'wx',0o644);
  try{for await(const chunk of files.download(actor,path.startsWith('/workspace/')?path.slice('/workspace/'.length):path))await file.writeFile(chunk);await file.chmod(0o644);}finally{await file.close();}
  await options.run(options.runtime,['exec','--user','1000:1000',container,'mkdir','-m','700',remote]);created=true;
  const destination=remote+'/'+basename(path);
  await options.run(options.runtime,['cp',snapshot,`${container}:${destination}`]);
  return {path:destination,cleanup};
 }catch(error){await cleanup();throw error;}finally{await rm(local,{recursive:true,force:true});}
}
