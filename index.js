import { execFile } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const STICKY_COMMENT_MARKER = '<!-- uproad-action-comment -->'

// CLIは公開済みのnpmパッケージをnpx経由で実行する。
// 以前は兄弟ディレクトリの cli/bin/uproad.js を直接呼んでいたが、`uses:` でこのActionが使われると
// GitHubはリポジトリをチェックアウトするだけで、node_modules は .gitignore なので存在しない。
// そのためCLIの `import { glob } from 'glob'` が ERR_MODULE_NOT_FOUND で必ず落ちていた
// （CIはAction実行前に cli の依存を入れていたので、この経路だけテストで素通りしていた）。
//
// バージョンはメジャーで固定する: パッチ・マイナーの修正はActionを再リリースせずに届き、
// 破壊的変更からは守られる。
const CLI_SPEC = 'uproad@^1'

// UPROAD_CLI にローカルのエントリポイントを渡すと、npxではなくそれを直接実行する。
// テストと、このリポジトリで未公開の変更を試すための逃げ道。
export function cliCommand(args) {
  const local = process.env.UPROAD_CLI
  if (local) return { file: process.execPath, args: [local, ...args] }
  return { file: 'npx', args: ['--yes', CLI_SPEC, ...args] }
}

// このAction自体は依存ゼロで書く（node_modules を配布しなくて済むように）。
// アップロードの実体は上のCLI、GitHub REST APIも@actions/githubを使わずfetchで直接叩く。
export function getInput(name, fallback = '') {
  const raw = process.env[`INPUT_${name.toUpperCase()}`]
  return raw !== undefined && raw.trim() !== '' ? raw : fallback
}

