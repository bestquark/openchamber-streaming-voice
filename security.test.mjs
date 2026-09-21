import test from 'node:test';
import assert from 'node:assert/strict';
import { localRequestAllowed, speechConfig, resolveSecret, merge } from './config.mjs';
test('foreign websites and DNS rebinding cannot invoke the local gateway',()=>{
  for(const headers of [
    {host:'127.0.0.1:4260',origin:'https://foreign.invalid'},
    {host:'foreign.invalid:4260'},
    {host:'127.0.0.1:4260',origin:'null'},
    {host:'127.0.0.1:4260','sec-fetch-site':'cross-site'},
    {host:'127.0.0.1:9999'},
  ])assert.equal(localRequestAllowed({headers},4260),false);
  assert.equal(localRequestAllowed({headers:{host:'127.0.0.1:4260',origin:'http://127.0.0.1:4260'}},4260),true);
  assert.equal(localRequestAllowed({headers:{host:'localhost:4260'}},4260),true);
});
test('config merges preserve unrelated settings and reject prototype injection',()=>{
  const original={provider:{other:{options:{apiKey:'fixture'}}},permission:{bash:'ask'}};
  const merged=merge(original,JSON.parse('{"provider":{"custom":{"name":"Test"}},"__proto__":{"polluted":true}}'));
  assert.equal(merged.provider.other.options.apiKey,'fixture');assert.equal(merged.permission.bash,'ask');assert.equal({}.polluted,undefined);
});
test('reuses only a key for the exact speech provider destination',()=>{
  const config={model:'example/chat',provider:{example:{options:{baseURL:'https://speech.example.test/v1',apiKey:'{env:TEST_KEY}'}}}};
  const settings=speechConfig(config,{TEST_KEY:'fixture-token'});
  assert.equal(settings.stt.key,'fixture-token');assert.equal(settings.tts.key,'fixture-token');
  const different=speechConfig(config,{TEST_KEY:'fixture-token',VOICE_TTS_BASE_URL:'https://another.example.test/v1'});
  assert.equal(different.tts.key,'');assert.equal(different.stt.key,'fixture-token');
});
test('supports separate providers and refuses credential or insecure URL confusion',()=>{
  const env={VOICE_STT_BASE_URL:'http://127.0.0.1:9000/v1',VOICE_TTS_BASE_URL:'https://speech.example.test/v1',VOICE_TTS_API_KEY:'tts-fixture',VOICE_STT_MODEL:'recognizer',VOICE_TTS_MODEL:'speaker'};
  const settings=speechConfig({},env);assert.equal(settings.stt.key,'');assert.equal(settings.tts.key,'tts-fixture');assert.equal(settings.tts.model,'speaker');
  assert.throws(()=>speechConfig({}, {...env,VOICE_TTS_BASE_URL:'https://key@bad.example/v1'}));
  assert.throws(()=>speechConfig({}, {...env,VOICE_TTS_BASE_URL:'http://remote.example/v1'}));
  assert.throws(()=>speechConfig({}, {...env,VOICE_LANGUAGE_URL:'https://other.example/language'}));
  assert.equal(speechConfig({}, {...env,VOICE_LANGUAGE_URL:'https://other.example/language',VOICE_LANGUAGE_API_KEY:''}).language.key,'');
  assert.throws(()=>resolveSecret('{env:MISSING}',{}));
});
