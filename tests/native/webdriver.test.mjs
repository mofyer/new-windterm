// Unit tests for the fetch-based WebDriver client against a stub W3C remote end.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { ELEMENT_KEY, Keys, WebDriverError, createWebDriver, elementId, keyActions, waitFor } from './webdriver.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A stub remote end that records requests and answers from `routes` ("METHOD /path" -> handler). */
async function stubRemote(routes) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = { method: req.method, path: req.url, contentType: req.headers['content-type'], body: body ? JSON.parse(body) : undefined };
    requests.push(request);
    const handler = routes[`${req.method} ${req.url}`];
    const [status, payload] = handler ? await handler(request) : [404, { value: { error: 'unknown command', message: `${req.method} ${req.url}`, stacktrace: '' } }];
    if (payload === undefined) return; // never answers
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

const ok = (value) => async () => [200, { value }];

test('new session sends W3C capabilities and session commands use the session path', async (t) => {
  const element = { [ELEMENT_KEY]: 'el-1' };
  const remote = await stubRemote({
    'POST /session': ok({ sessionId: 's 1', capabilities: { browserName: 'webview2', browserVersion: '130.0.2849.80' } }),
    'POST /session/s%201/timeouts': ok(null),
    'POST /session/s%201/element': ok(element),
    'POST /session/s%201/elements': ok([element, { ELEMENT: 'legacy-2' }]),
    'POST /session/s%201/element/el-1/click': ok(null),
    'POST /session/s%201/element/el-1/clear': ok(null),
    'POST /session/s%201/element/el-1/value': ok(null),
    'GET /session/s%201/element/el-1/text': ok('hello 中文'),
    'POST /session/s%201/execute/sync': async ({ body }) => [200, { value: { echoed: body.args } }],
    'POST /session/s%201/actions': ok(null),
    'DELETE /session/s%201/actions': ok(null),
    'GET /session/s%201/title': ok('New WindTerm · P0'),
    'GET /session/s%201/screenshot': ok(PNG.toString('base64')),
    'DELETE /session/s%201': ok(null),
  });
  t.after(remote.close);
  const driver = createWebDriver(remote.url);
  const { session, capabilities } = await driver.newSession({ alwaysMatch: { 'tauri:options': { application: '/app' } } });
  assert.equal(session.id, 's 1');
  assert.deepEqual(capabilities, { browserName: 'webview2', browserVersion: '130.0.2849.80' });
  assert.deepEqual(remote.requests[0], {
    method: 'POST', path: '/session', contentType: 'application/json; charset=utf-8',
    body: { capabilities: { alwaysMatch: { 'tauri:options': { application: '/app' } } } },
  });

  assert.equal(await session.setTimeouts({ script: 1000 }), null);
  const id = await session.findElement('#local-open');
  assert.equal(id, 'el-1');
  assert.deepEqual(await session.findElements('.tab'), ['el-1', 'legacy-2']);
  await session.click(id);
  await session.clear(id);
  await session.sendKeys(id, `echo hi${Keys.ENTER}`);
  assert.equal(await session.getText(id), 'hello 中文');
  assert.deepEqual(await session.execute('return arguments', [1, 'two']), { echoed: [1, 'two'] });
  await session.performKeys('ab');
  await session.releaseActions();
  assert.equal(await session.title(), 'New WindTerm · P0');
  assert.deepEqual(await session.screenshot(), PNG);
  await session.delete();

  const byPath = (path) => remote.requests.find(r => r.path === path && r.method === 'POST');
  assert.deepEqual(byPath('/session/s%201/element').body, { using: 'css selector', value: '#local-open' });
  assert.deepEqual(byPath('/session/s%201/element/el-1/value').body, { text: 'echo hi' });
  assert.deepEqual(byPath('/session/s%201/execute/sync').body, { script: 'return arguments', args: [1, 'two'] });
  assert.deepEqual(byPath('/session/s%201/actions').body, keyActions('ab'));
  assert.deepEqual(byPath('/session/s%201/element/el-1/click').body, {});
  const methods = remote.requests.map(r => `${r.method} ${r.path}`);
  assert.ok(methods.includes('DELETE /session/s%201'));
  assert.ok(methods.includes('DELETE /session/s%201/actions'));
  const get = remote.requests.find(r => r.method === 'GET');
  assert.equal(get.contentType, undefined, 'GET requests carry no JSON body');
});

