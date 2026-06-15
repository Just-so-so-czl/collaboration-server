import dotenv from 'dotenv'
import { Server } from '@hocuspocus/server'
import { TiptapTransformer } from '@hocuspocus/transformer'
import StarterKit from '@tiptap/starter-kit'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import { Table } from '@tiptap/extension-table'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TableRow from '@tiptap/extension-table-row'
import { TextStyle } from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import { Extension } from '@tiptap/core'
import { MongoClient } from 'mongodb'
import * as Y from 'yjs'

dotenv.config()

const PORT = Number(process.env.PORT || 1234)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017'
const MONGODB_DB = process.env.MONGODB_DB || 'teamup'
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || 'collaboration_documents'
const TIPTAP_FIELD_NAME = 'default'
const LOG_PREFIX = '[collab-server]'

function logStep(step, payload = {}) {
  console.log(LOG_PREFIX, step, payload)
}

function warnStep(step, payload = {}) {
  console.warn(LOG_PREFIX, step, payload)
}

function errorStep(step, error, payload = {}) {
  console.error(LOG_PREFIX, step, payload, error)
}

function elapsedMs(startedAt) {
  return `${Date.now() - startedAt}ms`
}

/**
 * 这个扩展与前端的 FontSizeExtension 保持一致。
 * 协同文档里的“字号”本质上是挂在 textStyle mark 上的自定义属性，
 * 如果服务端快照转换时缺少这份 schema，MongoDB 里的 JSON 快照就会丢失字号信息。
 */
const FontSizeExtension = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) {
                return {}
              }
              return {
                style: `font-size: ${attributes.fontSize}`,
              }
            },
          },
        },
      },
    ]
  },
})

/**
 * Transformer 必须使用和前端编辑器尽量一致的扩展集合，
 * 这样才能把 Y.Doc 正确还原成 Tiptap JSON 树，避免表格/高亮/链接等结构丢失。
 */
const snapshotExtensions = [
  StarterKit.configure({
    undoRedo: false,
    link: false,
    underline: false,
  }),
  TextStyle,
  FontSizeExtension,
  Color,
  Highlight.configure({ multicolor: true }),
  Underline,
  Table.configure({
    resizable: false,
  }),
  TableRow,
  TableHeader,
  TableCell,
  Link.configure({
    openOnClick: false,
  }),
]

const mongoClient = new MongoClient(MONGODB_URI)
let mongoCollectionPromise = null

async function getCollection() {
  if (!mongoCollectionPromise) {
    logStep('mongo.connect.start', {
      uri: MONGODB_URI,
      db: MONGODB_DB,
      collection: MONGODB_COLLECTION,
    })
    mongoCollectionPromise = mongoClient.connect().then((client) => {
      const db = client.db(MONGODB_DB)
      logStep('mongo.connect.success', {
        db: MONGODB_DB,
        collection: MONGODB_COLLECTION,
      })
      return db.collection(MONGODB_COLLECTION)
    }).catch((error) => {
      errorStep('mongo.connect.failed', error, {
        db: MONGODB_DB,
        collection: MONGODB_COLLECTION,
      })
      mongoCollectionPromise = null
      throw error
    })
  }
  return mongoCollectionPromise
}

function normalizeDocumentId(documentName) {
  return String(documentName || '').trim()
}

function toUint8Array(binaryValue) {
  if (!binaryValue) {
    return null
  }

  if (binaryValue instanceof Uint8Array) {
    return new Uint8Array(binaryValue.buffer, binaryValue.byteOffset, binaryValue.byteLength)
  }

  if (Buffer.isBuffer(binaryValue)) {
    return new Uint8Array(binaryValue.buffer, binaryValue.byteOffset, binaryValue.byteLength)
  }

  if (Buffer.isBuffer(binaryValue?.buffer)) {
    const buffer = binaryValue.buffer
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  if (binaryValue?.buffer instanceof Uint8Array) {
    const buffer = binaryValue.buffer
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }

  if (binaryValue?.buffer instanceof ArrayBuffer) {
    const offset = Number(binaryValue.byteOffset || 0)
    const length = Number(binaryValue.byteLength || binaryValue.length || 0)
    return new Uint8Array(binaryValue.buffer, offset, length || undefined)
  }

  if (binaryValue instanceof ArrayBuffer) {
    return new Uint8Array(binaryValue)
  }

  return null
}

function describePersistedUpdate(binaryValue) {
  const update = toUint8Array(binaryValue)
  return {
    valueType: binaryValue?.constructor?.name || typeof binaryValue,
    hasValue: Boolean(binaryValue),
    byteLength: update?.byteLength || 0,
  }
}

function summarizeRecord(record) {
  if (!record) {
    return {
      found: false,
    }
  }
  return {
    found: true,
    docId: record.docId,
    hasContentJson: Boolean(record.content_json),
    plainTextLength: typeof record.plain_text === 'string' ? record.plain_text.length : 0,
    update: describePersistedUpdate(record.ydoc_update),
    updatedAt: record.updatedAt,
  }
}

function buildInitialContent(title) {
  const safeTitle = String(title || '协作文档').trim() || '协作文档'
  return {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: safeTitle }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '这是协作文档的初始内容。现在开始一起编辑吧。',
          },
        ],
      },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '补充项目背景' }],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '整理待办任务' }],
              },
            ],
          },
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '同步成员分工' }],
              },
            ],
          },
        ],
      },
    ],
  }
}

