import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory, MemoryError, OpenAI, TOOLS, createWorker, canonical, digest, packSource, unpackSource } from '../worker/index.js';

const fact = (value = 'node', extra = {}) => ({ fact_key: 'backend.runtime', title: 'Backend runtime', content: `The backend runtime is ${value}.`, value, kind: 'current', memory_class: 'Fact', ...extra });
class FakeOpenAI {
  constructor() {
    this.stores = []; this.files = []; this.attachments = new Map(); this.contents = new Map(); this.seq = 0;
    this.proposals = []; this.maintenanceProposals = []; this.modelCalls = []; this.calls = [];
    this.indexPending = false; this.hideProgressAttributes = false; this.hideCompletedListAttributes = false; this.hideCompletedDetailAttributes = false; this.attachmentFailure = null; this.modelFailure = false; this.badCitation = false; this.uploadFailure = false; this.searchFileIds = null;
  }
  async list(path) {
    this.calls.push({ method: 'list', path });
    if (path === '/vector_stores') return structuredClone(this.stores);
    if (path === '/files') return structuredClone(this.files);
    return structuredClone(this.attachments.get(path.split('/')[2]) || []).map(file => this.hideProgressAttributes && file.status === 'in_progress' || this.hideCompletedListAttributes && file.status === 'completed' ? { ...file, attributes: {} } : file);
  }
  async content(id, storeId) {
    this.calls.push({ method: 'content', id, storeId });
    assert(this.contents.has(id), `missing fake content ${id}`);
    return this.contents.get(id);
  }
  async upload(filename, content) {
    this.calls.push({ method: 'upload', filename });
    if (this.uploadFailure && /--(?:capture|knowledge|wiki)--/.test(filename)) throw new Error('connection interrupted');
    const file = { id: `file-${++this.seq}`, filename };
    this.files.push(file); this.contents.set(file.id, content); return file;
  }
  async request(path, options = {}) {
    this.calls.push({ method: options.method || 'GET', path });
    if (path === '/vector_stores') {
      const store = { id: `vs-${++this.seq}`, ...options.body }; this.stores.push(store); return store;
    }
    const id = path.split('/')[2];
    if ((!options.method || options.method === 'GET') && /^\/vector_stores\/[^/]+\/files\/[^/]+$/.test(path)) {
      const file = (this.attachments.get(id) || []).find(v => v.id === path.split('/')[4]); assert(file, 'missing fake attachment detail');
      return { ...structuredClone(file), vector_store_id: id, ...(this.hideCompletedDetailAttributes ? { attributes: {} } : {}) };
    }
    if (path.endsWith('/search')) {
      const matches = (item, filter) => !filter || (filter.type === 'and' ? filter.filters.every(f => matches(item, f)) : filter.type === 'or' ? filter.filters.some(f => matches(item, f)) : filter.type === 'eq' ? item.attributes?.[filter.key] === filter.value : true);
      return { data: (this.attachments.get(id) || []).filter(f => f.status === 'completed' && matches(f, options.body.filters) && (!this.searchFileIds || this.searchFileIds.includes(f.id))).slice(0, options.body.max_num_results || 20).map(f => ({ file_id: f.id, score: 1, content: [] })) };
    }
    const uploaded = this.files.find(v => v.id === options.body.file_id);
    if (this.attachmentFailure && uploaded?.filename.includes(`--${this.attachmentFailure}--`)) throw new MemoryError('upstream_unavailable', 'Synthetic attachment interruption after upload.');
    assert(Object.keys(options.body.attributes).length <= 16, 'Vector Store file attributes exceed the supported key limit');
    for (const [key, value] of Object.entries(options.body.attributes)) {
      assert(key.length <= 64); assert(['string', 'number', 'boolean'].includes(typeof value));
      if (typeof value === 'string') assert(value.length <= 512, `indexed attribute ${key} exceeds 512 characters`);
      if (typeof value === 'number') assert(Number.isFinite(value));
    }
    const file = { id: options.body.file_id, attributes: options.body.attributes, status: this.indexPending ? 'in_progress' : 'completed' };
    this.attachments.set(id, [...(this.attachments.get(id) || []), file]); return file;
  }
  async generate(kind, instructions, input) {
    this.modelCalls.push({ kind, input: structuredClone(input) });
    if (this.modelFailure) throw new MemoryError('model_incomplete', 'Synthetic extraction interruption.');
    if (kind === 'write' && input.task) return { assertions: this.proposals.shift() ?? [fact('node', { content: input.task.knowledge[0] || input.task.summary })] };
    if (kind === 'write' && input.captures) {
      if (this.maintenanceProposals.length) return this.maintenanceProposals.shift();
      const source_ids = [...new Set([...input.captures.map(c => c.file_id), ...input.pages.flatMap(p => p.source_ids)])];
      const content = (input.current_assertions.length ? input.current_assertions : input.captures.flatMap(c => c.assertions || [])).map(a => a.content).join('\n\n');
      return { pages: [{ memory_id: 'backend', title: 'Backend', content: content || input.captures.map(c => c.content || '').join('\n') || 'No reusable assertions.', source_ids, links: [] }], findings: [], legacy_assertions: input.captures.filter(c => c.record_type === 'knowledge').map(c => ({ source_id: c.file_id, assertions: [fact('node', { content: c.content })] })) };
    }
    return { answer: input.evidence.map(e => e.text).join('\n'), citations: this.badCitation ? ['file-invented'] : [...new Set(input.evidence.map(e => e.file_id))] };
  }
  completeIndexing() { for (const files of this.attachments.values()) for (const file of files) file.status = 'completed'; }
  resetCalls() { this.calls = []; this.modelCalls = []; }
}
const base = { project_key: 'demo', task_key: 'chat:task-1', summary: 'Selected the backend runtime.', knowledge: ['The backend runtime is node.'], sources: ['User confirmed in this chat.'], validation: 'Design reviewed.', duration: '~5m', caveats: ['Not deployed.'] };
async function fixture() {
  const api = new FakeOpenAI(); const env = { OPENAI_API_KEY: 'test-only', MEMORY_NAMESPACE: 'test' };
  const memory = new Memory(env, api);
  await memory.memory_projects({ action: 'create', project_key: 'demo' });
  return { api, env, memory };
}
const fresh = fixture => new Memory(fixture.env, fixture.api);
async function save(fixture, value, taskKey, extra = {}) {
  fixture.api.proposals.push([fact(value, extra)]);
  return fresh(fixture).memory_complete({ ...base, task_key: taskKey, knowledge: [fact(value, extra).content] });
}
async function saveLegacy(fixture, recorded_at = '2026-11-01T00:00:00.000Z', task_key = 'legacy:node') {
  const memory = fresh(fixture); const input = { ...base, task_key, corrections: [] };
  const operation_id = await digest(['test', 'demo', input.task_key]);
  const revision_id = await digest([operation_id, 'backend-runtime']);
  const metadata = { schema_version: 1, record_type: 'knowledge', project_key: 'demo', memory_id: 'backend-runtime', revision_id, replaces: [], conflict: false, operation_id, sources: input.sources };
  const text = `---\n${Object.entries(metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n# Backend runtime\n\nThe backend runtime is node.\n`;
  const document = { ...metadata, title: 'Backend runtime', content: 'The backend runtime is node.', text, filename: memory.filename('demo', 'knowledge', `backend-runtime--${revision_id}.md`) };
  const plan = { schema_version: 1, namespace: 'test', project_key: 'demo', operation_id, request_hash: await digest(input), created_at: recorded_at, input, documents: [document] };
  await memory.put(memory.planName('demo', operation_id), canonical(plan));
  const result = await memory.resume(await memory.store('demo'), plan);
  assert(['saved', 'conflict'].includes(result.status));
  return fixture.api.files.find(v => v.filename === document.filename).id;
}
const query = fixture => fresh(fixture).memory_query({ project_key: 'demo', query: 'Which runtime does the backend use?', include_global: false });
function rpc(worker, name, args, headers = { authorization: 'Bearer local-test' }) {
  return worker.fetch(new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), { MEMORY_LOCAL_TOKEN: 'local-test' });
}
async function maintainAll(fixture, task_key = 'daily:2026-11-08') {
  let result;
  for (let i = 0; i < 20; i++) {
    result = await fresh(fixture).memory_maintain({ project_key: 'demo', task_key });
    if (result.status !== 'pending') return result;
  }
  assert.fail(`maintenance did not complete: ${JSON.stringify(result)}`);
}

