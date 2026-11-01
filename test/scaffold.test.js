import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  scaffoldBase,
  seedSkill,
  ensureGitignore,
  buildAgentInstructionBlock,
  seedAgentInstructions
} from '../server/scaffold.js'

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knl-scaffold-'))
}

describe('scaffoldBase', () => {
  test('creates standard layout with READMEs', async () => {
    const dir = makeTempDir()
    const target = path.join(dir, '.knowledges')
    const actions = await scaffoldBase({ root: target, structure: 'standard' })

    assert.ok(fs.existsSync(path.join(target, 'README.md')))
    assert.ok(fs.existsSync(path.join(target, 'roadmap', 'README.md')))
    assert.ok(fs.existsSync(path.join(target, 'features', 'README.md')))
    assert.ok(fs.existsSync(path.join(target, 'docs', 'README.md')))
    assert.ok(actions.length > 0)
  })

  test('rejects path traversal in custom folders', async () => {
    const dir = makeTempDir()
    const target = path.join(dir, '.knowledges')
    await scaffoldBase({
      root: target,
      structure: 'custom',
      folders: ['../../escaped_dir', 'valid_sub']
    })
    assert.ok(fs.existsSync(path.join(target, 'valid_sub', 'README.md')))
    assert.ok(!fs.existsSync(path.join(dir, 'escaped_dir')))
  })
})

describe('seedSkill', () => {
  test('seeds knl-view SKILL.md in project scope', async () => {
    const dir = makeTempDir()
    const result = await seedSkill({ scope: 'project', cwd: dir })
    assert.equal(result.status, 'created')
    assert.ok(fs.existsSync(result.path))
    const content = fs.readFileSync(result.path, 'utf8')
    assert.ok(content.includes('name: knl-view'))
  })

  test('skips if already existing', async () => {
    const dir = makeTempDir()
    await seedSkill({ scope: 'project', cwd: dir })
    const result = await seedSkill({ scope: 'project', cwd: dir })
    assert.equal(result.status, 'skipped')
  })
})

describe('ensureGitignore', () => {
  test('creates .gitignore with .knowledges/ when missing', async () => {
    const dir = makeTempDir()
    const result = await ensureGitignore({ cwd: dir })
    assert.equal(result.status, 'created')
    const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
    assert.ok(content.includes('.knowledges/'))
  })

  test('skips if .knowledges/ already ignored', async () => {
    const dir = makeTempDir()
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.knowledges/\n', 'utf8')
    const result = await ensureGitignore({ cwd: dir })
    assert.equal(result.status, 'skipped')
  })
})

describe('buildAgentInstructionBlock', () => {
  test('includes Graphify fallback when hasGraphify is true', () => {
    const block = buildAgentInstructionBlock(true)
    assert.ok(block.includes('Graphify is the fallback'))
    assert.ok(block.includes('/graphify'))
    assert.ok(block.includes('<!-- knl-view:start -->'))
    assert.ok(block.includes('<!-- knl-view:end -->'))
  })

  test('omits Graphify fallback when hasGraphify is false', () => {
    const block = buildAgentInstructionBlock(false)
    assert.ok(!block.includes('Graphify is the fallback'))
    assert.ok(!block.includes('/graphify'))
    assert.ok(block.includes('KNL-View is the primary graph tool'))
  })
})

describe('seedAgentInstructions', () => {
  test('creates AGENTS.md in project if no agent files exist', async () => {
    const dir = makeTempDir()
    const actions = await seedAgentInstructions({ cwd: dir, home: dir, hasGraphify: false })
    assert.ok(actions.some((a) => a.path === path.join(dir, 'AGENTS.md') && a.status === 'created'))

    const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
    assert.ok(content.includes('KNL-View is the primary graph tool'))
    assert.ok(!content.includes('Graphify is the fallback'))
  })

  test('updates existing AGENTS.md preserving other sections and replacing knl-view block', async () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'AGENTS.md')
    fs.writeFileSync(file, '# Custom Project Rules\n\nExisting rule here.\n', 'utf8')

    const actions = await seedAgentInstructions({ cwd: dir, home: dir, hasGraphify: true })
    assert.ok(actions.some((a) => a.path === file && a.status === 'updated'))

    let content = fs.readFileSync(file, 'utf8')
    assert.ok(content.includes('# Custom Project Rules'))
    assert.ok(content.includes('Existing rule here.'))
    assert.ok(content.includes('Graphify is the fallback'))

    // Run again with hasGraphify: false to ensure replacement works without duplicate blocks
    const actions2 = await seedAgentInstructions({ cwd: dir, home: dir, hasGraphify: false })
    assert.ok(actions2.some((a) => a.path === file && a.status === 'updated'))

    content = fs.readFileSync(file, 'utf8')
    assert.ok(content.includes('# Custom Project Rules'))
    assert.ok(!content.includes('Graphify is the fallback'))
    assert.equal(content.split('<!-- knl-view:start -->').length - 1, 1)
  })

  test('cleans up legacy unfenced instructions and stray duplicate blocks', async () => {
    const dir = makeTempDir()
    const file = path.join(dir, 'AGENTS.md')
    fs.writeFileSync(
      file,
      `# Knowledge graph tools
- KNL-View is the primary graph tool.

## Custom Operations
- Some custom rule

## KNL-View graph access
- old unfenced access rule

<!-- knl-view:start -->
stray block
<!-- knl-view:end -->
`,
      'utf8'
    )

    await seedAgentInstructions({ cwd: dir, home: dir, hasGraphify: false })
    const content = fs.readFileSync(file, 'utf8')

    assert.ok(content.includes('## Custom Operations'))
    assert.ok(content.includes('- Some custom rule'))
    assert.equal(content.split('<!-- knl-view:start -->').length - 1, 1)
    assert.equal(content.split('<!-- knl-view:end -->').length - 1, 1)
    assert.ok(!content.includes('stray block'))
  })

  test('skips if instruction block is already byte-identical', async () => {
    const dir = makeTempDir()
    await seedAgentInstructions({ cwd: dir, home: dir, hasGraphify: false })
    const actions2 = await seedAgentInstructions({ cwd: dir, home: dir, hasGraphify: false })
    assert.ok(actions2.some((a) => a.path === path.join(dir, 'AGENTS.md') && a.status === 'skipped'))
  })
})
