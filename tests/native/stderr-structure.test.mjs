import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStderrStructure, STDERR_STRUCTURE_LIMIT, summarizeStderrStructure } from './stderr-structure.mjs';

const wrap = body => `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">${body}</Objs>`;
const summarize = text => summarizeStderrStructure(Buffer.from(text));

test('complete CLIXML returns only fixed keys and stream counts, never private data', () => {
  const result = summarize(wrap('<Obj S="progress" RefId="0"><MS><S N="private-name">C:\\private\\secret &amp; token</S></MS></Obj><S S="warning">secret</S><S S="unexpected-private">secret</S>'));
  assert.equal(result.status, 'clixml');
  assert.equal(result.xml, true);
  assert.equal(result.root, true);
  assert.equal(result.streams.progress, 1);
  assert.equal(result.streams.warning, 1);
  assert.equal(result.streams.unknown, 1);
  for (const secret of ['private', 'secret', 'token', 'RefId', 'Obj', 'xmlns', 'Version']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('stream collector handles split header, UTF8 and tags identically to whole input', () => {
  const input = Buffer.from(wrap('<S S="error">中文</S>'));
  const collector = createStderrStructure();
  for (const byte of input) collector.push(Buffer.from([byte]));
  assert.deepEqual(collector.summarize(), summarizeStderrStructure(input));
});

test('false headers and arbitrary XML do not establish CLIXML', () => {
  for (const text of ['private #< CLIXML\n', '#< CLIXML fake\n<Objs/>', '<Objs/>', wrap('').replace('powershell/2004/04', 'private'), wrap('').replace('Version="1.1.0.1"', 'Version="unknown"')]) {
    const result = summarize(text);
    assert.notEqual(result.status, 'clixml');
    assert.equal(Object.values(result.streams).some(Boolean), false);
  }
  assert.equal(summarize('').status, 'empty');
});

test('malformed or unsupported XML cannot expose partial stream matches', () => {
  for (const body of [
    '<S S="warning">private</Obj>', '<S S="warning" S="error"/>', '<S S="warning">&private;</S>',
    '<!DOCTYPE Objs [<!ENTITY x SYSTEM "file:///private">]><S S="warning">&x;</S>',
    '<S S="warning">&#0;</S>', '<S S="warning">&#xD800;</S>', '<S S="warning">bad & text</S>',
    '<S S="warning"><![CDATA[private]]></S>', '<S S="warning" xmlns="private"/>',
    'private-root-text', '<T S="warning">private</T>', '<UnknownPrivate/>', '<S S="warning">private\u0000</S>', '<S S="warning">]]></S>', '<?private value?>',
    '<S S="warning"private="value"/>', '<S S="warning" N="a<b"/>',
  ]) {
    const result = summarize(wrap(body));
    assert.equal(result.status, 'malformed', body);
    assert.equal(Object.values(result.streams).some(Boolean), false, body);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  for (const text of [wrap('<S S="warning"/>') + 'private', wrap('') + wrap(''), wrap('<S S="warning"/>').slice(0, -7)]) {
    assert.equal(summarize(text).status, 'malformed');
  }
});

test('illegal UTF8 and incomplete capture never count streams', () => {
  const bytes = Buffer.concat([Buffer.from(wrap('<S S="warning"/>')), Buffer.from([0xff])]);
  assert.equal(summarizeStderrStructure(bytes).validUtf8, false);
  assert.equal(summarizeStderrStructure(bytes).status, 'malformed');
  const partial = summarizeStderrStructure(Buffer.from(wrap('<S S="warning"/>')), { complete: false });
  assert.equal(partial.status, 'truncated');
  assert.equal(Object.values(partial.streams).some(Boolean), false);
});

test('stream bytes, depth and node counts are bounded', () => {
  const collector = createStderrStructure();
  collector.push(Buffer.from(wrap('<S S="warning"/>')));
  collector.push(Buffer.alloc(STDERR_STRUCTURE_LIMIT, 65));
  const result = collector.summarize();
  assert.equal(result.status, 'truncated');
  assert.equal(result.capturedBytes, STDERR_STRUCTURE_LIMIT);
  assert.equal(Object.values(result.streams).some(Boolean), false);
  assert.equal(summarize(wrap('<Obj>'.repeat(33) + '</Obj>'.repeat(33))).status, 'malformed');
  assert.equal(summarize(wrap('<S/>'.repeat(513))).status, 'malformed');
});

test('predefined and legal numeric entities are validated without emitting their values', () => {
  const result = summarize(wrap('<S S="warning">&amp;&lt;&gt;&quot;&apos;&#65;&#x1F600;</S>'));
  assert.equal(result.status, 'clixml');
  assert.equal(result.streams.warning, 1);
});
