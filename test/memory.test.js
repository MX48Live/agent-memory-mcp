import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory, OpenAI, createWorker, canonical, digest, heads, packSource, unpackSource } from '../worker/index.js';

class FakeOpenAI {
  constructor() { this.stores = []; this.files = []; this.attachments = new Map(); this.contents = new Map(); this.seq = 0; this.proposals = []; this.modelCalls = []; this.indexPending = false; this.badCitation = false; this.uploadFailure = false; }
  async list(path) {
    if (path === '/vector_stores') return structuredClone(this.stores);
    if (path === '/files') return structuredClone(this.files);
    return structuredClone(this.attachments.get(path.split('/')[2]) || []);
  }
  async content(id) { assert(this.contents.has(id)); return this.contents.get(id); }
  async upload(filename, content) {
    if (this.uploadFailure && filename.includes('--knowledge--')) throw new Error('connection interrupted');
    const file = { id: `file-${++this.seq}`, filename };
    this.files.push(file); this.contents.set(file.id, content); return file;
  }
  async request(path, options) {
    if (path === '/vector_stores') {
      const store = { id: `vs-${++this.seq}`, ...options.body }; this.stores.push(store); return store;
    }
    const id = path.split('/')[2];
    if (path.endsWith('/search')) return { data: (this.attachments.get(id) || []).filter(f => f.attributes.record_type === options.body.filters.filters.at(-1).value).map(f => ({ file_id: f.id, score: 1, content: [] })) };
    const file = { id: options.body.file_id, attributes: options.body.attributes, status: this.indexPending ? 'in_progress' : 'completed' };
    this.attachments.set(id, [...(this.attachments.get(id) || []), file]); return file;
  }
  async generate(kind, instructions, input) {
    this.modelCalls.push({ kind, input });
    if (kind === 'write' && input.task) return { changes: this.proposals.shift() ?? [{ memory_id: 'model-selection', title: 'Model selection', content: input.task.knowledge[0] || input.task.summary, replaces: [], conflict: false, conflict_reason: '' }] };
    return { answer: 'Saved evidence answers this question.', citations: this.badCitation ? ['file-invented'] : [input.evidence[0].file_id] };
  }
  completeIndexing() { for (const files of this.attachments.values()) for (const file of files) file.status = 'completed'; }
}
const base = { project_key: 'demo', task_key: 'chat:task-1', summary: 'Selected memory models.', knowledge: ['Use Sol for writes.'], sources: ['User confirmed in this chat.'], validation: 'Design reviewed.', duration: '~5m', caveats: ['Not deployed.'] };
async function fixture() {
  const api = new FakeOpenAI(); const env = { OPENAI_API_KEY: 'test-only', MEMORY_NAMESPACE: 'test' };
  const memory = new Memory(env, api);
  await memory.memory_projects({ action: 'create', project_key: 'demo' });
  return { api, env, memory };
}
function rpc(worker, name, args, headers = { authorization: 'Bearer local-test' }) {
  return worker.fetch(new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), { MEMORY_LOCAL_TOKEN: 'local-test' });
}

