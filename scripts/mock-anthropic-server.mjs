// Mock Anthropic-compatible upstream for deterministic smoke testing.
// Serves POST /v1/messages (stream + non-stream) and GET /v1/models on 127.0.0.1.
// ASCII-only by design (PS 5.1 GBK pitfall). Usage:
//   MOCK_PORT=8787 node scripts/mock-anthropic-server.mjs
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.MOCK_PORT || 8787)
const MODEL = process.env.MOCK_MODEL || 'mock-flash'
// MOCK_MODE=openai -> serve OpenAI-compatible endpoints (/v1/models, /chat/completions)
// to exercise the router Anthropic<->OpenAI translation path in smoke tests.
const MODE = process.env.MOCK_MODE === 'openai' ? 'openai' : 'anthropic'
// MOCK_FAIL_MODE -> make this upstream fail on purpose, so smoke tests can prove
// the router actually fails over to the next provider instead of getting stuck:
//   quota402      : HTTP 402 + "Insufficient balance" body
//   http429       : HTTP 429 + rate limit body
//   stream-error  : HTTP 200, then SSE error event (overloaded) - the sneaky case
const FAIL_MODE = process.env.MOCK_FAIL_MODE || ''
const LOG_FILE = path.join(os.tmpdir(), 'cw-mock-server.log')

function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try {
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    // log failure is non-fatal
  }
}

const server = http.createServer((req, res) => {
  if (MODE === 'openai') return handleOpenAi(req, res)
  if (req.method === 'GET' && (req.url || '').startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'mock' }] }))
    return
  }
  if (req.method === 'POST' && (req.url || '').startsWith('/v1/messages')) {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        // ignore
      }
      const model = parsed.model || MODEL
      const stream = parsed.stream === true
      logLine(`POST /v1/messages model=${model} stream=${stream} auth=${req.headers['x-api-key'] ? 'present' : 'missing'}`)
      if (FAIL_MODE === 'quota402') {
        logLine(`FAIL_MODE=quota402 -> HTTP 402 model=${model}`)
        res.writeHead(402, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Insufficient balance, please recharge' } }))
        return
      }
      if (FAIL_MODE === 'http429') {
        logLine(`FAIL_MODE=http429 -> HTTP 429 model=${model}`)
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } }))
        return
      }
      if (FAIL_MODE === 'stream-error') {
        logLine(`FAIL_MODE=stream-error -> HTTP 200 then SSE error model=${model}`)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write('event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded, try again later' } }) + '\n\n')
        res.end()
        return
      }
      if (stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        send('message_start', {
          type: 'message_start',
          message: { id: 'msg_mock', type: 'message', role: 'assistant', content: [], model, stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } }
        })
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SMOKE-OK' } })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
        send('message_stop', { type: 'message_stop' })
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'SMOKE-OK' }],
            model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 2 }
          })
        )
      }
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { type: 'not_found', message: `${req.method} ${req.url}` } }))
})

/** OpenAI-compatible mode: GET /models + POST /chat/completions (stream + non-stream) */
function handleOpenAi(req, res) {
  if (req.method === 'GET' && (req.url || '').startsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'mock' }] }))
    return
  }
  if (req.method === 'POST' && (req.url || '').startsWith('/chat/completions')) {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        // ignore
      }
      const model = parsed.model || MODEL
      const stream = parsed.stream === true
      logLine(
        `POST /chat/completions model=${model} stream=${stream} auth=${req.headers.authorization ? 'present' : 'missing'}`
      )
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const chunk = (delta) =>
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl_mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`)
        chunk({ content: 'SMOKE' })
        chunk({ content: '-OK' })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl_mock',
            object: 'chat.completion',
            model,
            choices: [
              { index: 0, message: { role: 'assistant', content: 'SMOKE-OK' }, finish_reason: 'stop', logprobs: null }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
          })
        )
      }
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `${req.method} ${req.url}`, type: 'not_found' } }))
}

server.listen(PORT, '127.0.0.1', () => {
  logLine(`listening on http://127.0.0.1:${PORT} model=${MODEL} mode=${MODE}`)
})
