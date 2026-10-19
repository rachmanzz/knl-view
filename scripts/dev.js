import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKnowledgeServer } from '../server/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(here, '..')

const apiPort = process.env.PORT || '8085'
const webPort = process.env.WEB_PORT || '5173'
const knowledgesPath = process.argv[2] || '.knowledges'
const root = path.resolve(process.cwd(), knowledgesPath)

const api = createKnowledgeServer({ root, dist: null, port: Number(apiPort) })
api.on('error', (err) => {
  process.stderr.write(`dev: API gagal dijalankan: ${err.message}\n`)
  process.exit(1)
})
api.listen(Number(apiPort), '127.0.0.1', () => {
  process.stdout.write(`dev: API   http://127.0.0.1:${apiPort}  (sumber ${root})\n`)
})

const vite = spawn('npx', ['vite', '--port', webPort, '--strictPort'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, KNL_API_PORT: apiPort }
})

function shutdown() {
  vite.kill('SIGTERM')
  api.close()
}

process.on('SIGINT', () => {
  shutdown()
  process.exit(0)
})
process.on('SIGTERM', () => {
  shutdown()
  process.exit(0)
})

vite.on('exit', (code) => {
  api.close()
  process.exit(code ?? 0)
})
