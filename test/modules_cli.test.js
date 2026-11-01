import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const CLI = path.resolve('bin/knl-view.js')

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

describe('modules CLI commands', () => {
  test('modules list prints json with all 4 ecosystems', () => {
    const res = runCli(['modules', 'list'])
    assert.equal(res.status, 0)
    const data = JSON.parse(res.stdout)
    assert.ok(data.npm)
    assert.ok(data.go)
    assert.ok(data.cargo)
    assert.ok(data.pypi)
  })

  test('modules list npm filters to npm ecosystem', () => {
    const res = runCli(['modules', 'list', 'npm'])
    assert.equal(res.status, 0)
    const data = JSON.parse(res.stdout)
    assert.ok(data.npm)
    assert.equal(data.go, undefined)
  })

  test('modules build-graph requires target', () => {
    const res = runCli(['modules', 'build-graph'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /Target is required/)
  })

  test('modules build-graph requires <eco>::<name> format', () => {
    const res = runCli(['modules', 'build-graph', 'express'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /Invalid module target "express"/)
  })

  test('modules trace requires target', () => {
    const res = runCli(['modules', 'trace'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /Target is required/)
  })

  test('modules unknown subcommand prints usage', () => {
    const res = runCli(['modules', 'bad-command'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /Unknown modules subcommand/)
  })
})
