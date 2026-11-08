import assert from 'node:assert/strict';
import { Memory, OpenAI } from '../worker/index.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
const namespace = `smoke-${Date.now()}`;
const env = { ...process.env, OPENAI_PROJECT_ID: process.env.OPENAI_PROJECT_ID || 'proj_Z3kujHUl40lZDe5LQR7LWhxa', MEMORY_NAMESPACE: namespace };
const api = new OpenAI(env);
const memory = () => new Memory(env, api);
const cleanupErrors = []; const createdStores = new Set();
const pause = () => new Promise(resolve => setTimeout(resolve, 1500));
async function saved(input) {
  let result = await memory().memory_complete(input);
  console.log(JSON.stringify({ stage: 'write', task_key: input.task_key, status: result.status, operation_id: result.operation_id }));
  for (let i = 0; result.status === 'pending' && i < 24; i++) {
    await pause();
    result = await memory().memory_status({ project_key: input.project_key, operation_id: result.operation_id, resume: true });
  }
  assert.equal(result.status, 'saved'); return result;
}
async function answered() {
  let result;
  for (let i = 0; i < 12; i++) {
    result = await memory().memory_query({ project_key: 'smoke-test', query: 'Which runtime is currently used by the synthetic backend? Answer the runtime name.', include_global: false });
    if (result.status === 'answered') return result;
    assert.equal(result.status, 'insufficient_memory'); await pause();
  }
  assert.fail(`Synthetic query did not become available: ${result.status}`);
}
try {
  const created = await memory().memory_projects({ action: 'create', project_key: 'smoke-test' });
  if (created.created_vector_store_id) createdStores.add(created.created_vector_store_id);
  for (let i = 0; i < 12; i++) {
    if ((await memory().projects()).some(v => v.metadata.project_key === 'smoke-test')) break;
    await pause();
  }
  const input = { project_key: 'smoke-test', task_key: 'synthetic-node', summary: 'For this disposable synthetic project, the backend currently uses Node.js as its runtime.', knowledge: ['The backend runtime currently used by the synthetic project is Node.js.'], sources: ['Synthetic smoke-test fixture, not real user knowledge.'], validation: 'Synthetic integration check.', duration: '~1m', caveats: ['Disposable fixture.'] };
  const first = await saved(input);
  const read = await memory().memory_read({ project_key: 'smoke-test', file_id: first.capture_file_id });
  assert.match(read.text, /node/i);
  const count = (await memory().files()).length;
  const retry = await saved(input);
  assert.equal(retry.operation_id, first.operation_id);
  assert.equal((await memory().files()).length, count);
  await saved({ ...input, task_key: 'synthetic-bun', summary: 'The synthetic project has now switched its backend runtime from Node.js to Bun. Bun is already in use, not a future plan.', knowledge: ['The backend runtime currently used by the synthetic project is Bun.'] });
  const before = await answered(); assert.match(before.answer, /bun/i); assert(before.citations.length);
  let maintained;
  for (let i = 0; i < 30; i++) {
    maintained = await memory().memory_maintain({ project_key: 'smoke-test', task_key: 'synthetic-maintenance' });
    if (maintained.status !== 'pending') break;
    await pause();
  }
  assert.equal(maintained.status, 'saved'); assert(maintained.wiki_file_ids.length);
  const after = await answered(); assert.match(after.answer, /bun/i); assert(after.citations.length);
  let audit = await memory().memory_audit({ project_key: 'smoke-test' });
  for (let i = 0; audit.next_cursor && i < 30; i++) audit = await memory().memory_audit({ project_key: 'smoke-test', cursor: audit.next_cursor });
  assert(['clean', 'findings'].includes(audit.status), `Audit did not finish: ${JSON.stringify(audit)}`);
  assert(!audit.findings.some(f => /invalid|missing|corrupt|scope|failed|incomplete/i.test(f.code)), JSON.stringify(audit.findings));
  console.log(JSON.stringify({ stage: 'verified', write: 'saved', retry: 'deduplicated', exact_read: 'passed', before_maintenance: before.answer, after_maintenance: after.answer, wiki_pages: maintained.wiki_file_ids.length, audit: audit.status }));
} finally {
  // Cleanup is limited to this generated namespace, even after partial writes.
  const stores = (await api.list('/vector_stores')).filter(v => v.metadata?.memory_app === 'agent-memory-mcp' && v.metadata?.memory_namespace === namespace);
  for (const store of stores) createdStores.add(store.id);
  for (const id of createdStores) {
    try { await api.request(`/vector_stores/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (error) { cleanupErrors.push({ resource: id, code: error.code }); }
  }
  const prefix = `agent-memory-mcp--${namespace}--`;
  for (const file of (await api.list('/files')).filter(v => v.filename?.startsWith(prefix))) {
    try { await api.request(`/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }); }
    catch (error) { cleanupErrors.push({ resource: file.id, code: error.code }); }
  }
  console.log(JSON.stringify({ stage: 'cleanup', namespace, errors: cleanupErrors }));
  if (cleanupErrors.length) process.exitCode = 1;
}
