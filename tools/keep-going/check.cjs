// Run: node tools/keep-going/check.cjs [plugin-directory] [pi-install-directory]
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const plugin = process.argv[2] || path.join(os.homedir(), '.pi/agent/npm/node_modules/pi-keep-going');
const install = process.argv[3] || path.join(os.homedir(), '.pi/agent/install/releases/1.3.0');
const { createJiti } = require(path.join(install, 'node_modules/jiti'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-check-'));
const stub = path.join(temp, 'pi.cjs');
fs.writeFileSync(stub, `exports.getAgentDir = () => ${JSON.stringify(temp)}; exports.CONFIG_DIR_NAME = '.pi'; exports.readStoredCredential = () => global.__kgCredential;`);
const jiti = createJiti(__filename, { alias: { '@earendil-works/pi-coding-agent': stub }, moduleCache: false });
const { codexResetFromBody, fetchCodexReset } = jiti(path.join(plugin, 'src/limits/codex.ts'));
const now = 1000000;
const window = (seconds, used_percent = 100) => ({ reset_after_seconds: seconds, used_percent });
const reset = (primary_window, secondary_window) => codexResetFromBody({ rate_limit: { primary_window, secondary_window } }, now)?.at.getTime();
assert.equal(reset(window(60), window(3600)), now + 3600000);
assert.equal(reset(window(60, 10), window(3600)), now + 3600000);
assert.equal(reset(window(60), window(3600, 10)), now + 60000);
assert.equal(reset({ reset_at: 1100, used_percent: 20 }), 1100000);
assert.equal(reset({ reset_at: -1 }), undefined);
assert.equal(codexResetFromBody({}, now), null);
(async () => {
  const jwt = 'x.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url') + '.x';
  await fetchCodexReset({ token: jwt, now, fetchImpl: async (_, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${jwt}`);
    assert.equal(options.headers['ChatGPT-Account-Id'], 'account');
    return { ok: true, status: 200, json: async () => ({ rate_limit: { primary_window: window(60) } }) };
  }});
  const extension = jiti(path.join(plugin, 'src/index.ts')).default;
  let command; const events = {}; const notices = []; const requested = [];
  extension({ on: (name, fn) => { events[name] = fn; }, registerCommand: (_, value) => { command = value.handler; }, appendEntry() {} });
  const ctx = { model: { provider: 'openai' }, ui: { notify: (text) => notices.push(text), setWidget() {} }, modelRegistry: { getApiKeyForProvider: async (provider) => { requested.push(provider); return jwt; } } };
  global.__kgCredential = undefined;
  await command('auto', ctx);
  assert.match(notices.pop(), /separate Codex OAuth login/);
  assert.deepEqual(requested, []);
  global.__kgCredential = { type: 'api_key', key: 'never-send-this' };
  await command('auto', ctx);
  assert.match(notices.pop(), /separate Codex OAuth login/);
  assert.deepEqual(requested, []);
  global.__kgCredential = { type: 'oauth' };
  const originalFetch = global.fetch;
  global.fetch = async (_, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${jwt}`);
    return { ok: true, status: 200, json: async () => ({ rate_limit: { primary_window: window(3600) } }) };
  };
  try {
    await command('auto', ctx);
    assert.deepEqual(requested, ['openai-codex']);
    assert.match(notices.pop(), /separate Codex OAuth quota; current model unchanged/);
    ctx.model.provider = 'openai-codex';
    await command('auto', ctx);
    assert.deepEqual(requested, ['openai-codex', 'openai-codex']);
    assert.match(notices.pop(), /^Auto: usage resets/);
    ctx.model.provider = 'unrelated';
    await command('auto', ctx);
    assert.match(notices.pop(), /isn't supported/);
  } finally { global.fetch = originalFetch; events.session_shutdown(); }
  console.log('PASS: Codex windows, auth headers, safe OpenAI fallback, native Codex, unsupported provider');
})().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch((error) => { console.error(error); process.exitCode = 1; });
