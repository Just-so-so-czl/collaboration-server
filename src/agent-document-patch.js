import { createHash } from 'node:crypto'
import * as Y from 'yjs'

export class AgentPatchConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AgentPatchConflictError'
  }
}

const textHash = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function nodeText(node) {
  if (!node || typeof node !== 'object') return ''
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : ''
  return (Array.isArray(node.content) ? node.content : []).map(nodeText).join('')
}

function yNodeText(node) {
  if (node instanceof Y.XmlText) {
    return node.toDelta().map((part) => typeof part.insert === 'string' ? part.insert : '').join('')
  }
  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    return node.toArray().map(yNodeText).join('')
  }
  return ''
}

function isEditableJsonBlock(node) {
  return node?.type === 'heading' || node?.type === 'paragraph'
}

function isEditableYBlock(node) {
  return node instanceof Y.XmlElement && ['heading', 'paragraph'].includes(node.nodeName)
}

export function buildAgentBlocks(contentJson) {
  const nodes = Array.isArray(contentJson?.content) ? contentJson.content : []
  return nodes.reduce((blocks, node, index) => {
    if (!isEditableJsonBlock(node)) return blocks
    const text = nodeText(node).trim()
    if (!text) return blocks
    blocks.push({
      blockId: `top-${index}`,
      type: node.type,
      level: node.type === 'heading' ? Number(node.attrs?.level || 1) : null,
      text,
      textHash: textHash(text),
    })
    return blocks
  }, [])
}

export function normalizePatchOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > 12) {
    throw new Error('草案必须包含 1 到 12 项段落或章节编辑')
  }
  const targetKeys = new Set()
  return operations.map((item, index) => {
    const operation = String(item?.operation || '').trim().toUpperCase()
    const targetBlockId = String(item?.targetBlockId || '').trim()
    const expectedTextHash = String(item?.expectedTextHash || '').trim()
    const newText = String(item?.newText || '').trim()
    const reason = String(item?.reason || '').trim().slice(0, 300)
    if (!['INSERT_AFTER', 'REPLACE_BLOCK', 'DELETE_BLOCK'].includes(operation)) {
      throw new Error(`第 ${index + 1} 项编辑操作不受支持`)
    }
    if (!/^top-\d+$/.test(targetBlockId) || !/^[a-f0-9]{64}$/.test(expectedTextHash)) {
      throw new Error(`第 ${index + 1} 项缺少有效的目标块或原文校验信息`)
    }
    if (operation !== 'DELETE_BLOCK' && (!newText || newText.length > 6000)) {
      throw new Error(`第 ${index + 1} 项的新文本不能为空且不能超过 6000 字符`)
    }
    if (operation === 'REPLACE_BLOCK' && /\n\s*\n/.test(newText)) {
      throw new Error(`第 ${index + 1} 项替换操作只能修改一个标题或段落`)
    }
    const targetKey = `${targetBlockId}:${expectedTextHash}`
    if (targetKeys.has(targetKey)) {
      throw new Error('同一目标块不能在同一份草案中重复编辑')
    }
    targetKeys.add(targetKey)
    return { operation, targetBlockId, expectedTextHash, newText, reason }
  })
}

function locateCurrentBlock(contentJson, operation) {
  const nodes = Array.isArray(contentJson?.content) ? contentJson.content : []
  const targetIndex = Number(operation.targetBlockId.slice(4))
  const matches = (node) => isEditableJsonBlock(node) && textHash(nodeText(node).trim()) === operation.expectedTextHash
  if (Number.isInteger(targetIndex) && matches(nodes[targetIndex])) return targetIndex
  const matchedIndexes = nodes.reduce((indexes, node, index) => {
    if (matches(node)) indexes.push(index)
    return indexes
  }, [])
  if (matchedIndexes.length === 1) return matchedIndexes[0]
  throw new AgentPatchConflictError(`目标块 ${operation.targetBlockId} 已被修改、删除或无法唯一定位`)
}

const textNode = (text) => ({ type: 'text', text })
const paragraphNode = (text) => ({ type: 'paragraph', content: [textNode(text)] })

function buildParagraphElement(text) {
  const paragraph = new Y.XmlElement('paragraph')
  const xmlText = new Y.XmlText()
  xmlText.insert(0, text)
  paragraph.insert(0, [xmlText])
  return paragraph
}

function replaceTopLevelBlockText(block, text) {
  if (!isEditableYBlock(block)) {
    throw new AgentPatchConflictError('目标块已不再是可替换的标题或段落')
  }
  const child = block.get(0)
  if (block.length !== 1 || !(child instanceof Y.XmlText)) {
    throw new AgentPatchConflictError('目标块包含复杂富文本结构，第一版暂不支持直接替换')
  }
  child.delete(0, child.length)
  child.insert(0, text)
}

