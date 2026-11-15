import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SKILL_NAME_RE,
  parseSkillMarkdown,
  serializeSkillMarkdown,
} from '../src/markdown.ts'

test('parseSkillMarkdown round-trips managed fields and preserves unknown keys', () => {
  const raw = [
    '---',
    'name: demo',
    'description: 演示技能',
    'whenToUse: 需要演示时',
    'disable-model-invocation: true',
    'user-invocable: false',
    'metadata:',
    '  author: someone',
    'x-custom: keep-me',
    '---',
    '',
    '正文内容',
    '',
  ].join('\n')
  const parsed = parseSkillMarkdown(raw)
  assert.equal(parsed.name, 'demo')
  assert.equal(parsed.description, '演示技能')
  assert.equal(parsed.whenToUse, '需要演示时')
  assert.equal(parsed.disableModelInvocation, true)
  assert.equal(parsed.userInvocable, false)
  assert.equal(parsed.content, '正文内容')
  assert.deepEqual(parsed.extraLines, ['metadata:', '  author: someone', 'x-custom: keep-me'])
  assert.deepEqual(parseSkillMarkdown(serializeSkillMarkdown(parsed)), parsed)
})

test('serializeSkillMarkdown emits managed fields then preserved extras', () => {
  const out = serializeSkillMarkdown({ name: 'a', description: 'b', content: 'c', extraLines: ['metadata:', '  x: 1'] })
  assert.equal(out, '---\nname: a\ndescription: b\nmetadata:\n  x: 1\n---\n\nc\n')
})

test('frontmatter invocation booleans keep absent and unknown values unset', () => {
  const parsed = parseSkillMarkdown([
    '---',
    'name: demo',
    'description: 演示',
    'disable-model-invocation: maybe',
    'user-invocable: YES',
    '---',
    '',
    '正文',
  ].join('\n'))
  assert.equal(parsed.disableModelInvocation, undefined)
  assert.equal(parsed.userInvocable, true)

  const absent = parseSkillMarkdown('---\nname: demo\ndescription: 演示\n---\n\n正文\n')
  assert.equal(absent.disableModelInvocation, undefined)
  assert.equal(absent.userInvocable, undefined)
})

test('a document without frontmatter is all body', () => {
  const parsed = parseSkillMarkdown('\n只有正文\n\n')
  assert.equal(parsed.name, '')
  assert.equal(parsed.description, '')
  assert.equal(parsed.content, '只有正文')
  assert.deepEqual(parsed.extraLines, [])
})

test('SKILL_NAME_RE is the dsh kebab-case grammar', () => {
  for (const name of ['demo', 'a1', 'skill-center', 'x-1-y']) {
    assert.equal(SKILL_NAME_RE.test(name), true, name)
  }
  for (const name of ['Demo', 'demo_skill', '-demo', 'demo-', 'a--b', '']) {
    assert.equal(SKILL_NAME_RE.test(name), false, name)
  }
})

test('a closing --- at EOF without a trailing newline still parses frontmatter (评审 Minor 2)', () => {
  const parsed = parseSkillMarkdown('---\nname: demo\ndescription: 演示\n---')
  assert.equal(parsed.name, 'demo')
  assert.equal(parsed.description, '演示')
  assert.equal(parsed.content, '')
})

test('an empty frontmatter block parses as empty, not as body (评审 Minor 2)', () => {
  const parsed = parseSkillMarkdown('---\n---\n')
  assert.equal(parsed.name, '')
  assert.equal(parsed.description, '')
  assert.equal(parsed.content, '')
  assert.deepEqual(parsed.extraLines, [])
})

test('CRLF frontmatter normalizes extraLines to LF without mixing endings (评审 Minor 2)', () => {
  const raw = '---\r\nname: demo\r\ndescription: 演示\r\nmetadata:\r\n  author: someone\r\nx-custom: keep-me\r\n---\r\n\r\n正文\r\n'
  const parsed = parseSkillMarkdown(raw)
  assert.equal(parsed.name, 'demo')
  assert.equal(parsed.content, '正文')
  assert.deepEqual(parsed.extraLines, ['metadata:', '  author: someone', 'x-custom: keep-me'])
  const out = serializeSkillMarkdown(parsed)
  assert.equal(out.includes('\r'), false)
  assert.deepEqual(parseSkillMarkdown(out), parsed)
})