test('W3C error responses become WebDriverError with the error code', async (t) => {
  const remote = await stubRemote({
    'POST /session': ok({ sessionId: 'abc', capabilities: {} }),
    'POST /session/abc/element': async () => [404, { value: { error: 'no such element', message: 'Unable to locate #x', stacktrace: '' } }],
    'POST /session/abc/element/e/value': async () => [400, { value: { error: 'element not interactable', message: 'hidden', stacktrace: '' } }],
  });
  t.after(remote.close);
  const { session } = await createWebDriver(remote.url).newSession({});
  await assert.rejects(session.findElement('#x'), (error) => {
    assert.ok(error instanceof WebDriverError);
    assert.equal(error.error, 'no such element');
    assert.equal(error.status, 404);
    assert.match(error.message, /POST \/session\/abc\/element: no such element — Unable to locate #x/);
    return true;
  });
  await assert.rejects(session.sendKeys('e', 'x'), { name: 'WebDriverError', error: 'element not interactable' });
});

test('legacy non-zero status, invalid JSON, missing session id and unknown commands are errors', async (t) => {
  const remote = await stubRemote({
    'GET /status': async () => [200, { status: 13, value: { message: 'legacy failure' } }],
    'POST /session': async () => [200, { value: { capabilities: {} } }],
  });
  t.after(remote.close);
  const driver = createWebDriver(remote.url);
  await assert.rejects(driver.status(), { name: 'WebDriverError', message: /legacy failure/ });
  await assert.rejects(driver.newSession({}), { error: 'session not created' });

  const other = await stubRemote({ 'POST /session': ok({ sessionId: 'x' }), 'GET /session/x/title': async () => [200, 'not json'] });
  t.after(other.close);
  const { session } = await createWebDriver(other.url).newSession({});
  await assert.rejects(session.title(), { error: 'invalid response' });
  await assert.rejects(session.getText('missing'), { error: 'unknown command', status: 404 });
});

test('requests are bounded by the timeout and transport failures are WebDriverError', async (t) => {
  const remote = await stubRemote({ 'GET /status': async () => [200, undefined] });
  t.after(remote.close);
  const started = Date.now();
  await assert.rejects(createWebDriver(remote.url, { timeoutMs: 150 }).status(), { name: 'WebDriverError', error: 'timeout' });
  assert.ok(Date.now() - started < 5_000);
  await assert.rejects(createWebDriver('http://127.0.0.1:1').status(), { name: 'WebDriverError', error: 'transport error' });
});

test('elementId accepts W3C and legacy references and rejects anything else', () => {
  assert.equal(elementId({ [ELEMENT_KEY]: 'w3c' }), 'w3c');
  assert.equal(elementId({ ELEMENT: 'legacy' }), 'legacy');
  assert.throws(() => elementId({}), { error: 'no such element' });
  assert.throws(() => elementId(null), WebDriverError);
});

test('keyActions presses and releases each code point in order', () => {
  const { actions } = keyActions(`a中${Keys.ENTER}`);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'key');
  assert.deepEqual(actions[0].actions, [
    { type: 'keyDown', value: 'a' }, { type: 'keyUp', value: 'a' },
    { type: 'keyDown', value: '中' }, { type: 'keyUp', value: '中' },
    { type: 'keyDown', value: '' }, { type: 'keyUp', value: '' },
  ]);
});

test('waitFor retries until truthy, reports the last error on timeout and stops on fatal errors', async () => {
  let calls = 0;
  assert.equal(await waitFor(() => (++calls >= 3 ? 'ready' : null), { intervalMs: 5 }), 'ready');
  assert.equal(calls, 3);
  await assert.rejects(waitFor(() => { throw new Error('page navigating'); }, { timeoutMs: 50, intervalMs: 5, description: 'the tab' }),
    /timed out after 50 ms waiting for the tab; last error: page navigating/);
  let fatalCalls = 0;
  await assert.rejects(waitFor(() => { fatalCalls++; throw Object.assign(new Error('driver exited'), { fatal: true }); }, { timeoutMs: 1_000, intervalMs: 5 }), /driver exited/);
  assert.equal(fatalCalls, 1);
});