/**
 * plain_text 不是简单地 JSON.stringify(content_json)。
 * 这里递归抽取文本，并在块级节点之间补换行，
 * 目的是让后续 AI Agent 可以直接读取“尽量接近自然阅读”的纯文本快照。
 */
function extractPlainText(node, lines = [], inlineBuffer = []) {
  if (!node || typeof node !== 'object') {
    return { lines, inlineBuffer }
  }

  if (node.type === 'text' && typeof node.text === 'string') {
    inlineBuffer.push(node.text)
  }

  const children = Array.isArray(node.content) ? node.content : []
  for (const child of children) {
    extractPlainText(child, lines, inlineBuffer)
  }

  const blockNodes = new Set([
    'heading',
    'paragraph',
    'blockquote',
    'listItem',
    'codeBlock',
    'tableRow',
  ])

  if (blockNodes.has(node.type)) {
    const line = inlineBuffer.join('').replace(/\s+/g, ' ').trim()
    if (line) {
      lines.push(line)
    }
    inlineBuffer.length = 0
  }

  if (node.type === 'hardBreak') {
    const line = inlineBuffer.join('').trim()
    if (line) {
      lines.push(line)
    }
    inlineBuffer.length = 0
  }

  return { lines, inlineBuffer }
}

function buildPlainText(contentJson) {
  const { lines, inlineBuffer } = extractPlainText(contentJson)
  const tail = inlineBuffer.join('').replace(/\s+/g, ' ').trim()
  if (tail) {
    lines.push(tail)
  }
  return lines.join('\n').trim()
}

function ydocToSnapshots(document) {
  const startedAt = Date.now()
  /**
   * 核心逻辑说明：
   * 1. Y.Doc 里保存的是 CRDT 协同状态，不适合直接给业务方或 AI 使用。
   * 2. 所以每次 onStoreDocument 时，除了保存二进制 update，还要额外导出一份 JSON 快照。
   * 3. plain_text 则是在 JSON 快照基础上提取出的纯文本版本，方便后续 AI 直接消费。
   */
  const contentJson = TiptapTransformer.extensions(snapshotExtensions).fromYdoc(document, TIPTAP_FIELD_NAME)
  const plainText = buildPlainText(contentJson)
  logStep('snapshot.convert.success', {
    elapsed: elapsedMs(startedAt),
    plainTextLength: plainText.length,
    topLevelNodes: Array.isArray(contentJson?.content) ? contentJson.content.length : 0,
  })
  return {
    contentJson,
    plainText,
  }
}

async function loadPersistedDocument(documentName, document) {
  const startedAt = Date.now()
  const docId = normalizeDocumentId(documentName)
  if (!docId) {
    warnStep('load.skip.emptyDocId')
    return
  }

  logStep('mongo.findOne.start', {
    docId,
  })
  const collection = await getCollection()
  const savedRecord = await collection.findOne({ docId })
  logStep('mongo.findOne.done', {
    docId,
    elapsed: elapsedMs(startedAt),
    record: summarizeRecord(savedRecord),
  })

  const persistedUpdate = toUint8Array(savedRecord?.ydoc_update)
  if (persistedUpdate && persistedUpdate.byteLength > 0) {
    /**
     * 这里恢复的是“Y.js 二进制协同状态”。
     * 它包含所有合并后的 CRDT 结果，是进入房间时最权威的数据源。
     */
    try {
      Y.applyUpdate(document, persistedUpdate)
      logStep('ydoc.applyUpdate.success', {
        docId,
        updateBytes: persistedUpdate.byteLength,
        elapsed: elapsedMs(startedAt),
      })
      return
    } catch (error) {
      errorStep('ydoc.applyUpdate.failed', error, {
        docId,
        updateBytes: persistedUpdate.byteLength,
      })
      warnStep('load.fallback.initialContent', {
        docId,
      })
    }
  }

  const initialTitle = savedRecord?.title || '协作文档'
  const initialYDoc = TiptapTransformer.extensions(snapshotExtensions).toYdoc(
    buildInitialContent(initialTitle),
    TIPTAP_FIELD_NAME,
    snapshotExtensions,
  )
  Y.applyUpdate(document, Y.encodeStateAsUpdate(initialYDoc))
  logStep('ydoc.initialContent.applied', {
    docId,
    title: initialTitle,
    elapsed: elapsedMs(startedAt),
  })
}