test('canonical hashes ignore object property order', async () => {
  assert.equal(canonical({ b: 2, a: [1] }), canonical({ a: [1], b: 2 }));
  assert.equal(await digest({ a: 1, b: 2 }), await digest({ b: 2, a: 1 }));
});
test('save writes knowledge and one separate completion log', async () => {
  const { memory, api } = await fixture();
  const saved = await memory.memory_complete(base);
  assert.equal(saved.status, 'saved'); assert.equal(saved.knowledge_created, 1);
  assert.equal(api.files.filter(f => f.filename.includes('--log--')).length, 1);
  const read = await memory.memory_read({ project_key: 'demo', file_id: saved.log_file_id });
  assert.match(read.text, /Design reviewed/); assert.match(read.text, /~5m/); assert.match(read.text, /Not deployed/);
});
test('identical retries from a fresh instance reuse the plan and files', async () => {
  const { memory, api, env } = await fixture();
  const first = await memory.memory_complete(base); const count = api.files.length;
  const retry = await new Memory(env, api).memory_complete(base);
  assert.equal(retry.operation_id, first.operation_id); assert.equal(api.files.length, count);
  assert.equal(api.modelCalls.filter(c => c.input.task).length, 1);
});
test('same task key with changed payload is rejected', async () => {
  const { memory } = await fixture(); await memory.memory_complete(base);
  await assert.rejects(memory.memory_complete({ ...base, summary: 'Different task' }), { code: 'task_key_reused' });
});
test('indexing resumes without a background worker or local state', async () => {
  const { memory, api, env } = await fixture(); api.indexPending = true;
  const result = await memory.memory_complete(base); assert.equal(result.status, 'pending');
  assert.equal(api.files.filter(f => f.filename.includes('--log--')).length, 0);
  api.completeIndexing(); api.indexPending = false;
  const resumed = await new Memory(env, api).memory_status({ project_key: 'demo', operation_id: result.operation_id, resume: true });
  assert.equal(resumed.status, 'saved');
});
test('upload failure leaves a persisted plan recoverable by another instance', async () => {
  const { memory, api, env } = await fixture(); api.uploadFailure = true;
  await assert.rejects(memory.memory_complete(base)); api.uploadFailure = false;
  const op = await digest(['test', 'demo', base.task_key]);
  const result = await new Memory(env, api).memory_status({ project_key: 'demo', operation_id: op, resume: true });
  assert.equal(result.status, 'saved');
});
test('unexplained changes preserve the established fact and expose a conflict', async () => {
  const { memory, api } = await fixture(); const first = await memory.memory_complete(base);
  api.proposals.push([{ memory_id: 'model-selection', title: 'Model selection', content: 'Use Luna for writes.', replaces: [first.revisions[0].revision_id], conflict: false, conflict_reason: '' }]);
  const next = await memory.memory_complete({ ...base, task_key: 'chat:task-2', knowledge: ['Use Luna for writes.'] });
  assert.equal(next.status, 'conflict');
  const query = await memory.memory_query({ project_key: 'demo', query: 'Which write model?' });
  assert.equal(query.status, 'conflict'); assert.equal(query.conflicts[0].revisions.length, 2);
});
test('explicit corrections supersede all named predecessors and preserve history', async () => {
  const { memory, api } = await fixture(); const first = await memory.memory_complete(base);
  const store = await memory.store('demo'); const old = (await memory.catalogue(store)).current[0];
  api.proposals.push([{ memory_id: old.memory_id, title: 'Model selection', content: 'Use Luna for writes.', replaces: [old.revision_id], conflict: false, conflict_reason: '' }]);
  const corrected = await memory.memory_complete({ ...base, task_key: 'chat:correction', knowledge: ['Use Luna for writes.'], corrections: [{ memory_id: old.memory_id, replaces: [old.revision_id], reason: 'User explicitly corrected this.' }] });
  assert.equal(corrected.status, 'saved');
  assert.equal((await memory.memory_read({ project_key: 'demo', file_id: old.file_id })).status, 'historical');
  const query = await memory.memory_query({ project_key: 'demo', query: 'Which write model?' });
  assert.equal(query.evidence.length, 1); assert.match(query.evidence[0].text, /Use Luna for writes/);
  assert.notEqual(query.evidence[0].revision_id, first.revisions[0].revision_id);
});
test('stale explicit correction does not overwrite the newer revision', async () => {
  const { memory } = await fixture(); await memory.memory_complete(base);
  await assert.rejects(memory.memory_complete({ ...base, task_key: 'chat:stale', corrections: [{ memory_id: 'model-selection', replaces: ['nonexistent'], reason: 'Old client' }] }), { code: 'revision_conflict' });
});
test('forks are conflicts; timestamps do not choose a winner', () => {
  const root = { revision_id: 'root', replaces: [], conflict: false };
  const a = { revision_id: 'a', replaces: ['root'], conflict: false };
  const b = { revision_id: 'b', replaces: ['root'], conflict: false };
  assert.deepEqual(heads([root, a, b]).map(v => v.revision_id), ['a', 'b']);
});
test('model cannot invent predecessor references', async () => {
  const { memory, api } = await fixture(); api.proposals.push([{ memory_id: 'new-fact', title: 'Fact', content: 'Fact', replaces: ['made-up'], conflict: false, conflict_reason: '' }]);
  await assert.rejects(memory.memory_complete(base), { code: 'model_invalid' });
  assert.equal(api.files.length, 0);
});
test('project query includes global but excludes other projects and logs', async () => {
  const { memory } = await fixture(); await memory.memory_complete(base);
  for (const project_key of ['global', 'other']) {
    await memory.memory_projects({ action: 'create', project_key });
    await memory.memory_complete({ ...base, project_key, task_key: `${project_key}:1` });
  }
  const query = await memory.memory_query({ project_key: 'demo', query: 'Models?' });
  assert.deepEqual(query.evidence.map(e => e.project_key).sort(), ['demo', 'global']);
  assert(query.evidence.every(e => e.memory_id));
  const logs = await memory.memory_query({ project_key: 'demo', query: 'What did we do?', record_type: 'log', include_global: false });
  assert.equal(logs.evidence.length, 1); assert.match(logs.evidence[0].text, /# Task completion/);
});
test('foreign files cannot be read by arbitrary file id', async () => {
  const { memory } = await fixture(); await memory.memory_complete(base);
  await assert.rejects(memory.memory_read({ project_key: 'demo', file_id: 'file-secret-elsewhere' }), { code: 'file_not_available' });
});
test('empty retrieval makes no query-model call', async () => {
  const { memory, api } = await fixture();
  assert.equal((await memory.memory_query({ project_key: 'demo', query: 'Anything?' })).status, 'insufficient_memory');
  assert.equal(api.modelCalls.length, 0);
});
test('invented citations are rejected', async () => {
  const { memory, api } = await fixture(); await memory.memory_complete(base); api.badCitation = true;
  await assert.rejects(memory.memory_query({ project_key: 'demo', query: 'Models?' }), { code: 'invalid_citation' });
});
test('queries route directly to Luna or explicit Sol synthesis', async () => {
  const { memory, api } = await fixture(); await memory.memory_complete(base);
  await memory.memory_query({ project_key: 'demo', query: 'Models?' }); assert.equal(api.modelCalls.at(-1).kind, 'query');
  await memory.memory_query({ project_key: 'demo', query: 'Models?', mode: 'complex' }); assert.equal(api.modelCalls.at(-1).kind, 'write');
});
test('credential-like inputs are rejected before persistence', async () => {
  const { memory, api } = await fixture();
  await assert.rejects(memory.memory_complete({ ...base, summary: 'sk-proj-' + 'a'.repeat(30) }), { code: 'sensitive_input' });
  assert.equal(api.files.length, 0);
});
test('duplicate project keys are surfaced instead of guessed', async () => {
  const { memory, api } = await fixture(); api.stores.push({ ...api.stores[0], id: 'vs-other' });
  await assert.rejects(memory.projects(), { code: 'project_conflict' });
});
test('incompatible plans for one operation are surfaced', async () => {
  const { memory, api } = await fixture(); const saved = await memory.memory_complete(base);
  const original = api.files.find(f => f.filename.endsWith('.plan.md'));
  await api.upload(original.filename, '{}');
  await assert.rejects(memory.memory_status({ project_key: 'demo', operation_id: saved.operation_id }), { code: 'operation_conflict' });
});
test('local forged Sites headers do not bypass local token authentication', async () => {
  const worker = createWorker(() => { throw new Error('must not run'); });
  const result = await rpc(worker, 'memory_projects', { action: 'list' }, { 'oai-authenticated-user-id': 'forged' });
  assert.equal(result.status, 401);
});
test('RPC rejects invalid tool arguments without calling OpenAI', async () => {
  const worker = createWorker(() => { throw new Error('must not run'); });
  const response = await rpc(worker, 'memory_complete', { ...base, unexpected: true });
  const payload = await response.json(); assert.equal(payload.result.isError, true);
  assert.equal(JSON.parse(payload.result.content[0].text).code, 'invalid_input');
});
test('RPC advertises instructions and tools without requiring an API key', async () => {
  const request = new Request('https://private.chatgpt.site/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) });
  const result = await createWorker().fetch(request, {}); const payload = await result.json();
  assert.match(payload.result.instructions, /memory_complete/);
  assert.deepEqual(payload.result.supportedVersions, ['2026-07-28']);
});
test('API errors redact upstream response bodies', async () => {
  const api = new OpenAI({ OPENAI_API_KEY: 'never-echo-this' }, async () => new Response('sensitive upstream content', { status: 401 }));
  await assert.rejects(api.list('/files'), error => error.code === 'upstream_error' && !error.message.includes('sensitive') && !error.message.includes('never-echo'));
});
test('native fetch is bound to the Worker global rather than the API instance', async () => {
  const api = new OpenAI({ OPENAI_API_KEY: 'test' }, async function () {
    assert.equal(this, globalThis);
    return Response.json({ data: [], has_more: false });
  });
  assert.deepEqual(await api.list('/files'), []);
});
test('pagination follows all pages and rejects incomplete scans', async () => {
  let calls = 0;
  const api = new OpenAI({ OPENAI_API_KEY: 'test' }, async () => Response.json(++calls === 1 ? { data: [{ id: 'one' }], has_more: true } : { data: [{ id: 'two' }], has_more: false }));
  assert.equal((await api.list('/files')).length, 2);
  calls = 0; await assert.rejects(api.list('/files', 1), { code: 'catalogue_incomplete' });
});
test('new collections report pending when listing visibility is delayed', async () => {
  const api = new FakeOpenAI();
  const original = api.list.bind(api); let reads = 0;
  api.list = async path => path === '/vector_stores' && ++reads < 3 ? [] : original(path);
  const memory = new Memory({ MEMORY_NAMESPACE: 'test' }, api);
  const result = await memory.memory_projects({ action: 'create', project_key: 'new-project' });
  assert.equal(result.status, 'pending'); assert(result.created_vector_store_id);
  assert.equal((await memory.projects()).length, 1);
});
test('recoverable source preserves Unicode, whitespace and exact original text', async () => {
  const source = '# สวัสดี 🌏\n\n  Keep this spacing.\n';
  const packed = await packSource(source);
  assert.equal(await unpackSource(packed), source);
  assert.equal(await unpackSource(packed.replace(/(AGENT_MEMORY_SOURCE_V1\n)([^\n]+)/, (_, marker, data) => marker + data.match(/.{1,12}/g).join('\n'))), source);
  await assert.rejects(unpackSource(packed.replace(/SHA256 [a-f0-9]/, 'SHA256 f')), { code: 'invalid_document' });
});
test('source reads use parsed Vector Store content, never raw Files downloads', async () => {
  const packed = await packSource('exact document'); const paths = [];
  const api = new OpenAI({ OPENAI_API_KEY: 'test' }, async url => { paths.push(url); return Response.json({ data: [{ text: packed }], has_more: false }); });
  assert.equal(await api.content('file-one', 'vs-one'), 'exact document');
  assert.match(paths[0], /vector_stores\/vs-one\/files\/file-one\/content$/);
});
test('RPC does not leak unexpected exception messages', async () => {
  const worker = createWorker(() => ({ memory_projects() { throw new Error('secret-value'); } }));
  const response = await rpc(worker, 'memory_projects', { action: 'list' });
  assert(!JSON.stringify(await response.json()).includes('secret-value'));
});

export { FakeOpenAI, base, fixture };