test('canonical hashes ignore object property order', async () => {
  assert.equal(canonical({ b: 2, a: [1] }), canonical({ a: [1], b: 2 }));
  assert.equal(await digest({ a: 1, b: 2 }), await digest({ b: 2, a: 1 }));
});
test('capture and task log are saved independently from wiki incorporation', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  assert.equal(saved.status, 'saved'); assert.equal(saved.wiki_status, 'pending'); assert(saved.capture_file_id);
  assert.equal(f.api.files.filter(v => v.filename.includes('--log--')).length, 1);
  const read = await fresh(f).memory_read({ project_key: 'demo', file_id: saved.log_file_id });
  assert.match(read.text, /Design reviewed/); assert.match(read.text, /~5m/); assert.match(read.text, /Not deployed/);
});
test('fresh capture extracts only new input and does not read historical contents', async () => {
  const f = await fixture(); await f.memory.memory_complete(base);
  const oldIds = new Set(f.api.files.map(v => v.id)); f.api.resetCalls();
  await save(f, 'bun', 'chat:second');
  assert.equal(f.api.modelCalls.length, 1); assert.deepEqual(Object.keys(f.api.modelCalls[0].input), ['task']);
  assert(!f.api.calls.some(c => c.method === 'content' && oldIds.has(c.id)));
});
test('operation-local verification reduces upstream work against the historical-scan baseline', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) await save(f, 'node', `baseline:${i}`);
  f.api.resetCalls(); const saved = await save(f, 'node', 'baseline:measured');
  const writes = f.api.calls.filter(c => c.method === 'content').length;
  assert(writes <= 4, `expected each intake/plan/capture/log to be fetched at most once, got ${writes}`);
  assert(writes < 25, 'previous implementation fetched 25 contents for the same four-task fixture');
  f.api.resetCalls(); await fresh(f).memory_read({ project_key: 'demo', file_id: saved.log_file_id });
  const reads = f.api.calls.filter(c => c.method === 'content').length;
  assert(reads <= 4, `exact read should verify only its intake/plan/capture/log, got ${reads}`);
  assert(reads < 13, 'previous implementation fetched 13 contents for the same four-task fixture');
});
test('identical retry reuses files, extraction and original recorded timestamp', async () => {
  const f = await fixture(); const first = await f.memory.memory_complete(base);
  const original = f.api.contents.get(first.capture_file_id); const count = f.api.files.length;
  const retry = await fresh(f).memory_complete(base);
  assert.equal(retry.operation_id, first.operation_id); assert.equal(f.api.files.length, count);
  assert.equal(f.api.contents.get(retry.capture_file_id), original);
  assert.equal(f.api.modelCalls.filter(c => c.input.task).length, 1);
});
test('failed extraction preserves first intake time and rejects changed payload on retry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); f.api.modelFailure = true;
  await assert.rejects(f.memory.memory_complete(base), { code: 'model_incomplete' });
  assert(!f.api.files.some(v => /--(?:capture|log)--/.test(v.filename)));
  t.mock.timers.tick(86400000); f.api.modelFailure = false;
  await assert.rejects(fresh(f).memory_complete({ ...base, summary: 'Changed after failed model call.' }), { code: 'task_key_reused' });
  const saved = await fresh(f).memory_complete(base); assert.equal(saved.status, 'saved');
  assert.match(f.api.contents.get(saved.capture_file_id), /recorded_at: "2026-11-08T00:00:00.000Z"/);
});
test('same task key with changed payload is rejected', async () => {
  const f = await fixture(); await f.memory.memory_complete(base);
  await assert.rejects(fresh(f).memory_complete({ ...base, summary: 'Different task' }), { code: 'task_key_reused' });
});
test('indexing resumes on another instance and never reports background progress', async () => {
  const f = await fixture(); f.api.indexPending = true;
  const result = await f.memory.memory_complete(base); assert.equal(result.status, 'pending');
  assert.equal(f.api.files.filter(v => v.filename.includes('--log--')).length, 0);
  f.api.completeIndexing(); f.api.indexPending = false;
  const resumed = await fresh(f).memory_status({ project_key: 'demo', operation_id: result.operation_id, resume: true });
  assert.equal(resumed.status, 'saved'); assert.equal(f.api.modelCalls.filter(c => c.input.task).length, 1);
});
test('interrupted capture upload leaves a recoverable persisted plan', async () => {
  const f = await fixture(); f.api.uploadFailure = true;
  await assert.rejects(f.memory.memory_complete(base)); f.api.uploadFailure = false;
  const operation_id = await digest(['test', 'demo', base.task_key]);
  assert.equal((await fresh(f).memory_status({ project_key: 'demo', operation_id, resume: true })).status, 'saved');
});
for (const kind of ['intake', 'operation']) test(`unattached ${kind} upload is repaired only by a fresh mutating resume`, async () => {
  const f = await fixture(); f.api.attachmentFailure = kind;
  await assert.rejects(f.memory.memory_complete(base), { code: 'upstream_unavailable' });
  const uploaded = f.api.files.find(v => v.filename.includes(`--${kind}--`)); assert(uploaded);
  assert(!f.api.attachments.get(f.api.stores[0].id)?.some(v => v.id === uploaded.id));
  f.api.attachmentFailure = null; f.api.calls = [];
  const operation_id = await digest(['test', 'demo', base.task_key]);
  const audit = await fresh(f).memory_audit({ project_key: 'demo' }); assert.equal(audit.status, 'incomplete');
  assert.equal((await query(f)).status, 'insufficient_memory');
  await assert.rejects(fresh(f).memory_read({ project_key: 'demo', file_id: uploaded.id }), { code: 'file_not_available' });
  assert.equal((await fresh(f).memory_status({ project_key: 'demo', operation_id })).status, 'pending');
  assert(!f.api.calls.some(c => c.method === 'POST' && /\/vector_stores\/[^/]+\/files$/.test(c.path)));
  const saved = await fresh(f).memory_status({ project_key: 'demo', operation_id, resume: true });
  assert.equal(saved.status, 'saved'); assert(saved.capture_file_id);
  assert.equal(f.api.modelCalls.filter(c => c.input.task).length, 1);
  assert(f.api.attachments.get(f.api.stores[0].id).some(v => v.id === uploaded.id));
});
test('in-progress index rows with temporarily empty attributes remain pending and recover', async () => {
  const f = await fixture(); f.api.indexPending = true; f.api.hideProgressAttributes = true;
  const first = await f.memory.memory_complete(base); assert.equal(first.status, 'pending');
  assert.equal((await fresh(f).memory_status({ project_key: 'demo', operation_id: first.operation_id })).status, 'pending');
  f.api.completeIndexing(); f.api.indexPending = false;
  const saved = await fresh(f).memory_status({ project_key: 'demo', operation_id: first.operation_id, resume: true }); assert.equal(saved.status, 'saved');
});
test('completed empty list attributes refresh through a read-only attachment detail request', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base); f.api.hideCompletedListAttributes = true; f.api.calls = [];
  const read = await fresh(f).memory_read({ project_key: 'demo', file_id: saved.capture_file_id }); assert.match(read.text, /node/);
  assert(f.api.calls.some(c => c.method === 'GET' && /\/vector_stores\/[^/]+\/files\/[^/]+$/.test(c.path)));
  assert(!f.api.calls.some(c => c.method === 'POST'));
});
test('completed metadata still missing after detail refresh fails honestly', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base); f.api.hideCompletedListAttributes = true; f.api.hideCompletedDetailAttributes = true;
  await assert.rejects(fresh(f).memory_read({ project_key: 'demo', file_id: saved.capture_file_id }), { code: 'index_metadata_incomplete' });
});
test('completed incorrect metadata fails rather than being treated as transient indexing', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  f.api.attachments.get(f.api.stores[0].id).find(v => v.id === saved.capture_file_id).attributes.recorded_at = '2099-01-01T00:00:00.000Z';
  await assert.rejects(fresh(f).memory_read({ project_key: 'demo', file_id: saved.capture_file_id }), { code: 'invalid_document' });
});
test('newer same-fact assertion wins before daily maintenance, even when only old capture matches search', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const old = await save(f, 'node', 'old'); t.mock.timers.tick(1000);
  await save(f, 'bun', 'new'); f.api.searchFileIds = [old.capture_file_id];
  const result = await query(f);
  assert.equal(result.status, 'answered'); assert.match(result.answer, /bun/); assert(!result.evidence.some(e => /runtime is node\./.test(e.text)));
});
test('superseded current assertions are returned only on explicit history requests', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); await save(f, 'node', 'history:node'); t.mock.timers.tick(1000); await save(f, 'bun', 'history:bun');
  const normal = await query(f); assert(!normal.evidence.flatMap(e => e.assertions || []).some(a => a.value === 'node'));
  const history = await fresh(f).memory_query({ project_key: 'demo', query: 'How did the backend runtime change?', include_global: false, include_history: true });
  const assertions = history.evidence.flatMap(e => e.assertions || []); const old = assertions.find(a => a.value === 'node');
  assert(old); assert.equal(old.kind, 'historical'); assert.equal(old.original_kind, 'current'); assert.equal(old.currentness, 'historical'); assert.equal(old.recorded_at, '2026-11-08T00:00:00.000Z');
  assert(assertions.some(a => a.value === 'bun' && a.kind === 'current'));
});
test('planned-only capture remains retrievable as typed context before and after wiki maintenance', async () => {
  const f = await fixture(); await save(f, 'bun', 'planned:only', { kind: 'planned', content: 'A future plan is to evaluate Bun; it has not been adopted.' });
  const before = await query(f); assert.equal(before.status, 'answered');
  assert(before.evidence.flatMap(e => e.assertions || []).some(a => a.value === 'bun' && a.kind === 'planned'));
  assert(!before.evidence.flatMap(e => e.assertions || []).some(a => a.kind === 'current'));
  await maintainAll(f); const index = f.api.attachments.get(f.api.stores[0].id).find(v => v.attributes.record_type === 'index'); f.api.searchFileIds = [index.id];
  const after = await query(f); assert.equal(after.status, 'answered'); assert(after.evidence.flatMap(e => e.assertions || []).some(a => a.kind === 'planned'));
  assert(!after.evidence.flatMap(e => e.assertions || []).some(a => a.kind === 'current'));
});
test('redundant project prefix from extraction normalizes to the same scoped fact identity', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); await save(f, 'node', 'prefixed:node', { fact_key: 'demo.backend.runtime' }); t.mock.timers.tick(1000);
  await save(f, 'bun', 'unprefixed:bun');
  const result = await query(f); assert.match(result.answer, /bun/); assert(!result.evidence.some(e => /runtime is node\./.test(e.text)));
});
test('changing runtime preserves package manager and scoped facts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); f.api.proposals.push([fact(), fact('pnpm', { fact_key: 'backend.package-manager', title: 'Package manager', content: 'Backend package manager is pnpm.' })]);
  await f.memory.memory_complete(base); t.mock.timers.tick(1000); await save(f, 'bun', 'new');
  const result = await query(f); const text = result.evidence.map(e => e.text).join('\n');
  assert.match(text, /bun/); assert.match(text, /pnpm/);
});
for (const kind of ['planned', 'historical', 'question']) test(`${kind} assertion does not replace current runtime`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); await save(f, 'node', 'current'); t.mock.timers.tick(1000);
  await save(f, 'bun', kind, { kind, content: `${kind}: Bun runtime.` });
  const result = await query(f);
  assert.match(result.answer, /node/); assert(!result.evidence.some(e => e.assertions?.some(a => a.kind === 'current' && a.value === 'bun')));
});
test('same-time different values are ambiguous rather than arbitrary latest truth', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); await save(f, 'node', 'a'); await save(f, 'bun', 'b');
  const result = await query(f); assert(['conflict', 'ambiguous'].includes(result.status));
  assert(result.conflicts?.length || result.ambiguities?.length);
});
test('capture model output is validated before upload', async () => {
  const f = await fixture(); f.api.proposals.push([fact('bun', { fact_key: 'bad key' })]);
  await assert.rejects(f.memory.memory_complete(base)); assert(!f.api.files.some(v => /--(?:capture|log)--/.test(v.filename)));
});
test('an exact read downloads each file only once and does not read unrelated operation content', async () => {
  const f = await fixture(); const a = await save(f, 'node', 'a'); const oldIds = new Set(f.api.files.map(v => v.id));
  const b = await save(f, 'bun', 'b'); f.api.resetCalls();
  await fresh(f).memory_read({ project_key: 'demo', file_id: b.capture_file_id });
  const downloads = f.api.calls.filter(c => c.method === 'content');
  assert(!downloads.some(c => oldIds.has(c.id)));
  assert.equal(downloads.filter(c => c.id === b.capture_file_id).length, 1);
});
test('project query includes global but excludes unrelated projects and task logs', async () => {
  const f = await fixture(); await f.memory.memory_complete(base);
  for (const project_key of ['global', 'other']) {
    await fresh(f).memory_projects({ action: 'create', project_key });
    await fresh(f).memory_complete({ ...base, project_key, task_key: project_key });
  }
  const result = await fresh(f).memory_query({ project_key: 'demo', query: 'Runtime?' });
  assert.deepEqual([...new Set(result.evidence.map(e => e.project_key))].sort(), ['demo', 'global']);
  const logs = await fresh(f).memory_query({ project_key: 'demo', query: 'Completed work?', record_type: 'log', include_global: false });
  assert.equal(logs.evidence.length, 1); assert.match(logs.evidence[0].text, /# Task completion/);
});
test('foreign file IDs cannot be read', async () => {
  const f = await fixture(); await f.memory.memory_complete(base);
  await assert.rejects(fresh(f).memory_read({ project_key: 'demo', file_id: 'file-foreign' }), { code: 'file_not_available' });
});
test('empty retrieval makes no query-model call', async () => {
  const f = await fixture(); assert.equal((await query(f)).status, 'insufficient_memory'); assert.equal(f.api.modelCalls.length, 0);
});
test('invented citations are rejected', async () => {
  const f = await fixture(); await f.memory.memory_complete(base); f.api.badCitation = true;
  await assert.rejects(query(f), { code: 'invalid_citation' });
});
test('routine and explicit complex query retain Luna/Sol routing', async () => {
  const f = await fixture(); await f.memory.memory_complete(base);
  await query(f); assert.equal(f.api.modelCalls.at(-1).kind, 'query');
  await fresh(f).memory_query({ project_key: 'demo', query: 'Runtime?', mode: 'complex' }); assert.equal(f.api.modelCalls.at(-1).kind, 'write');
});
test('credentials are rejected before persistence', async () => {
  const f = await fixture(); await assert.rejects(f.memory.memory_complete({ ...base, summary: 'sk-proj-' + 'a'.repeat(30) }), { code: 'sensitive_input' }); assert.equal(f.api.files.length, 0);
});
test('duplicate project collections and incompatible plans remain explicit failures', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  const original = f.api.files.find(v => v.filename.includes('--operation--') && v.filename.endsWith('.plan.md'));
  const duplicate = await f.api.upload(original.filename, '{}');
  const attrs = f.api.attachments.get(f.api.stores[0].id).find(v => v.id === original.id).attributes;
  await f.api.request(`/vector_stores/${f.api.stores[0].id}/files`, { method: 'POST', body: { file_id: duplicate.id, attributes: attrs } });
  await assert.rejects(fresh(f).memory_status({ project_key: 'demo', operation_id: saved.operation_id }), { code: 'operation_conflict' });
  f.api.stores.push({ ...f.api.stores[0], id: 'vs-other' }); await assert.rejects(fresh(f).projects(), { code: 'project_conflict' });
});
test('maintenance compiles persisted wiki and newer raw capture still overrides it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const old = await save(f, 'node', 'a');
  const compiled = await maintainAll(f); assert.equal(compiled.status, 'saved'); assert(compiled.wiki_file_ids.length);
  t.mock.timers.tick(1000); await save(f, 'bun', 'b');
  const result = await query(f); assert.match(result.answer, /bun/);
  const again = await maintainAll(f, 'daily:next'); assert.equal(again.status, 'saved');
  const after = await query(f); assert.match(after.answer, /bun/);
  assert(f.api.contents.has(old.capture_file_id));
});
test('maintenance processes at most 20 captures and one model call per invocation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture();
  for (let i = 0; i < 21; i++) { t.mock.timers.tick(1000); await save(f, `runtime-${i}`, `task:${i}`); }
  f.api.resetCalls();
  let result = await fresh(f).memory_maintain({ project_key: 'demo', task_key: 'daily:batch' });
  assert.equal(result.status, 'pending'); assert.equal(result.total, 21); assert(result.processed <= 20);
  assert.equal(f.api.modelCalls.filter(c => c.input.captures).length, 1);
  assert(f.api.modelCalls[0].input.captures.length <= 20);
  result = await maintainAll(f, 'daily:batch'); assert.equal(result.status, 'saved'); assert.equal(result.processed, 21);
});
test('late-indexed older capture is compiled by source ID rather than lost behind a time cutoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const older = await save(f, 'node', 'delayed:runtime'); t.mock.timers.tick(1000);
  await save(f, 'pnpm', 'ready:packages', { fact_key: 'backend.package-manager', title: 'Package manager', content: 'The backend package manager is pnpm.' });
  const attached = f.api.attachments.get(f.api.stores[0].id); attached.find(v => v.id === older.capture_file_id).status = 'in_progress';
  await maintainAll(f, 'daily:before-index'); f.api.completeIndexing(); f.api.resetCalls();
  const result = await maintainAll(f, 'daily:after-index'); assert.equal(result.status, 'saved');
  assert(f.api.modelCalls.some(c => c.input.captures?.some(v => v.file_id === older.capture_file_id)));
  const text = (await query(f)).evidence.map(e => e.text).join('\n'); assert.match(text, /node/); assert.match(text, /pnpm/);
});
test('maintenance retry does not re-extract captures or duplicate committed wiki output', async () => {
  const f = await fixture(); await f.memory.memory_complete(base); const first = await maintainAll(f);
  const count = f.api.files.length; const modelCalls = f.api.modelCalls.length;
  const retry = await fresh(f).memory_maintain({ project_key: 'demo', task_key: 'daily:2026-11-08' });
  assert.equal(retry.status, 'saved'); assert.equal(retry.operation_id, first.operation_id);
  assert.equal(f.api.files.length, count); assert.equal(f.api.modelCalls.length, modelCalls);
});
test('maintenance rejects invented source IDs before creating wiki documents', async () => {
  const f = await fixture(); await f.memory.memory_complete(base);
  f.api.maintenanceProposals.push({ pages: [{ memory_id: 'backend', title: 'Backend', content: 'Invented.', source_ids: ['file-foreign'], links: [] }], findings: [], legacy_assertions: [] });
  await assert.rejects(fresh(f).memory_maintain({ project_key: 'demo', task_key: 'invalid-source' }));
  assert(!f.api.files.some(v => v.filename.includes('--wiki--')));
});
test('legacy schema1 operation is readable and migration preserves its original age', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const legacyId = await saveLegacy(f); const original = f.api.contents.get(legacyId);
  const read = await fresh(f).memory_read({ project_key: 'demo', file_id: legacyId }); assert.match(read.text, /node/);
  const newer = await save(f, 'bun', 'new:bun');
  f.api.maintenanceProposals.push({ pages: [{ memory_id: 'backend', title: 'Backend', content: 'The backend currently uses Bun.', source_ids: [legacyId, newer.capture_file_id], links: [] }], legacy_assertions: [{ source_id: legacyId, assertions: [fact('node')] }], findings: [] });
  const result = await maintainAll(f, 'migrate:hosted'); assert.equal(result.status, 'saved');
  assert.match((await query(f)).answer, /bun/i); assert.equal(f.api.contents.get(legacyId), original);
});
test('legacy-only search hit resolves through migration to a newer current assertion', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const legacyId = await saveLegacy(f);
  await maintainAll(f, 'migrate:first'); t.mock.timers.tick(1000);
  await save(f, 'bun', 'fresh:bun'); f.api.searchFileIds = [legacyId];
  const result = await query(f); assert.equal(result.status, 'answered'); assert.match(result.answer, /bun/i);
  assert(!result.evidence.some(e => /runtime is node\./.test(e.text)));
});
test('multiple legacy captures in one batch verify independently by original source identity', async () => {
  const f = await fixture(); const a = await saveLegacy(f, '2026-11-01T00:00:00.000Z', 'legacy:a'); const b = await saveLegacy(f, '2026-11-02T00:00:00.000Z', 'legacy:b');
  const result = await maintainAll(f, 'migrate:multiple'); assert.equal(result.status, 'saved'); assert.equal(result.processed, 2);
  assert(f.api.contents.has(a) && f.api.contents.has(b));
});
test('compiled wiki cannot resolve a later same-time conflicting assertion tie', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); await save(f, 'node', 'initial:node'); await maintainAll(f);
  t.mock.timers.tick(1000); await save(f, 'bun', 'tie:bun'); await save(f, 'deno', 'tie:deno');
  const result = await query(f); assert.equal(result.status, 'conflict'); assert(result.conflicts.length);
  assert(!result.evidence.some(e => /runtime is node\./.test(e.text)));
});
test('interrupted maintenance resumes its persisted batch without repeating the model call', async () => {
  const f = await fixture(); await f.memory.memory_complete(base); f.api.uploadFailure = true;
  await assert.rejects(fresh(f).memory_maintain({ project_key: 'demo', task_key: 'interrupted:daily' }));
  assert.equal(f.api.modelCalls.filter(c => c.input.captures).length, 1); f.api.uploadFailure = false;
  const result = await maintainAll(f, 'interrupted:daily'); assert.equal(result.status, 'saved');
  assert.equal(f.api.modelCalls.filter(c => c.input.captures).length, 1);
});
test('maintenance cannot mark meaningful captures compiled when the model returns no pages', async () => {
  const f = await fixture(); await f.memory.memory_complete(base);
  f.api.maintenanceProposals.push({ pages: [], legacy_assertions: [], findings: [] });
  await assert.rejects(fresh(f).memory_maintain({ project_key: 'demo', task_key: 'coverage:none' }), { code: 'model_invalid' });
  assert(!f.api.files.some(v => v.filename.includes('--operation--') && JSON.parse(f.api.contents.get(v.id)).kind === 'maintenance_batch'));
});
test('maintenance rejects a page set that omits one meaningful source in its batch', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const a = await save(f, 'node', 'coverage:runtime'); t.mock.timers.tick(1000);
  await save(f, 'pnpm', 'coverage:packages', { fact_key: 'backend.package-manager', title: 'Package manager', content: 'The backend package manager is pnpm.' });
  f.api.maintenanceProposals.push({ pages: [{ memory_id: 'backend', title: 'Backend', content: 'The backend runtime is node.', source_ids: [a.capture_file_id], links: [] }], legacy_assertions: [], findings: [] });
  await assert.rejects(fresh(f).memory_maintain({ project_key: 'demo', task_key: 'coverage:omitted' }), { code: 'model_invalid' });
  assert(!f.api.files.some(v => v.filename.includes('--wiki--')));
});
test('capture with no reusable assertions may finish maintenance without a wiki page', async () => {
  const f = await fixture(); f.api.proposals.push([]); await f.memory.memory_complete({ ...base, summary: 'Answered a greeting.', knowledge: [] });
  f.api.maintenanceProposals.push({ pages: [], legacy_assertions: [], findings: [] });
  const result = await maintainAll(f, 'coverage:empty'); assert.equal(result.status, 'saved'); assert.equal(result.remaining, 0); assert.equal(result.wiki_file_ids.length, 0);
});
test('maintenance never saves a wiki page with no source evidence', async () => {
  const f = await fixture(); await f.memory.memory_complete(base);
  f.api.maintenanceProposals.push({ pages: [{ memory_id: 'backend', title: 'Backend', content: 'An unsupported summary.', source_ids: [], links: [] }], legacy_assertions: [], findings: [] });
  await assert.rejects(fresh(f).memory_maintain({ project_key: 'demo', task_key: 'unsupported:page' }));
  assert(!f.api.files.some(v => v.filename.includes('--wiki--')));
});
test('concurrent maintenance attempts preserve sources and usable current facts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const a = await save(f, 'node', 'concurrent:runtime'); t.mock.timers.tick(1000);
  const b = await save(f, 'pnpm', 'concurrent:packages', { fact_key: 'backend.package-manager', title: 'Package manager', content: 'The backend package manager is pnpm.' });
  const attempts = await Promise.allSettled(['daily:a', 'daily:b'].map(task_key => fresh(f).memory_maintain({ project_key: 'demo', task_key })));
  assert(attempts.some(r => r.status === 'fulfilled'));
  for (const result of attempts) if (result.status === 'rejected') assert.equal(result.reason.code, 'operation_conflict');
  const result = await query(f); assert.match(result.answer, /node/); assert.match(result.answer, /pnpm/);
  assert(f.api.contents.has(a.capture_file_id) && f.api.contents.has(b.capture_file_id));
});
test('incomparable wiki revisions retain independent coverage instead of a timestamp winner', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const a = await save(f, 'node', 'branch:runtime'); await maintainAll(f, 'branch:a');
  t.mock.timers.tick(1000); const b = await save(f, 'pnpm', 'branch:packages', { fact_key: 'backend.package-manager', title: 'Package manager', content: 'The backend package manager is pnpm.' });
  f.api.maintenanceProposals.push({ pages: [{ memory_id: 'backend', title: 'Backend', content: 'The backend package manager is pnpm.', source_ids: [b.capture_file_id], links: [] }], legacy_assertions: [], findings: [] });
  await maintainAll(f, 'branch:b');
  const memory = fresh(f); const pages = await memory.wikiPages(await memory.store('demo'));
  assert.equal(pages.filter(p => p.memory_id === 'backend').length, 2);
  assert(pages.some(p => p.source_ids.includes(a.capture_file_id))); assert(pages.some(p => p.source_ids.includes(b.capture_file_id)));
  const result = await query(f); assert.match(result.answer, /node/); assert.match(result.answer, /pnpm/);
});
test('derived wiki index retains existing topics when a later batch adds a different topic', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); const backend = await save(f, 'node', 'index:backend'); await maintainAll(f, 'index:first');
  t.mock.timers.tick(1000); const frontend = await save(f, 'dark', 'index:frontend', { fact_key: 'frontend.theme', title: 'Frontend theme', content: 'The frontend theme is dark.', memory_class: 'Preference' });
  f.api.maintenanceProposals.push({ pages: [{ memory_id: 'frontend', title: 'Frontend', content: 'The frontend theme is dark.', source_ids: [frontend.capture_file_id], links: ['backend'] }], legacy_assertions: [], findings: [] });
  await maintainAll(f, 'index:second');
  const memory = fresh(f); const store = await memory.store('demo'); const indexes = await memory.recordsFor(store, (await memory.inventory(store)).filter(v => v.attributes.record_type === 'index'));
  const index = indexes.find(v => v.links.includes('frontend'));
  assert(index); assert(index.links.includes('backend'));
  assert(index.source_ids.includes(backend.capture_file_id)); assert(index.source_ids.includes(frontend.capture_file_id));
});
test('index-only search hit navigates to wiki and still resolves a newer uncompiled capture', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); await save(f, 'node', 'index:old-runtime'); await maintainAll(f);
  const index = f.api.attachments.get(f.api.stores[0].id).find(v => v.attributes.record_type === 'index'); assert(index);
  t.mock.timers.tick(1000); await save(f, 'bun', 'index:new-runtime'); f.api.searchFileIds = [index.id];
  const result = await query(f); assert.match(result.answer, /bun/); assert(!result.evidence.some(e => e.file_id === index.id || /runtime is node\./.test(e.text)));
});
test('audit detects duplicate and superseded current assertions across operations', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); await save(f, 'node', 'duplicate:a'); t.mock.timers.tick(1000); await save(f, 'node', 'duplicate:b'); t.mock.timers.tick(1000); await save(f, 'bun', 'latest');
  const result = await fresh(f).memory_audit({ project_key: 'demo' });
  assert.equal(result.status, 'findings'); assert(result.findings.some(v => /duplicate/.test(v.code))); assert(result.findings.some(v => /stale|historical|superseded/.test(v.code)));
});
test('audit reports same-time ambiguity between different capture operations', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture(); await save(f, 'node', 'tie:a'); await save(f, 'bun', 'tie:b');
  const result = await fresh(f).memory_audit({ project_key: 'demo' });
  assert.equal(result.status, 'findings'); assert(result.findings.some(v => /ambig/.test(v.code)));
});
test('matching forged intake and operation hashes cannot replace recomputation from input', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  for (const kind of ['intake', 'operation']) {
    const file = f.api.files.find(v => v.filename.includes(`--${kind}--`) && v.filename.includes(saved.operation_id));
    const data = JSON.parse(f.api.contents.get(file.id)); data.request_hash = '0'.repeat(64); f.api.contents.set(file.id, canonical(data));
  }
  await assert.rejects(fresh(f).memory_status({ project_key: 'demo', operation_id: saved.operation_id }), { code: 'invalid_document' });
});
test('changing only the stored operation creation time invalidates its capture', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  const file = f.api.files.find(v => v.filename.includes('--operation--') && v.filename.includes(saved.operation_id));
  const plan = JSON.parse(f.api.contents.get(file.id)); plan.created_at = '2099-01-01T00:00:00.000Z'; f.api.contents.set(file.id, canonical(plan));
  await assert.rejects(fresh(f).memory_read({ project_key: 'demo', file_id: saved.capture_file_id }), { code: 'invalid_document' });
});
test('rewriting capture timestamp in plan, exact source and index still cannot outrank its original intake', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  const file = f.api.files.find(v => v.filename.includes('--operation--') && v.filename.includes(saved.operation_id));
  const plan = JSON.parse(f.api.contents.get(file.id)); const doc = plan.documents.find(v => v.record_type === 'capture');
  doc.recorded_at = plan.created_at = '2099-01-01T00:00:00.000Z'; doc.text = doc.text.replace(/recorded_at: "[^"]+"/, `recorded_at: "${doc.recorded_at}"`);
  f.api.contents.set(file.id, canonical(plan)); f.api.contents.set(saved.capture_file_id, doc.text);
  f.api.attachments.get(f.api.stores[0].id).find(v => v.id === saved.capture_file_id).attributes.recorded_at = doc.recorded_at;
  await assert.rejects(fresh(f).memory_read({ project_key: 'demo', file_id: saved.capture_file_id }), { code: 'operation_conflict' });
});
test('audit reports indexed metadata that disagrees with the committed source', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  f.api.attachments.get(f.api.stores[0].id).find(v => v.id === saved.capture_file_id).attributes.recorded_at = '2099-01-01T00:00:00.000Z';
  const result = await fresh(f).memory_audit({ project_key: 'demo' });
  assert.equal(result.status, 'findings'); assert(result.findings.some(v => v.code === 'invalid_document'));
});
test('audit is read-only and clean only after its full declared scope is checked', async () => {
  const f = await fixture(); await f.memory.memory_complete(base); const files = f.api.files.length; const attached = canonical([...f.api.attachments]);
  let result = await fresh(f).memory_audit({ project_key: 'demo' });
  for (let i = 0; result.next_cursor && i < 20; i++) result = await fresh(f).memory_audit({ project_key: 'demo', cursor: result.next_cursor });
  assert.equal(result.status, 'clean'); assert.equal(f.api.files.length, files); assert.equal(canonical([...f.api.attachments]), attached);
});
test('audit reports corrupted operations and continues checking independent operations', async () => {
  const f = await fixture(); const first = await save(f, 'node', 'a'); await save(f, 'bun', 'b');
  f.api.contents.set(first.capture_file_id, 'corrupted source');
  const result = await fresh(f).memory_audit({ project_key: 'demo' });
  assert(['findings', 'incomplete'].includes(result.status)); assert(result.findings.length); assert(result.checked >= 2);
});
test('audit collects failures from multiple corrupt operations and still checks healthy records', async () => {
  const f = await fixture(); const a = await save(f, 'node', 'corrupt:a'); const b = await save(f, 'bun', 'corrupt:b'); const c = await save(f, 'pnpm', 'healthy', { fact_key: 'backend.package-manager', title: 'Package manager', content: 'The backend package manager is pnpm.' });
  f.api.contents.set(a.capture_file_id, 'corrupt first document'); f.api.contents.set(b.log_file_id, 'corrupt second log');
  const result = await fresh(f).memory_audit({ project_key: 'demo' });
  assert.equal(result.status, 'findings'); assert(result.findings.length >= 2); assert(result.coverage_complete);
  f.api.searchFileIds = [c.capture_file_id]; assert.match((await query(f)).answer, /pnpm/);
});
test('audit reports incomplete coverage when a source is still indexing', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  f.api.attachments.get(f.api.stores[0].id).find(v => v.id === saved.capture_file_id).status = 'in_progress';
  const result = await fresh(f).memory_audit({ project_key: 'demo' });
  assert.equal(result.status, 'incomplete'); assert.equal(result.coverage_complete, false);
  assert(result.findings.some(v => /index_pending|operation_pending/.test(v.code)));
});
test('maintenance defers an indexed capture whose operation log is not yet committed', async () => {
  const f = await fixture(); const upload = f.api.upload.bind(f.api);
  f.api.upload = async (filename, ...args) => { if (filename.includes('--log--')) throw new Error('Synthetic interrupted log write.'); return upload(filename, ...args); };
  await assert.rejects(f.memory.memory_complete(base));
  const pending = await fresh(f).memory_maintain({ project_key: 'demo', task_key: 'pending:source' });
  assert.equal(pending.status, 'pending'); assert(pending.remaining > 0 || pending.not_covered?.length);
  assert.equal(f.api.modelCalls.filter(c => c.input.captures).length, 0);
  f.api.upload = upload;
  const operation_id = await digest(['test', 'demo', base.task_key]);
  assert.equal((await fresh(f).memory_status({ project_key: 'demo', operation_id, resume: true })).status, 'saved');
  const result = await maintainAll(f, 'pending:source'); assert.equal(result.status, 'saved');
  assert(result.wiki_file_ids.length);
});
test('audit never reports clean when listing verification fails', async () => {
  const f = await fixture(); const list = f.api.list.bind(f.api);
  f.api.list = async path => { if (path.includes('/files')) throw new MemoryError('catalogue_incomplete', 'Synthetic listing cap.'); return list(path); };
  const result = await fresh(f).memory_audit({ project_key: 'demo' });
  assert(['incomplete', 'failed'].includes(result.status)); assert(result.findings.length);
});
test('audit rejects malformed or cross-project cursors', async () => {
  const f = await fixture();
  await assert.rejects(fresh(f).memory_audit({ project_key: 'demo', cursor: 'not-a-valid-cursor' }));
});
test('completion with no reusable assertions still saves its curated source and task log', async () => {
  const f = await fixture(); f.api.proposals.push([]);
  const saved = await f.memory.memory_complete({ ...base, summary: 'Answered a greeting.', knowledge: [] });
  assert.equal(saved.status, 'saved'); assert(saved.capture_file_id); assert(saved.log_file_id);
  assert.equal((await query(f)).status, 'insufficient_memory');
});
test('maintenance rejects broken topic links rather than persisting them', async () => {
  const f = await fixture(); const saved = await f.memory.memory_complete(base);
  f.api.maintenanceProposals.push({ pages: [{ memory_id: 'backend', title: 'Backend', content: 'Backend runtime.', source_ids: [saved.capture_file_id], links: ['nonexistent-topic'] }], legacy_assertions: [], findings: [] });
  await assert.rejects(fresh(f).memory_maintain({ project_key: 'demo', task_key: 'invalid-link' }));
  assert(!f.api.files.some(v => v.filename.includes('--wiki--')));
});
test('audit continuation is tied to its project scope', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture();
  for (let i = 0; i < 21; i++) { t.mock.timers.tick(1000); await save(f, `runtime-${i}`, `scope:${i}`); }
  const first = await fresh(f).memory_audit({ project_key: 'demo' }); assert(first.next_cursor);
  const position = Math.floor(first.next_cursor.length / 2);
  const tampered = first.next_cursor.slice(0, position) + (first.next_cursor[position] === 'A' ? 'B' : 'A') + first.next_cursor.slice(position + 1);
  await assert.rejects(fresh(f).memory_audit({ project_key: 'demo', cursor: tampered }));
  await fresh(f).memory_projects({ action: 'create', project_key: 'other' });
  await assert.rejects(fresh(f).memory_audit({ project_key: 'other', cursor: first.next_cursor }));
});
test('audit invalidates old coverage cursor when inventory changes between batches', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-08T00:00:00Z') });
  const f = await fixture();
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(1000); await save(f, `runtime-${i}`, `inventory:${i}`); }
  const first = await fresh(f).memory_audit({ project_key: 'demo' }); assert(first.next_cursor);
  t.mock.timers.tick(1000); await save(f, 'bun', 'inventory:changed');
  const result = await fresh(f).memory_audit({ project_key: 'demo', cursor: first.next_cursor });
  assert.equal(result.status, 'incomplete'); assert.equal(result.coverage_complete, false);
});
test('local forged Sites headers do not bypass bearer authentication', async () => {
  const worker = createWorker(() => { throw new Error('must not run'); });
  assert.equal((await rpc(worker, 'memory_projects', { action: 'list' }, { 'oai-authenticated-user-id': 'forged' })).status, 401);
});
test('invalid RPC arguments are rejected without invoking OpenAI', async () => {
  const worker = createWorker(() => { throw new Error('must not run'); }); const response = await rpc(worker, 'memory_complete', { ...base, unexpected: true });
  const payload = await response.json(); assert.equal(payload.result.isError, true); assert.equal(JSON.parse(payload.result.content[0].text).code, 'invalid_input');
});
test('discovery advertises conditional calls, latest assertions, and daily maintenance', async () => {
  const request = new Request('https://private.chatgpt.site/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'oai-authenticated-user-id': 'owner' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) });
  const { result } = await (await createWorker().fetch(request, {})).json();
  assert.match(result.instructions, /memory_complete once/); assert.match(result.instructions, /latest/i); assert.match(result.instructions, /maintain/i);
  assert.deepEqual(result.supportedVersions, ['2026-07-28']);
});
test('tool discovery preserves original names and advertises maintenance/audit with shared icons', async () => {
  const expected = ['memory_projects', 'memory_query', 'memory_read', 'memory_complete', 'memory_status', 'memory_maintain', 'memory_audit'];
  assert.deepEqual(TOOLS.map(t => t.name), expected);
  assert.equal(TOOLS.find(t => t.name === 'memory_audit').annotations.readOnlyHint, true);
  const [icon] = TOOLS[0].icons; assert.equal(icon.mimeType, 'image/svg+xml'); assert.deepEqual(icon.sizes, ['any']);
  assert.match(Buffer.from(icon.src.split(',')[1], 'base64').toString(), /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  for (const tool of TOOLS) assert.deepEqual(tool.icons, [icon]);
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
  assert.equal((await new Memory({ MEMORY_NAMESPACE: 'test' }, api).projects()).length, 1);
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


export { FakeOpenAI, base, fixture, fact };
