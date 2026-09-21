import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';

export function readConfig() {
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  let config = {};
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(root, 'opencode', name);
    if (!fs.existsSync(file)) continue;
    const errors = []; const value = parse(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length) throw Error('The existing OpenCode config contains invalid JSON/JSONC. Fix it before setup.');
    config = merge(config, value);
  }
  return merge(config, JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'));
}
export function merge(left, right) {
  const result = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(result[key], value) : value;
  }
  return result;
}
export function resolveSecret(value, env = process.env) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw Error('API keys must be strings or env/file references.');
  const variable = value.match(/^\{env:([^}]+)\}$/), file = value.match(/^\{file:([^}]+)\}$/);
  if (variable) value = env[variable[1]];
  if (file) value = fs.readFileSync(file[1].replace(/^~\//, os.homedir() + '/'), 'utf8');
  if (!value || /[\r\n{}]/.test(value.trim())) throw Error('A configured API key reference could not be resolved.');
  return value.trim();
}
export function apiBase(value) {
  if (!value) throw Error('Configure VOICE_API_BASE_URL or the separate VOICE_STT_BASE_URL and VOICE_TTS_BASE_URL.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Use an HTTP(S) API base URL without embedded credentials, query or fragment.');
  if (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Remote speech services require HTTPS.');
  return url.href.replace(/\/$/, '');
}
export function speechConfig(config = readConfig(), env = process.env) {
  const providers = Object.values(config.provider || {});
  const selected = config.provider?.[config.model?.split('/')[0]] || (providers.length === 1 ? providers[0] : undefined);
  const common = env.VOICE_API_BASE_URL || selected?.options?.baseURL;
  const make = kind => {
    const base = apiBase(env[`VOICE_${kind}_BASE_URL`] || common);
    // A provider key is reusable only at the exact provider destination.
    const matching = providers.find(p => p.options?.baseURL?.replace(/\/$/, '') === base);
    const explicit = env[`VOICE_${kind}_API_KEY`] ?? (common && apiBase(common) === base ? env.VOICE_API_KEY : undefined);
    return { base, key: resolveSecret(explicit ?? matching?.options?.apiKey, env), model: env[`VOICE_${kind}_MODEL`] || (kind === 'STT' ? 'whisper-1' : 'tts-1') };
  };
  const stt = make('STT'), tts = make('TTS');
  let language;
  if (env.VOICE_LANGUAGE_URL) {
    const endpoint = new URL(env.VOICE_LANGUAGE_URL);
    apiBase(endpoint.href);
    // This optional adapter is same-origin with TTS unless given its own explicit key.
    if (endpoint.origin !== new URL(tts.base).origin && env.VOICE_LANGUAGE_API_KEY === undefined) throw Error('A different language-service origin requires VOICE_LANGUAGE_API_KEY (empty for no authentication).');
    language = { url: endpoint.href, key: resolveSecret(env.VOICE_LANGUAGE_API_KEY ?? tts.key, env) };
  }
  return { stt, tts, language, voice: env.VOICE_TTS_VOICE || 'alloy', languageFields: env.VOICE_TTS_LANGUAGE_FIELDS === '1' };
}
export function localRequestAllowed(req, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin) {
    try { const origin = new URL(req.headers.origin); if (origin.protocol !== 'http:' || !hosts.has(origin.host)) return false; }
    catch { return false; }
  }
  return true;
}
