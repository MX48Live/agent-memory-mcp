import assert from 'node:assert/strict';
import { Memory, OpenAI } from '../worker/index.js';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
const namespace = `smoke-${Date.now()}`;
const env = { ...process.env, OPENAI_PROJECT_ID: process.env.OPENAI_PROJECT_ID || 'proj_Z3kujHUl40lZDe5LQR7LWhxa', MEMORY_NAMESPACE: namespace };
const api = new OpenAI(env); const memory = new Memory(env, api);
const cleanupErrors = [];
const createdStores = new Set();
try {
  const created = await memory.memory_projects({ action: 'create', project_key: 'smoke-test' });
  if (created.created_vector_store_id) createdStores.add(created.created_vector_store_id);
  for (let i = 0; i < 12; i++) {
    if ((await memory.projects()).some(v => v.metadata.project_key === 'smoke-test')) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  const input = { project_key: 'smoke-test', task_key: 'synthetic-smoke-task', summary: 'For this synthetic test project, the launch color is violet.', knowledge: ['The synthetic launch color is violet.'], sources: ['Synthetic smoke-test fixture, not real user knowledge.'], validation: 'Synthetic integration check.', duration: '~1m', caveats: ['Disposable fixture.'] };
  let result = await memory.memory_complete(input);
  console.log(JSON.stringify({ stage: 'write', status: result.status, operation_id: result.operation_id }));
  for (let i = 0; result.status === 'pending' && i < 12; i++) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    result = await new Memory(env, api).memory_status({ project_key: 'smoke-test', operation_id: result.operation_id, resume: true });
  }
  assert.equal(result.status, 'saved');
  const count = (await memory.files()).length;
  const retry = await new Memory(env, api).memory_complete(input);
  assert.equal(retry.status, 'saved'); assert.equal((await memory.files()).length, count);
  const read = await memory.memory_read({ project_key: 'smoke-test', file_id: result.log_file_id });
  assert.match(read.text, /violet/);
  let query;
  for (let i = 0; i < 6; i++) {
    query = await memory.memory_query({ project_key: 'smoke-test', query: 'What is the synthetic launch color?' });
    if (query.status === 'answered') break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.equal(query.status, 'answered'); assert.match(query.answer.toLowerCase(), /violet/); assert(query.citations.length);
  console.log(JSON.stringify({ stage: 'verified', write: 'saved', retry: 'deduplicated', exact_read: 'passed', query: query.answer, citations: query.citations.length }));
} finally {
  // Delete only this run's generated namespace, including partially uploaded fixtures.
  for (const store of await memory.projects()) createdStores.add(store.id);
  for (const id of createdStores) {
    try { await api.request(`/vector_stores/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (error) { cleanupErrors.push({ resource: id, code: error.code }); }
  }
  for (const file of await memory.files()) {
    try { await api.request(`/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' }); }
    catch (error) { cleanupErrors.push({ resource: file.id, code: error.code }); }
  }
  console.log(JSON.stringify({ stage: 'cleanup', namespace, errors: cleanupErrors }));
  if (cleanupErrors.length) process.exitCode = 1;
}
