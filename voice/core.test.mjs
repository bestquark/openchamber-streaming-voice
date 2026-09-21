import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechChunks, TurnDetector, connectWorkspaceEvents } from './core.mjs';
test('speech begins at a sentence boundary before final text is available', () => {
  const s = new SpeechChunks();
  assert.deepEqual(s.push('The services are '), []);
  assert.deepEqual(s.push('ready. Here is a longer explanation'), ['The services are ready.']);
  assert.deepEqual(s.push('', true), ['Here is a longer explanation']);
  assert.deepEqual(s.push('', true), []);
});
test('code blocks are not spoken across arbitrary network chunks', () => {
  const s = new SpeechChunks(); const output = [];
  for (const text of ['Here is the result.\n', '```bash\n', 'echo secret\n', '```\n', 'It worked.']) output.push(...s.push(text));
  output.push(...s.push('', true)); assert.deepEqual(output, ['Here is the result.', 'It worked.']);
});
test('long unpunctuated replies have a bounded first speech chunk', () => {
  const s = new SpeechChunks(); const result = s.push('word '.repeat(80));
  assert(result.length > 0); assert(result[0].length <= 200);
});
test('Chinese speech starts before the whole reply is decoded', () => {
  const s = new SpeechChunks();
  assert.deepEqual(s.push('你好，我可以帮助你。接下来'), ['你好，我可以帮助你。']);
  assert.deepEqual(s.push('做什么？'), ['接下来做什么？']);
});
test('brief noise does not start a turn; speech and silence end it', () => {
  const v = new TurnDetector();
  assert.equal(v.step(.95, 50), null); assert.equal(v.step(.001, 200), null);
  assert.equal(v.step(.95, 200), 'start'); assert.equal(v.step(.001, 800), null);
  assert.equal(v.step(.001, 550), null); assert.equal(v.step(.001, 50), 'finish');
});
test('barge-in needs sustained confident speech and respects disabled mode', () => {
  const v = new TurnDetector();
  assert.equal(v.step(.02, 1000, true), null);
  assert.equal(v.step(.98, 200, true), null);
  assert.equal(v.step(.98, 184, true), 'start');
  v.reset(); assert.equal(v.step(.98, 1000, true, false), null);
});
test('sustained nonspeech and isolated speech-like clicks never interrupt', () => {
  const v = new TurnDetector();
  for (let i = 0; i < 2000; i++) assert.equal(v.step(i % 12 < 2 ? .93 : .08, 32, true), null);
});
test('playback ending mid-candidate does not lower the interruption requirement', () => {
  const v = new TurnDetector();
  assert.equal(v.step(.96, 192, true), null);
  assert.equal(v.step(.96, 96, false), null);
  assert.equal(v.step(.96, 96, false), 'start');
});
test('invalid probabilities do not start a turn and muting clears accumulated onset', () => {
  const v = new TurnDetector();
  assert.equal(v.step(NaN, 1000, true), null);
  assert.equal(v.step(.98, 320, true), null);
  assert.equal(v.step(.98, 32, true, false), null);
  assert.equal(v.step(.98, 100, true), null);
});

class FakeEvents {
  constructor() { this.closed = false; }
  close() { this.closed = true; }
  emit(value) { this.onmessage({ data: JSON.stringify(value) }); }
}
test('a dropped workspace stream stays open and recovers only the missing speech', async () => {
  const chunks = new SpeechChunks(); let text = '', spoken = [], disconnects = 0, reconciliations = 0;
  const receive = full => { spoken.push(...chunks.push(full.slice(text.length))); text = full; };
  const connection = connectWorkspaceEvents('/event', {
    EventSourceClass: FakeEvents,
    onEvent: event => receive(event.text),
    onDisconnect: () => disconnects++,
    onReconnect: () => { reconciliations++; receive('First sentence. Second sentence.'); },
  });
  connection.source.onopen(); await connection.ready;
  connection.source.emit({ text: 'First sentence. Sec' });
  connection.source.onerror();
  assert.equal(connection.source.closed, false);
  connection.source.onopen(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(spoken, ['First sentence.', 'Second sentence.']);
  assert.equal(disconnects, 1); assert.equal(reconciliations, 1);
  connection.source.onopen(); await Promise.resolve();
  assert.equal(reconciliations, 1);
});
test('initial transient connection failure can recover without leaving a dead stream', async () => {
  const connection = connectWorkspaceEvents('/event', { EventSourceClass: FakeEvents, onEvent() {}, onDisconnect() {}, onReconnect() {} });
  connection.source.onerror(); connection.source.onopen(); await connection.ready;
  assert.equal(connection.source.closed, false);
});
test('an unreachable workspace closes its event stream after the startup deadline', async () => {
  const connection = connectWorkspaceEvents('/event', { EventSourceClass: FakeEvents, onEvent() {}, onDisconnect() {}, onReconnect() {}, timeoutMs: 10 });
  await assert.rejects(connection.ready, /timed out/);
  assert.equal(connection.source.closed, true);
});
