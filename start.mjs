import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readConfig, speechConfig, localRequestAllowed } from './config.mjs';

process.umask(0o077);
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.VOICE_PORT || 4260), backendPort = port + 1;
if (!Number.isInteger(port) || port < 1024 || port > 65000) throw Error('Choose an unprivileged local port.');
const project = path.resolve(process.argv.find(a => a.startsWith('--project='))?.slice(10) || process.cwd());
if (!fs.statSync(project).isDirectory()) throw Error('Choose an existing project directory.');
const originalConfig = readConfig(), speech = speechConfig(originalConfig);
const secrets = [speech.stt.key, speech.tts.key, speech.language?.key].filter(Boolean);
const data = process.env.VOICE_DATA_DIR || path.join(os.homedir(), '.local/share/openchamber-streaming-voice');
fs.mkdirSync(data, { recursive: true, mode: 0o700 });
const log = fs.openSync(path.join(data, 'runtime.log'), 'a', 0o600);
const announce = text => process.stdout.write(text + '\n');
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = (...args) => {
  let line = args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  for (const secret of secrets) line = line.replaceAll(secret, '[redacted]');
  fs.writeSync(log, line + '\n');
};
for (const target of [port, backendPort, port + 2]) await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', () => reject(Error(`Local port ${target} is in use. Set VOICE_PORT to a free group of three ports.`)));
  probe.listen(target, '127.0.0.1', () => probe.close(resolve));
});
// Preserve configured providers/models and permissions; disable conversation sharing.
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...originalConfig, share: 'disabled' });
process.env.OPENCHAMBER_DATA_DIR = path.join(data, 'openchamber');
process.env.OPENCHAMBER_HOST = '127.0.0.1';
process.env.OPENCHAMBER_RELAY_HOST = 'off';
process.env.OPENCODE_PORT = String(port + 2);
process.env.OPENCHAMBER_OPENCODE_HOSTNAME = '127.0.0.1';
delete process.env.OPENCODE_HOST;
delete process.env.OPENCODE_SKIP_START;
const commonBinary = path.join(os.homedir(), '.opencode/bin/opencode');
if (!process.env.OPENCODE_BINARY && fs.existsSync(commonBinary)) process.env.OPENCODE_BINARY = commonBinary;
process.chdir(project);

