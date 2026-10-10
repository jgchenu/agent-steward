import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { git, inventory } from './workspace.js';
import type { Workspace } from './types.js';

// Read only the reviewed delta. Never copy an entire old checkout onto a new baseline.
export async function snapshotChanges(stateDir: string, workspace: Workspace, expected: Awaited<ReturnType<typeof inventory>>, signal: AbortSignal) {
  if(expected.files.some(f=>/(^|\/)(\.env($|\.)|\.steward\/)|\.(pem|key|p12)$/.test(f) && !f.endsWith('.env.example'))) throw Error('迁移改动包含私有配置或密钥类文件，未创建快照。');
  const dir=join(stateDir,'artifacts',workspace.taskId,'migration-'+randomUUID());
  mkdirSync(dir,{recursive:true,mode:0o700});
  try {
    const patch=await git(workspace.path,['diff','--binary','--full-index',workspace.baseSha,'--',...expected.files],signal);
    writeFileSync(join(dir,'tracked.patch'),patch+'\n',{mode:0o400});
    const files=[];
    for(const path of expected.files){
      signal.throwIfAborted();
      const source=join(workspace.path,path);
      try{
        const parent=relative(realpathSync(workspace.path),realpathSync(dirname(source)));
        if(parent.startsWith('..')||isAbsolute(parent))throw Error('迁移文件父目录越出任务副本。');
        const stat=lstatSync(source);
        if(stat.isSymbolicLink()){files.push({path,type:'symlink',target:readlinkSync(source)});continue;}
        if(!stat.isFile())throw Error('不支持的迁移文件类型。');
        const dest=join(dir,'files',path);mkdirSync(dirname(dest),{recursive:true,mode:0o700});
        writeFileSync(dest,readFileSync(source),{mode:0o400,flag:'wx'});
        files.push({path,type:'file',mode:stat.mode & 0o777});
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;files.push({path,type:'deleted'});}
    }
    const after=await inventory(workspace,signal);
    if(after.fingerprint!==expected.fingerprint||after.headSha!==expected.headSha)throw Error('旧副本内容已变化，未迁移；请重新预览。');
    const manifest=join(dir,'manifest.json');
    writeFileSync(manifest,JSON.stringify({baseSha:workspace.baseSha,headSha:expected.headSha,fingerprint:expected.fingerprint,files},null,2)+'\n',{mode:0o400});
    return {dir,manifest};
  }catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
}
