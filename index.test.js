import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { getInput, parseResults, renderCommentBody, runUproadPush, commentOnPullRequest, main, cliCommand } from './index.js'

// 本番は `npx --yes uproad@^1` を叩く（下のテストで確認する）。テストのたびにnpxがレジストリを
// 引きに行くのを避けたいので、devDependencyとして入れた同じパッケージを UPROAD_CLI で直接指す。
// 偽物ではなく公開済みの本物のCLIに対して回るので、結合の検証としては同じ意味を持つ。
const LOCAL_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', 'uproad', 'bin', 'uproad.js')
process.env.UPROAD_CLI = LOCAL_CLI

test('by default the action runs the published CLI through npx, not a sibling directory', () => {
  const saved = process.env.UPROAD_CLI
  delete process.env.UPROAD_CLI
  try {
    const { file, args } = cliCommand(['push', 'a.html'])
    // リポジトリ相対のパスを踏むと、`uses:` 経由のチェックアウトには cli/node_modules が無いため
    // CLIの glob 解決に失敗する。npx なら依存ごと解決される。
    assert.equal(file, 'npx')
    assert.deepEqual(args, ['--yes', 'uproad@^1', 'push', 'a.html'])
  } finally {
    process.env.UPROAD_CLI = saved
  }
})

test('getInput reads INPUT_<NAME> env vars, preserving hyphens, and falls back', () => {
  process.env['INPUT_FILES'] = 'dist/*.html'
  process.env['INPUT_GITHUB-TOKEN'] = 'ghp_abc'
  assert.equal(getInput('files'), 'dist/*.html')
  assert.equal(getInput('github-token'), 'ghp_abc')
  assert.equal(getInput('missing', 'fallback-value'), 'fallback-value')
  delete process.env['INPUT_FILES']
  delete process.env['INPUT_GITHUB-TOKEN']
})

test('parseResults reads the last non-empty line as JSON', () => {
  const stdout = 'Pushed a.html -> design d1 (v1)\n  https://uproad.app/p/x\n[{"file":"a.html","designId":"d1","versionNo":1,"url":"https://uproad.app/p/x"}]\n'
  const results = parseResults(stdout)
  assert.equal(results.length, 1)
  assert.equal(results[0].designId, 'd1')
})

test('parseResults returns an empty array for blank output', () => {
  assert.deepEqual(parseResults('   \n  '), [])
})

test('renderCommentBody lists successes with links and failures with a warning marker', () => {
  const body = renderCommentBody([
    { file: 'index.html', designId: 'd1', versionNo: 3, url: 'https://uproad.app/p/x' },
    { file: 'broken.html', error: 'html too large (25MB max)' },
  ])
  assert.ok(body.includes('<!-- uproad-action-comment -->'))
  assert.ok(body.includes('[index.html](https://uproad.app/p/x) — v3'))
  assert.ok(body.includes('⚠️ broken.html: html too large (25MB max)'))
})

async function withMockServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('runUproadPush shells out to the CLI and returns its JSON output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'uproad-action-'))
  const file = path.join(dir, 'index.html')
  await writeFile(file, '<h1>hi</h1>')

  const mock = await withMockServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/designs') {
        res.writeHead(201)
        res.end(JSON.stringify({ design_id: 'd1', version_id: 'v1', version_no: 1 }))
      } else {
        res.writeHead(200)
        res.end(JSON.stringify({ url: 'https://uproad.app/p/x' }))
      }
    })
  })
  try {
    const stdout = await runUproadPush({ files: file, token: 't', api: mock.url })
    const results = parseResults(stdout)
    assert.equal(results.length, 1)
    assert.equal(results[0].designId, 'd1')
    assert.equal(results[0].url, 'https://uproad.app/p/x')
  } finally {
    await mock.close()
  }
})

test('commentOnPullRequest creates a comment, then updates the same one on a second call', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'uproad-action-'))
  const eventPath = path.join(dir, 'event.json')
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 42 } }))
  process.env.GITHUB_EVENT_PATH = eventPath
  process.env.GITHUB_REPOSITORY = 'naruto1031/uproad'

  const requests = []
  let existingComments = []
  const mock = await withMockServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && req.url.includes('/issues/42/comments')) {
        res.writeHead(200)
        res.end(JSON.stringify(existingComments))
      } else if (req.method === 'POST' && req.url.includes('/issues/42/comments')) {
        existingComments = [{ id: 999, body: JSON.parse(body).body }]
        res.writeHead(201)
        res.end(JSON.stringify({ id: 999 }))
      } else if (req.method === 'PATCH' && req.url.includes('/issues/comments/999')) {
        res.writeHead(200)
        res.end(JSON.stringify({ id: 999 }))
      } else {
        res.writeHead(404)
        res.end('{}')
      }
    })
  })
  process.env.GITHUB_API_URL = mock.url

  try {
    await commentOnPullRequest('gh-token', [{ file: 'a.html', designId: 'd1', versionNo: 1, url: 'https://uproad.app/p/a' }])
    await commentOnPullRequest('gh-token', [{ file: 'a.html', designId: 'd1', versionNo: 2, url: 'https://uproad.app/p/a' }])

    const methods = requests.map((r) => r.method)
    assert.deepEqual(methods, ['GET', 'POST', 'GET', 'PATCH'])
    assert.ok(requests[3].body.body.includes('v2'))
  } finally {
    await mock.close()
    delete process.env.GITHUB_EVENT_PATH
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_API_URL
  }
})

test('main() wires push + outputs + PR comment together end-to-end', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'uproad-action-'))
  const file = path.join(dir, 'index.html')
  await writeFile(file, '<h1>hi</h1>')
  const outputFile = path.join(dir, 'github_output')
  await writeFile(outputFile, '')
  const eventPath = path.join(dir, 'event.json')
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 7 } }))

  const uproadMock = await withMockServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/designs') {
        res.writeHead(201)
        res.end(JSON.stringify({ design_id: 'd1', version_id: 'v1', version_no: 1 }))
      } else {
        res.writeHead(200)
        res.end(JSON.stringify({ url: 'https://uproad.app/p/x' }))
      }
    })
  })
  const commentRequests = []
  const githubMock = await withMockServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      commentRequests.push({ method: req.method, url: req.url })
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET') {
        res.writeHead(200)
        res.end('[]')
      } else {
        res.writeHead(201)
        res.end('{}')
      }
    })
  })

  Object.assign(process.env, {
    INPUT_FILES: file,
    INPUT_TOKEN: 't',
    INPUT_API: uproadMock.url,
    INPUT_COMMENT: 'true',
    'INPUT_GITHUB-TOKEN': 'gh-token',
    GITHUB_OUTPUT: outputFile,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'naruto1031/uproad',
    GITHUB_API_URL: githubMock.url,
  })

  try {
    process.exitCode = undefined
    await main()
    assert.notEqual(process.exitCode, 1)

    const output = await readFile(outputFile, 'utf8')
    assert.ok(output.includes('urls<<'))
    assert.ok(output.includes('https://uproad.app/p/x'))
    assert.deepEqual(
      commentRequests.map((r) => r.method),
      ['GET', 'POST'],
    )
  } finally {
    process.exitCode = undefined
    await uproadMock.close()
    await githubMock.close()
    for (const key of [
      'INPUT_FILES',
      'INPUT_TOKEN',
      'INPUT_API',
      'INPUT_COMMENT',
      'INPUT_GITHUB-TOKEN',
      'GITHUB_OUTPUT',
      'GITHUB_EVENT_PATH',
      'GITHUB_REPOSITORY',
      'GITHUB_API_URL',
    ]) {
      delete process.env[key]
    }
  }
})
