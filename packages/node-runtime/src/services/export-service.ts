/**
 * Shared export service.
 *
 * Wraps node-runtime's exporters with adapter-based DB opening and provides
 * reusable destinations for Obsidian and Notion.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { exportFilterResultToMarkdown, exportWithFormat, type ExportFilterParams, type ExportResult } from '../export'
import type { ExportFormat, FormatExportResult } from '../export'
import type { SessionRuntimeAdapter } from './adapters'

const NOTION_API_URL = 'https://api.notion.com/v1/pages'
const DEFAULT_NOTION_VERSION = '2026-03-11'
const NOTION_MAX_REQUEST_BYTES = 500 * 1024

export interface SessionExportParams {
  sessionId: string
  sessionName: string
  timeFilter?: { startTs: number; endTs: number }
}

export interface ObsidianExportOptions {
  /** Absolute path to the Obsidian vault. */
  vaultPath: string
  /** Optional folder inside the vault, for example `ChatLab/Exports`. */
  folder?: string
  /** Optional filename. `.md` is appended when omitted. */
  filename?: string
}

export interface ObsidianExportResult extends FormatExportResult {
  filePath?: string
}

export interface NotionExportOptions {
  /** Notion integration token. It is used only for this request and is never logged. */
  token: string
  /** Existing Notion page under which the exported page will be created. */
  parentPageId: string
  /** Override the generated page title. */
  title?: string
  /** Override only when intentionally pinning a different Notion API version. */
  notionVersion?: string
}

export interface NotionExportResult extends FormatExportResult {
  pageId?: string
  url?: string
}

interface NotionPageResponse {
  id?: string
  url?: string
  message?: string
  code?: string
}

function sanitizeFilename(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  return sanitized || 'chatlab-export'
}

function ensureMarkdownFilename(value: string): string {
  const safe = sanitizeFilename(value)
  return safe.toLowerCase().endsWith('.md') ? safe : `${safe}.md`
}

function resolveVaultFolder(vaultPath: string, folder?: string): string {
  const vault = resolve(vaultPath)
  const target = resolve(vault, folder || '.')
  const rel = relative(vault, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Obsidian export folder must stay inside the selected vault')
  }
  return target
}

function failedResult(error: unknown): FormatExportResult {
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
    totalMessages: 0,
    content: '',
    filename: '',
    mimeType: '',
  }
}

export function exportMarkdown(
  adapter: SessionRuntimeAdapter,
  params: ExportFilterParams
): { result: ExportResult; content: string } {
  const chunks: string[] = []
  const result = exportFilterResultToMarkdown(
    params,
    {
      openDatabase(sessionId: string) {
        return adapter.openReadonly(sessionId)
      },
    },
    {
      write(chunk: string) {
        chunks.push(chunk)
      },
      end() {
        /* collected in chunks array */
      },
    }
  )
  return { result, content: chunks.join('') }
}

export function exportFormatted(
  adapter: SessionRuntimeAdapter,
  params: SessionExportParams & { format: ExportFormat }
): FormatExportResult {
  return exportWithFormat(params, (sessionId) => adapter.openReadonly(sessionId))
}

/**
 * Export a ChatLab session as an Obsidian-compatible Markdown note.
 *
 * The optional folder is constrained to the selected vault to avoid accidental
 * writes outside it.
 */
export function exportToObsidian(
  adapter: SessionRuntimeAdapter,
  params: SessionExportParams,
  options: ObsidianExportOptions
): ObsidianExportResult {
  try {
    const generated = exportFormatted(adapter, { ...params, format: 'markdown' })
    if (!generated.success) return generated

    const folder = resolveVaultFolder(options.vaultPath, options.folder)
    mkdirSync(folder, { recursive: true })

    const defaultName = `${sanitizeFilename(params.sessionName)}_${Date.now()}.md`
    const filename = ensureMarkdownFilename(options.filename || defaultName)
    const filePath = resolve(folder, filename)
    writeFileSync(filePath, generated.content, 'utf8')

    return { ...generated, filename, filePath }
  } catch (error) {
    return failedResult(error)
  }
}

/**
 * Export a ChatLab session to a child page in Notion.
 *
 * The token is deliberately accepted per-call and is never persisted or logged
 * by this service. Callers may choose their own secure credential store.
 */
export async function exportToNotion(
  adapter: SessionRuntimeAdapter,
  params: SessionExportParams,
  options: NotionExportOptions
): Promise<NotionExportResult> {
  try {
    const generated = exportFormatted(adapter, { ...params, format: 'markdown' })
    if (!generated.success) return generated

    if (!options.token.trim()) throw new Error('Notion integration token is required')
    if (!options.parentPageId.trim()) throw new Error('Notion parent page ID is required')

    const title = (options.title || params.sessionName || 'ChatLab Export').trim()
    const payload = {
      parent: { page_id: options.parentPageId.trim() },
      properties: {
        title: {
          type: 'title',
          title: [{ type: 'text', text: { content: title.slice(0, 2000) } }],
        },
      },
      markdown: generated.content,
    }
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body, 'utf8') > NOTION_MAX_REQUEST_BYTES) {
      throw new Error('Notion export is larger than the 500 KB request limit; export a smaller time range')
    }

    const response = await fetch(NOTION_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token.trim()}`,
        'Content-Type': 'application/json',
        'Notion-Version': options.notionVersion || DEFAULT_NOTION_VERSION,
      },
      body,
    })

    let data: NotionPageResponse = {}
    try {
      data = (await response.json()) as NotionPageResponse
    } catch {
      // Keep the HTTP status as the useful fallback error below.
    }

    if (!response.ok || !data.id) {
      const detail = data.message || data.code || `${response.status} ${response.statusText}`
      throw new Error(`Notion export failed: ${detail}`)
    }

    return {
      ...generated,
      filename: '',
      mimeType: 'application/json',
      pageId: data.id,
      url: data.url,
    }
  } catch (error) {
    return failedResult(error)
  }
}