function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req, max = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function backendPath(url) {
  if (url.startsWith('/machines/local/')) return url.slice('/machines/local'.length);
  if (url.startsWith('/machines/')) return null;
  return url;
}
async function speechResponse(res, target, payload, contentType = 'application/json') {
  const cancelled = new AbortController();
  const close = () => cancelled.abort();
  res.once('close', close);
  try {
    const upstream = await fetch(target.url, { method: 'POST', redirect: 'error', headers: { ...(target.key ? {Authorization: 'Bearer ' + target.key} : {}), 'Content-Type': contentType }, body: payload, signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(90000)]) });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' });
    // The personal API key stays server-side; browser interruptions cancel this request.
    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await once(res, 'drain', { signal: cancelled.signal });
    }
    res.end();
  } finally { res.removeListener('close', close); }
}
const assetHashes = JSON.parse(fs.readFileSync(path.join(here, 'assets.json'), 'utf8'));
const contentTypes = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.txt': 'text/plain' };
const voiceSystem = `You are a voice assistant using the user's configured model and speech providers. OpenCode tools execute on this computer, in the selected session's local project directory. Use tools to do requested work and verify it. Never claim to run on another computer. The browser speaks your ordinary text while it streams; never call converse or VoiceMode. Reply briefly in the dominant language of the complete user utterance, preserving it when a borrowed word appears. Do not narrate reasoning or read code, long paths, or URLs aloud unless requested. Ask before destructive actions, sending messages, purchases, credentials or security changes. A failed website does not authorize network or clock changes. Keep the user's normal OpenCode permission checks. Do not enable sharing or remote access.`;
let controller, closing = false;
const server = http.createServer(async (req, res) => {
  try {
    if (!localRequestAllowed(req, port)) return json(res, 403, { error: 'Use this app from its localhost address.' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/voice/client.js') {
      if (!['GET','HEAD'].includes(req.method)) return json(res,405,{});
      const config = { directory: project, asrBase: `http://127.0.0.1:${port}/voice/stt/v1`, asrModel: speech.stt.model, languageDetection: Boolean(speech.language), system: voiceSystem };
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      return res.end('window.OPENCHAMBER_VOICE_CLIENT=' + JSON.stringify(config).replaceAll('<', '\\u003c') + ';');
    }
    if (url.pathname === '/voice/speech' && req.method === 'POST') {
      const input = JSON.parse(await body(req));
      return await speechResponse(res, {url: speech.tts.base + '/audio/speech', key: speech.tts.key}, JSON.stringify({ model: speech.tts.model, input: input.text || input.input, voice: speech.voice, speed: input.speed || 1.04, response_format: 'wav', ...(speech.languageFields ? {language: input.language || '', languageSample: input.languageSample || ''} : {}) }));
    }
    if (url.pathname === '/voice/language' && req.method === 'POST') {
      if (!speech.language) return json(res,404,{error:'No language adapter configured; use model-directed language selection.'});
      return await speechResponse(res, speech.language, await body(req));
    }
    if (url.pathname === '/voice/stt/v1/audio/transcriptions' && req.method === 'POST') {
      return await speechResponse(res, {url: speech.stt.base + '/audio/transcriptions', key: speech.stt.key}, await body(req, 12 * 1024 * 1024), req.headers['content-type'] || 'application/octet-stream');
    }
    if (['/voice/health','/voice/asr-health'].includes(url.pathname) && req.method === 'GET') {
      const target = url.pathname.includes('asr') ? speech.stt : speech.tts;
      const response = await fetch(target.base + '/models', { redirect: 'error', headers: target.key ? {Authorization:'Bearer '+target.key} : {}, signal: AbortSignal.timeout(12000) });
      if (!response.ok) return json(res,response.status,{ready:false,error:'Check your speech provider URL and key.'});
      const models = (await response.json()).data || [];
      return json(res,200,{ready:models.some(m=>m.id===target.model && m.loaded!==false)});
    }
    if (url.pathname === '/fleet/health') return json(res,200,{machines:[{id:'local',online:controller?.isReady()===true}]});
    const asset = url.pathname === '/voice' || url.pathname === '/voice/' ? 'voice/index.html' : url.pathname.slice(1);
    if (assetHashes[asset]) {
      if (!['GET','HEAD'].includes(req.method)) return json(res,405,{});
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(asset)] || 'application/octet-stream', 'Cache-Control': 'no-store',
        'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(path.join(here,asset)).pipe(res);
    }
    if (url.pathname.startsWith('/voice/')) return json(res,404,{});
    const target = backendPath(req.url); if (!target) return json(res,404,{error:'This instance only runs local workspaces.'});
    const upstream = http.request({hostname:'127.0.0.1',port:backendPort,path:target,method:req.method,headers:{...req.headers,'accept-encoding':'identity'}}, response => {
      const headers = {...response.headers,'cache-control':'no-store'};
      if (response.headers['content-type']?.includes('text/html')) {
        const chunks=[]; response.on('data',b=>chunks.push(b)); response.on('end',()=>{
          let html=Buffer.concat(chunks).toString();
          if (html.includes('<head>') && /id=["']root["']/.test(html)) html=html.replace('<head>','<head><script src="/fleet.js"></script><link rel="stylesheet" href="/fleet.css">');
          delete headers['content-length']; res.writeHead(response.statusCode,headers);res.end(html);
        });
      } else {res.writeHead(response.statusCode,headers);response.pipe(res);}
    });
    upstream.on('error',()=>{if(!res.headersSent)json(res,503,{error:'Local OpenChamber is starting.'});else res.destroy();});
    res.on('close',()=>upstream.destroy());req.pipe(upstream);
  } catch(error) { if (!res.headersSent) json(res,502,{error:'The local voice request failed. Check the API key and local runtime log.'}); else res.destroy(); console.error(error?.name || 'Error'); }
});
server.on('upgrade',(req,socket,head)=>{
  const target=backendPath(req.url);
  if(!localRequestAllowed(req,port)||!target){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path:target,headers:req.headers});
  upstream.on('upgrade',(response,remote,remoteHead)=>{
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');
    if(head.length)remote.write(head);if(remoteHead.length)socket.write(remoteHead);socket.pipe(remote).pipe(socket);
    socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());socket.on('close',()=>remote.destroy());
  });
  upstream.on('response',()=>socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  upstream.on('error',()=>socket.destroy());upstream.end();
});
async function stop(){if(closing)return;closing=true;server.close();await controller?.stop({exitProcess:false});process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
server.listen(port,'127.0.0.1');
const { startWebUiServer } = await import('@openchamber/web/server/index.js');
controller = await startWebUiServer({ port:backendPort, host:'127.0.0.1', attachSignals:false, exitOnShutdown:false });
announce(`OpenChamber voice: http://127.0.0.1:${port}/\nProject: ${project}\nPress Control-C to stop. Conversations and tool logs stay in this computer's OpenCode data directory.`);
