#!/usr/bin/env node
// Menyiapkan dist/ saat instalasi.
//
// Konteks: `npm install -g <git-url>` di npm 11 menjalankan "git dep
// preparation" dengan konteks global yang mewarisi ke subprosesnya, sehingga
// devDependencies tidak terpasang di clone. `prepare` tetap dipanggil di
// clone, dan `vite build` gagal 127 (vite: not found). Skrip ini menangani
// kedua keadaan: vite sudah ada (build langsung) atau belum (pasang dulu dev
// dependencies secara lokal, lalu build).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')

if (!fs.existsSync(viteBin)) {
  console.log('knl-view prepare: vite belum terpasang, memasang devDependencies dulu...')
  const args = [
    'install',
    '--global=false',
    '--include=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]
  // npm_execpath dipakai agar memakai npm yang sama dengan yang memanggil kita.
  const npmCli = process.env.npm_execpath
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd: root,
        stdio: 'inherit',
      })
  if (r.status !== 0) {
    console.error('knl-view prepare: pemasangan devDependencies gagal')
    process.exit(r.status ?? 1)
  }
}

if (!fs.existsSync(viteBin)) {
  console.error('knl-view prepare: vite tetap tidak ditemukan setelah pemasangan')
  process.exit(1)
}

const build = spawnSync(process.execPath, [viteBin, 'build'], { cwd: root, stdio: 'inherit' })
process.exit(build.status ?? 1)
