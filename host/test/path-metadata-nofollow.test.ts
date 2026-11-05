import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodePlatformIO } from '../src/platform/node';
import { HostFileSystem } from '../src/vfs/host-fs';
import { VirtualPlatformIO } from '../src/vfs/vfs';
import { NodeTimeProvider } from '../src/vfs/time';
import { AT_FLAGS, OPEN_FLAGS } from '../src/generated/abi';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'kandelo-utime-nofollow-'));roots.push(root);
  writeFileSync(join(root,'target'),'bytes');symlinkSync('target',join(root,'link'));symlinkSync('missing',join(root,'dangling'));
  return root;
}
// Real host inode mutations through both host adapters. This does not run a
// rebuilt guest kernel, and does not validate the browser OPFS backend.
describe.skipIf(process.platform==='win32')('timestamp nofollow on Node-backed mounts',()=>{
  for(const kind of ['direct','virtual'] as const) {
    it(`${kind} selects the symlink and preserves the target`,()=>{
      const root=fixture();
      const io=kind==='direct'?new NodePlatformIO():new VirtualPlatformIO(
        [{mountPoint:'/',backend:new HostFileSystem(root)}],new NodeTimeProvider());
      let handle=io.foreignMountRoots()[0].handle;
      if(kind==='direct')for(const component of root.split('/').filter(Boolean)) {
        const next=io.openat(handle,component,OPEN_FLAGS.O_DIRECTORY|OPEN_FLAGS.O_RDONLY,0);io.close(handle);handle=next;
      }
      try {
        io.utimensatAt(handle,'link',1000,0,2000,0,0);
        expect(statSync(join(root,'target')).mtimeMs).toBe(2000000);
        io.utimensatAt(handle,'link',3000,0,4000,0,AT_FLAGS.AT_SYMLINK_NOFOLLOW);
        expect(statSync(join(root,'target')).mtimeMs).toBe(2000000);
        expect(lstatSync(join(root,'link')).mtimeMs).toBe(4000000);
        io.utimensatAt(handle,'dangling',5000,0,6000,0,AT_FLAGS.AT_SYMLINK_NOFOLLOW);
        expect(lstatSync(join(root,'dangling')).mtimeMs).toBe(6000000);
        expect(()=>io.utimensatAt(handle,'dangling',1,0,2,0,0)).toThrow();
      } finally {io.close(handle);}
    });
  }
});
