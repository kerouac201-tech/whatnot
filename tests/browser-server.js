import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'whatnot-browser-'));
process.env.DB_PATH=join(dir,'browser.sqlite');process.env.PORT='3101';process.env.NODE_ENV='production';
const {start,db}=await import('../server.js');const server=await start();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{db.close();await rm(dir,{recursive:true,force:true});process.exit(0);}));