function validateResolvedChange(change, targetBlock) {
  if (change.operation === 'REPLACE_BLOCK') {
    if (targetBlock.length !== 1 || !(targetBlock.get(0) instanceof Y.XmlText)) {
      throw new AgentPatchConflictError('目标块包含复杂富文本结构，第一版暂不支持直接替换')
    }
  }
}

function resolveLiveYBlock(fragment, change) {
  const blocks = fragment.toArray()
  const expectedIndex = change.originalTargetIndex
  const matches = (block) => isEditableYBlock(block) && textHash(yNodeText(block).trim()) === change.expectedTextHash
  if (Number.isInteger(expectedIndex) && matches(blocks[expectedIndex])) return blocks[expectedIndex]
  const candidates = blocks.filter(matches)
  if (candidates.length === 1) return candidates[0]
  throw new AgentPatchConflictError(`目标块 ${change.targetBlockId} 已被修改、删除或无法唯一定位`)
}

/**
 * First resolve every target before mutating the Y.Doc. Yjs transactions do not roll back when
 * a callback throws, so preflight is required to keep a multi-operation proposal atomic.
 */
export function applyAgentPatchToYDoc(document, changes, fieldName) {
  const fragment = document.getXmlFragment(fieldName)
  const resolvedChanges = changes.map((change) => ({ ...change, targetBlock: resolveLiveYBlock(fragment, change) }))
  resolvedChanges.forEach(({ targetBlock, ...change }) => validateResolvedChange(change, targetBlock))
  for (const change of resolvedChanges) {
    const targetIndex = fragment.toArray().indexOf(change.targetBlock)
    if (targetIndex < 0) throw new AgentPatchConflictError(`目标块 ${change.targetBlockId} 已被删除`)
    if (change.operation === 'INSERT_AFTER') {
      const inserted = change.afterText.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean).map(buildParagraphElement)
      fragment.insert(targetIndex + 1, inserted)
      continue
    }
    if (change.operation === 'REPLACE_BLOCK') {
      replaceTopLevelBlockText(change.targetBlock, change.afterText)
      continue
    }
    if (change.operation === 'DELETE_BLOCK') {
      fragment.delete(targetIndex, 1)
    }
  }
}

export function simulateAgentPatch(baseContentJson, rawOperations) {
  const operations = normalizePatchOperations(rawOperations)
  const contentJson = JSON.parse(JSON.stringify(baseContentJson || { type: 'doc', content: [] }))
  if (contentJson.type !== 'doc' || !Array.isArray(contentJson.content)) {
    throw new Error('协作文档快照格式不正确')
  }
  const changes = []
  for (const operation of operations) {
    const index = locateCurrentBlock(contentJson, operation)
    const target = contentJson.content[index]
    const beforeText = nodeText(target).trim()
    const originalTargetIndex = Number(operation.targetBlockId.slice(4))
    if (operation.operation === 'INSERT_AFTER') {
      const paragraphs = operation.newText.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean)
      contentJson.content.splice(index + 1, 0, ...paragraphs.map(paragraphNode))
      changes.push({ ...operation, originalTargetIndex, beforeText, afterText: paragraphs.join('\n\n') })
      continue
    }
    if (operation.operation === 'REPLACE_BLOCK') {
      contentJson.content[index] = { type: target.type, ...(target.attrs ? { attrs: target.attrs } : {}), content: [textNode(operation.newText)] }
      changes.push({ ...operation, originalTargetIndex, beforeText, afterText: operation.newText })
      continue
    }
    contentJson.content.splice(index, 1)
    changes.push({ ...operation, originalTargetIndex, beforeText, afterText: '' })
  }
  return { contentJson, changes }
}

export function patchSummary(changes) {
  const countByOperation = changes.reduce((result, item) => {
    result[item.operation] = (result[item.operation] || 0) + 1
    return result
  }, {})
  const parts = []
  if (countByOperation.INSERT_AFTER) parts.push(`新增 ${countByOperation.INSERT_AFTER} 处`)
  if (countByOperation.REPLACE_BLOCK) parts.push(`修改 ${countByOperation.REPLACE_BLOCK} 处`)
  if (countByOperation.DELETE_BLOCK) parts.push(`删除 ${countByOperation.DELETE_BLOCK} 处`)
  return parts.join('，') || '未产生有效编辑'
}

export function publicPatchChanges(changes) {
  return changes.map(({ originalTargetIndex, ...change }) => change)
}