function fail(message) {
  console.log(`::error::${message}`)
  process.exitCode = 1
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT
  if (!outputFile) return
  const delimiter = `__uproad_${Math.random().toString(36).slice(2)}__`
  appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

// execFileの非同期版を使う：同期版(execFileSync)はイベントループを止めてしまい、テストのような
// 「同一プロセス内のモックHTTPサーバーに子プロセスから接続する」構成だと自分自身を詰まらせて
// デッドロックする（親が同期待ちの間、モックサーバー側のイベントループも進めない）。
export async function runUproadPush({ files, token, api, project }) {
  const args = ['push', files, '--token', token, '--api', api, '--json']
  if (project) args.push('--project', project)
  const { file, args: argv } = cliCommand(args)
  try {
    const { stdout } = await execFileAsync(file, argv, { maxBuffer: 20 * 1024 * 1024 })
    return stdout
  } catch (err) {
    // 一部ファイルの失敗でuproad pushは非0終了するが、成功分含むJSONはstdoutに出ている
    if (typeof err.stdout === 'string' && err.stdout.trim()) return err.stdout
    throw new Error(`uproad push failed to run: ${err.message}`)
  }
}

// この run で push した全デザインに、同じドキュメント一式を添付する。
// 「どのデザインに付けるか」を指定させないのは、Actionの単位が「このコミットのデプロイ」であり、
// docs/ もそのコミットの成果物だから。3つHTMLを上げたなら3つとも同じ仕様書を指しているのが自然。
export async function runUproadPushDocs({ docs, designId, token, api, sync }) {
  const args = ['push-docs', docs, '--design', designId, '--token', token, '--api', api, '--json']
  if (sync) args.push('--sync')
  const { file, args: argv } = cliCommand(args)
  try {
    const { stdout } = await execFileAsync(file, argv, { maxBuffer: 20 * 1024 * 1024 })
    return stdout
  } catch (err) {
    if (typeof err.stdout === 'string' && err.stdout.trim()) return err.stdout
    throw new Error(`uproad push-docs failed to run: ${err.message}`)
  }
}

export function parseResults(stdout) {
  const lastLine = stdout
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .pop()
  if (!lastLine) return []
  return JSON.parse(lastLine)
}

export function renderCommentBody(results) {
  const ok = results.filter((r) => !r.error)
  const failed = results.filter((r) => r.error)
  const lines = [STICKY_COMMENT_MARKER, '### 🎨 Uproad design preview', '']
  for (const r of ok) {
    const label = r.url ? `[${r.file}](${r.url})` : r.file
    lines.push(`- ${label} — v${r.versionNo}`)
  }
  for (const r of failed) {
    lines.push(`- ⚠️ ${r.file}: ${r.error}`)
  }
  return lines.join('\n')
}

export async function commentOnPullRequest(githubToken, results) {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !githubToken) return
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const prNumber = event.pull_request?.number
  if (!prNumber) return // pushイベント等、PRが無いコンテキストでは何もしない

  const [owner, repo] = String(process.env.GITHUB_REPOSITORY ?? '').split('/')
  if (!owner || !repo) return
  const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com'
  const headers = {
    authorization: `Bearer ${githubToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'uproad-action',
  }
  const body = renderCommentBody(results)

  // 同じPRへの再pushで新規コメントが積み上がらないよう、既存のsticky commentを探して更新する
  const listRes = await fetch(`${apiBase}/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`, { headers })
  const comments = listRes.ok ? await listRes.json() : []
  const existing = Array.isArray(comments) ? comments.find((c) => typeof c.body === 'string' && c.body.includes(STICKY_COMMENT_MARKER)) : null

  const target = existing
    ? { url: `${apiBase}/repos/${owner}/${repo}/issues/comments/${existing.id}`, method: 'PATCH' }
    : { url: `${apiBase}/repos/${owner}/${repo}/issues/${prNumber}/comments`, method: 'POST' }
  const res = await fetch(target.url, {
    method: target.method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  if (!res.ok) console.log(`::warning::failed to post PR comment: HTTP ${res.status}`)
}

export async function main() {
  const files = getInput('FILES')
  const token = getInput('TOKEN')
  const api = getInput('API', 'https://uproad.design')
  const project = getInput('PROJECT')
  const docs = getInput('DOCS')
  const docsSync = getInput('DOCS-SYNC', 'false') === 'true'
  const shouldComment = getInput('COMMENT', 'true') === 'true'
  const githubToken = getInput('GITHUB-TOKEN') || process.env.GITHUB_TOKEN || ''

  if (!files) return fail('input "files" is required')
  if (!token) return fail('input "token" is required')

  const stdout = await runUproadPush({ files, token, api, project })
  const results = parseResults(stdout)
  const urls = results.filter((r) => r.url).map((r) => r.url)
  const failed = results.filter((r) => r.error)

  setOutput('results', JSON.stringify(results))
  setOutput('urls', urls.join('\n'))

  for (const r of results) {
    if (r.error) console.log(`::error::${r.file}: ${r.error}`)
    else console.log(`Pushed ${r.file} -> ${r.url ?? `design ${r.designId}`} (v${r.versionNo})`)
  }

  // ドキュメントの添付は「おまけ」。ここで失敗してもプロトタイプのpushとPRコメントは成功扱いのまま、
  // 警告だけ出す（仕様書が1つ添付できなかっただけでCIを赤くしても得がない）。
  if (docs) {
    for (const r of results.filter((x) => !x.error)) {
      try {
        // push-docs --json は1行のJSONオブジェクトを出す。最後の行を拾う手順は push と同じ
        const docResults = parseResults(await runUproadPushDocs({ docs, designId: r.designId, token, api, sync: docsSync }))
        for (const w of docResults.written ?? []) console.log(`Attached ${w.path} -> design ${r.designId}`)
        for (const d of docResults.deleted ?? []) console.log(`Removed ${d} from design ${r.designId}`)
        for (const e of docResults.errors ?? []) console.log(`::warning::${e.path}: ${e.error}`)
      } catch (err) {
        console.log(`::warning::failed to attach documents to design ${r.designId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (shouldComment) await commentOnPullRequest(githubToken, results)
  if (failed.length > 0) process.exitCode = 1
}

// テストからimportした時はmain()を自動実行しない。実行ファイルとして起動された時だけ動く。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)))
}
