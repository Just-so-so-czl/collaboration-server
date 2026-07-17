import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from 'y-prosemirror'
import { AgentPatchConflictError, applyAgentPatchToYDoc, simulateAgentPatch } from '../src/agent-document-patch.js'

const FIELD_NAME = 'default'
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function documentWithParagraphs(...texts) {
  const document = new Y.Doc()
  const fragment = document.getXmlFragment(FIELD_NAME)
  document.transact(() => {
    fragment.insert(0, texts.map((text) => {
      const paragraph = new Y.XmlElement('paragraph')
      const xmlText = new Y.XmlText()
      xmlText.insert(0, text)
      paragraph.insert(0, [xmlText])
      return paragraph
    }))
  })
  return document
}

function contentJson(...texts) {
  return {
    type: 'doc',
    content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  }
}

function textAt(document, index) {
  return document.getXmlFragment(FIELD_NAME).get(index).get(0).toString()
}

test('REPLACE_BLOCK replaces the target text instead of inserting another paragraph', () => {
  const document = documentWithParagraphs('旧版本', '保留内容')
  const preview = simulateAgentPatch(contentJson('旧版本', '保留内容'), [{
    operation: 'REPLACE_BLOCK', targetBlockId: 'top-0', expectedTextHash: hash('旧版本'), newText: '新版本', reason: '修改措辞',
  }])

  document.transact(() => applyAgentPatchToYDoc(document, preview.changes, FIELD_NAME))

  assert.equal(document.getXmlFragment(FIELD_NAME).length, 2)
  assert.equal(textAt(document, 0), '新版本')
  assert.equal(textAt(document, 1), '保留内容')
  assert.equal(document.getXmlFragment(FIELD_NAME).toString().includes('旧版本'), false)
  assert.equal(JSON.stringify(yDocToProsemirrorJSON(document, FIELD_NAME)).includes('旧版本'), false)
})

test('replacement preserves an unrelated collaborator edit', () => {
  const document = documentWithParagraphs('第一段原文', '待替换段落')
  const preview = simulateAgentPatch(contentJson('第一段原文', '待替换段落'), [{
    operation: 'REPLACE_BLOCK', targetBlockId: 'top-1', expectedTextHash: hash('待替换段落'), newText: '助手修改后的段落', reason: '补全内容',
  }])
  document.transact(() => {
    const unrelated = document.getXmlFragment(FIELD_NAME).get(0).get(0)
    unrelated.delete(0, unrelated.length)
    unrelated.insert(0, '成员更新后的第一段')
  })

  document.transact(() => applyAgentPatchToYDoc(document, preview.changes, FIELD_NAME))

  assert.equal(textAt(document, 0), '成员更新后的第一段')
  assert.equal(textAt(document, 1), '助手修改后的段落')
})

test('a changed target conflicts before any operation is written', () => {
  const document = documentWithParagraphs('第一段原文', '第二段原文')
  const preview = simulateAgentPatch(contentJson('第一段原文', '第二段原文'), [
    { operation: 'REPLACE_BLOCK', targetBlockId: 'top-0', expectedTextHash: hash('第一段原文'), newText: '不应写入的第一段', reason: '修改' },
    { operation: 'REPLACE_BLOCK', targetBlockId: 'top-1', expectedTextHash: hash('第二段原文'), newText: '不应写入的第二段', reason: '修改' },
  ])
  document.transact(() => {
    const target = document.getXmlFragment(FIELD_NAME).get(1).get(0)
    target.delete(0, target.length)
    target.insert(0, '成员已修改第二段')
  })

  assert.throws(
    () => document.transact(() => applyAgentPatchToYDoc(document, preview.changes, FIELD_NAME)),
    AgentPatchConflictError,
  )
  assert.equal(textAt(document, 0), '第一段原文')
  assert.equal(textAt(document, 1), '成员已修改第二段')
})
