import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  claimId,
  deriveStatus,
  claimsIndexPath,
  readClaimsIndex,
  recordClaim,
  consensusEdgeKey,
  readConsensusMirror,
  updateConsensusMirror,
  inboundConsensus,
  outboundConsensus,
  CONSENSUS_RELATIONS
} from '../server/consensus.js'

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knl-consensus-'))
}

describe('claimId', () => {
  test('content-addressed: same statement, same id', () => {
    assert.equal(claimId('We use bcrypt for passwords'), claimId('We use bcrypt for passwords'))
  })

  test('whitespace and case do not change the id', () => {
    assert.equal(claimId('  Same   Statement  '), claimId('same statement'))
  })

  test('different statements map to different ids with the c- shape', () => {
    const a = claimId('claim one')
    const b = claimId('claim two')
    assert.notEqual(a, b)
    assert.match(a, /^c-[0-9a-f]{16}$/)
    assert.match(b, /^c-[0-9a-f]{16}$/)
  })
})

describe('deriveStatus', () => {
  test('any objector makes the claim disputed', () => {
    assert.equal(deriveStatus(['a', 'b'], ['c']), 'disputed')
    assert.equal(deriveStatus([], ['c']), 'disputed')
  })

  test('support without objection is consensus', () => {
    assert.equal(deriveStatus(['a'], []), 'consensus')
  })

  test('no inbound relations at all is uncontested', () => {
    assert.equal(deriveStatus([], []), 'uncontested')
  })
})

describe('claim index', () => {
  test('records a claim and reads it back', async () => {
    const home = makeHome()
    const { id } = await recordClaim('model-x', 'Some statement', home)
    const { claims } = await readClaimsIndex('model-x', home)
    assert.equal(claims[id].text, 'Some statement')
    assert.equal(claimsIndexPath('model-x', home), path.join(home, '.knlview', 'claims', 'model-x.json'))
  })

  test('same statement is an idempotent update', async () => {
    const home = makeHome()
    const first = await recordClaim('model-x', 'Same text', home)
    const second = await recordClaim('model-x', 'Same text', home)
    assert.equal(first.id, second.id)
    const { claims } = await readClaimsIndex('model-x', home)
    assert.equal(Object.keys(claims).length, 1)
  })

  test('missing index reads as empty, broken index reports an error', async () => {
    const home = makeHome()
    const empty = await readClaimsIndex('model-x', home)
    assert.deepEqual(empty, { claims: {}, error: null })

    fs.mkdirSync(path.join(home, '.knlview', 'claims'), { recursive: true })
    fs.writeFileSync(path.join(home, '.knlview', 'claims', 'model-x.json'), '{ broken', 'utf8')
    const broken = await readClaimsIndex('model-x', home)
    assert.deepEqual(broken.claims, {})
    assert.match(broken.error, /Unexpected|JSON/)
  })
})

describe('consensus mirror', () => {
  const home = () => makeHome()

  test('link adds an edge, retract removes both relation types', async () => {
    const h = home()
    await updateConsensusMirror('m', { op: 'link', from: 'c-a', type: 'agrees_with', to: 'c-b' }, h)
    await updateConsensusMirror('m', { op: 'link', from: 'c-c', type: 'contradicts', to: 'c-b' }, h)
    let edges = await readConsensusMirror('m', h)
    assert.deepEqual(edges.sort(), [
      consensusEdgeKey('c-a', 'agrees_with', 'c-b'),
      consensusEdgeKey('c-c', 'contradicts', 'c-b')
    ])

    await updateConsensusMirror('m', { op: 'unlink', from: 'c-c', type: 'contradicts', to: 'c-b' }, h)
    edges = await readConsensusMirror('m', h)
    assert.deepEqual(edges, [consensusEdgeKey('c-a', 'agrees_with', 'c-b')])
  })

  test('a retracted-to-empty mirror stays a valid empty mirror', async () => {
    const h = home()
    await updateConsensusMirror('m', { op: 'link', from: 'c-a', type: 'agrees_with', to: 'c-b' }, h)
    await updateConsensusMirror('m', { op: 'unlink', from: 'c-a', type: 'agrees_with', to: 'c-b' }, h)
    const edges = await readConsensusMirror('m', h)
    assert.deepEqual(edges, [])
  })

  test('no mirror file reads as null', async () => {
    assert.equal(await readConsensusMirror('m', home()), null)
  })

  test('inbound and outbound halves split by direction and type', () => {
    const edges = [
      consensusEdgeKey('c-sup', 'agrees_with', 'c-target'),
      consensusEdgeKey('c-obj', 'contradicts', 'c-target'),
      consensusEdgeKey('c-target', 'agrees_with', 'c-other'),
      consensusEdgeKey('c-target', 'contradicts', 'c-foo'),
      consensusEdgeKey('c-noise', 'agrees_with', 'c-unrelated')
    ]
    const inbound = inboundConsensus(edges, 'c-target')
    assert.deepEqual(inbound.supporters, ['c-sup'])
    assert.deepEqual(inbound.objectors, ['c-obj'])

    const stance = outboundConsensus(edges, 'c-target')
    assert.deepEqual(stance.agrees, ['c-other'])
    assert.deepEqual(stance.contradicts, ['c-foo'])
  })
})

describe('CONSENSUS_RELATIONS', () => {
  test('exactly the two relation types the status derivation understands', () => {
    assert.deepEqual(CONSENSUS_RELATIONS, ['agrees_with', 'contradicts'])
  })
})
