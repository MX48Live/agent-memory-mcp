import { createServer } from 'node:http';
import worker from '../worker/index.js';
if (!process.env.MEMORY_LOCAL_TOKEN) throw new Error('Set MEMORY_LOCAL_TOKEN for local development.');
createServer(async (req, res) => {
  try {
    const body = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 131072) { res.writeHead(413).end(); return; }
      body.push(chunk);
    }
    const request = new Request(`http://127.0.0.1:8787${req.url}`, {
      method: req.method, headers: req.headers,
      ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(body) }),
    });
    // Local callers must use the development token, never forged Sites headers.
    request.headers.delete('oai-authenticated-user-id');
    const response = await worker.fetch(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500).end('Request failed'); }
}).listen(8787, '127.0.0.1', () => console.log('Memory MCP: http://127.0.0.1:8787/mcp'));
