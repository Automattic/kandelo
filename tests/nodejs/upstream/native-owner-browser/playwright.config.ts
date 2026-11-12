import base from '../libuv-browser/playwright.config';
import {fileURLToPath} from 'node:url';
const server=base.webServer as {command:string;[key:string]:unknown};
export default {...base,testDir:fileURLToPath(new URL('.',import.meta.url)),testMatch:'native-owner.spec.ts',webServer:{...server,command:server.command.replace(/--config \S+/,'--config '+fileURLToPath(new URL('./vite.config.ts',import.meta.url)))}};
