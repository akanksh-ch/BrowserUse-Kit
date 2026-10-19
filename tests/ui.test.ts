import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('operator state never invents readiness or timestamps; lifecycle events filter as system', async () => {
  const nodes = new Map<string, any>();
  const node = () => ({ textContent: '', disabled: false, hidden: false, value: '', children: [] as any[], addEventListener() {}, append(...children: any[]) { this.children.push(...children); }, replaceChildren() { this.children = []; }, get childElementCount() { return this.children.length; } });
  const document = { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElement: node, querySelectorAll: () => [] };
  const source = readFileSync(new URL('../frontend/controller.js', import.meta.url), 'utf8').replace(/run\(async \(\) => \{ try \{ const me =[\s\S]*$/, '');
  await runInNewContext(source + `(async () => {
    selected = { id: 'test', state: 'starting', desiredState: 'ready' };
    renderWorkspace();
    assert.equal($('workspace-state').textContent, 'Observed: starting · Desired: ready');
    assert.equal($('viewer-connect').disabled, true);
    assert.equal($('takeover').disabled, true);
    assert.equal($('release').disabled, true);
    selected.state = 'ready'; renderWorkspace();
    assert.equal($('viewer-connect').disabled, false);
    assert.equal(tokenStatus({expiresAt: Date.now() - 1000}), 'expired');
    assert.equal(tokenStatus({expiresAt: Date.now() + 60000}), 'active');
    assert.equal(tokenStatus({revoked: true, expiresAt: Date.now() + 60000}), 'revoked');
    assert.equal(tokenStatus({}), 'expiry not reported');
    assert.equal(sourceOf({type:'workspace.created'}), 'system');
    assert.equal(sourceOf({type:'agent.status'}), 'agent');
    events = [{type:'workspace.created',summary:'Created'}];
    $('event-filter').value = 'system'; renderEvents();
    assert.equal($('events').children[0].children[0].textContent, 'Time not reported');
    assert.equal($('events').children[0].children[1].textContent, 'system');
    human = true; rfb = {viewOnly:false};
    await assert.rejects(lease('human', 'release'), /inspect runtime health/);
    assert.equal(human, false);
    assert.equal(rfb.viewOnly, true);
    assert.equal($('control-state').textContent, 'View only · release requested');
  })()`, { document, setInterval() {}, assert, Headers, fetch: async () => new Response(JSON.stringify({error:'Operation failed'}), {status:503,headers:{'Content-Type':'application/json'}}) });
});