async function storePersistedDocument(documentName, document) {
  const startedAt = Date.now()
  const docId = normalizeDocumentId(documentName)
  if (!docId) {
    warnStep('store.skip.emptyDocId')
    return
  }

  const collection = await getCollection()

  /**
   * Y.encodeStateAsUpdate 会把“当前完整协同状态”编码成二进制。
   * 这份数据最适合做协同层持久化，因为它保留了 Y.js 所需的结构信息，
   * 下次 onLoadDocument 时可以零损耗恢复回同一个协同世界。
   */
  const binaryState = Buffer.from(Y.encodeStateAsUpdate(document))
  logStep('store.encodeState.done', {
    docId,
    updateBytes: binaryState.byteLength,
  })
  const { contentJson, plainText } = ydocToSnapshots(document)

  logStep('mongo.updateOne.start', {
    docId,
    updateBytes: binaryState.byteLength,
    plainTextLength: plainText.length,
  })
  const result = await collection.updateOne(
    { docId },
    {
      $set: {
        docId,
        ydoc_update: binaryState,
        content_json: contentJson,
        plain_text: plainText,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true },
  )
  logStep('mongo.updateOne.done', {
    docId,
    elapsed: elapsedMs(startedAt),
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    upsertedId: result.upsertedId,
  })
}

const server = new Server({
  port: PORT,
  debounce: 2000,
  maxDebounce: 10000,
  onConnect({ documentName }) {
    logStep('ws.connect', {
      docId: normalizeDocumentId(documentName),
    })
  },
  async onLoadDocument({ documentName, document, requestParameters }) {
    const startedAt = Date.now()
    const safeName = normalizeDocumentId(documentName)
    if (!safeName) {
      warnStep('hook.onLoadDocument.skip.emptyDocId', {
        rawDocumentName: documentName,
      })
      return document
    }

    const titleFromClient = String(requestParameters.get('title') || '').trim()
    logStep('hook.onLoadDocument.start', {
      docId: safeName,
      titleFromClient,
      hasTitleParam: Boolean(titleFromClient),
    })
    if (titleFromClient) {
      document.title = titleFromClient
    }

    try {
      await loadPersistedDocument(safeName, document)
      logStep('hook.onLoadDocument.done', {
        docId: safeName,
        elapsed: elapsedMs(startedAt),
      })
    } catch (error) {
      errorStep('hook.onLoadDocument.failed', error, {
        docId: safeName,
        elapsed: elapsedMs(startedAt),
      })
      throw error
    }
    return document
  },
  async onStoreDocument({ documentName, document, clientsCount }) {
    const startedAt = Date.now()
    const safeName = normalizeDocumentId(documentName)
    if (!safeName) {
      warnStep('hook.onStoreDocument.skip.emptyDocId', {
        rawDocumentName: documentName,
      })
      return
    }

    logStep('hook.onStoreDocument.start', {
      docId: safeName,
      clientsCount,
    })
    try {
      await storePersistedDocument(safeName, document)
      logStep('hook.onStoreDocument.done', {
        docId: safeName,
        clientsCount,
        elapsed: elapsedMs(startedAt),
      })
    } catch (error) {
      errorStep('hook.onStoreDocument.failed', error, {
        docId: safeName,
        clientsCount,
        elapsed: elapsedMs(startedAt),
      })
      throw error
    }
  },
  onDisconnect({ documentName }) {
    logStep('ws.disconnect', {
      docId: normalizeDocumentId(documentName),
    })
  },
})

async function bootstrap() {
  await getCollection()
  logStep('bootstrap.mongo.ready', {
    uri: MONGODB_URI,
    db: MONGODB_DB,
    collection: MONGODB_COLLECTION,
  })
  await server.listen()
  logStep('bootstrap.hocuspocus.ready', {
    http: `http://0.0.0.0:${PORT}`,
    websocket: `ws://127.0.0.1:${PORT}`,
  })
}

bootstrap().catch((error) => {
  errorStep('bootstrap.failed', error)
  process.exitCode = 1
})
