import fs from 'node:fs';
import { createHash } from 'node:crypto';
const files = ['fleet.js', 'fleet.css', ...fs.readdirSync('voice', {recursive:true}).map(n=>'voice/'+n).filter(n=>fs.statSync(n).isFile())];
const hashes = Object.fromEntries(files.sort().map(n=>[n,createHash('sha256').update(fs.readFileSync(n)).digest('hex')]));
fs.writeFileSync('assets.json', JSON.stringify(hashes,null,2)+'\n');
