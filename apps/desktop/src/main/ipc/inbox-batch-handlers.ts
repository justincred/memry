import { ipcMain } from 'electron'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  BulkArchiveSchema,
  BulkFileSchema,
  BulkImportLinksSchema,
  BulkTagSchema,
  type BulkImportLinksResponse,
  type BulkResponse,
  type CaptureResponse
} from '@memry/contracts/inbox-api'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { eq, and } from 'drizzle-orm'
import { generateId } from '../lib/id'
import { bulkFileToFolder } from '../inbox/filing'
import { bulkSnoozeItems } from '../inbox/snooze'
import { getStaleItemIds, incrementProcessedCount } from '../inbox/stats'
import type { DrizzleDb } from '../database'

export interface InboxBatchHandlerDeps {
  requireDatabase: () => DrizzleDb
  emitInboxEvent: (channel: string, data: unknown) => void
  archiveItem: (itemId: string) => Promise<{ success: boolean; error?: string }>
  captureLink: (input: {
    url: string
    tags?: string[]
    force?: boolean
    source?: 'quick-capture' | 'inline' | 'browser-extension' | 'api' | 'reminder'
  }) => Promise<CaptureResponse>
}

export interface InboxBatchHandlers {
  handleBulkArchive: (input: unknown) => Promise<BulkResponse>
  handleBulkSnooze: (input: unknown) => Promise<{
    success: boolean
    processedCount: number
    errors: Array<{ itemId: string; error: string }>
  }>
  handleBulkFile: (input: unknown) => Promise<BulkResponse>
  handleBulkImportLinks: (input: unknown) => Promise<BulkImportLinksResponse>
  handleBulkTag: (input: unknown) => Promise<BulkResponse>
  handleFileAllStale: () => Promise<BulkResponse>
}

function normalizeImportUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  let candidate = trimmed
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`
  }

  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }

    const host = parsed.hostname
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    const isLikelyHostname = host.includes('.') || host === 'localhost' || isIpv4
    if (!host || !isLikelyHostname) {
      return null
    }

    return parsed.toString()
  } catch {
    return null
  }
}

export function createInboxBatchHandlers(deps: InboxBatchHandlerDeps): InboxBatchHandlers {
  async function handleBulkArchive(input: unknown): Promise<BulkResponse> {
    const parsed = BulkArchiveSchema.parse(input)
    const errors: Array<{ itemId: string; error: string }> = []
    let processedCount = 0

    for (const itemId of parsed.itemIds) {
      const result = await deps.archiveItem(itemId)
      if (result.success) {
        processedCount++
      } else {
        errors.push({ itemId, error: result.error || 'Unknown error' })
      }
    }

    return {
      success: errors.length === 0,
      processedCount,
      errors
    }
  }

  async function handleBulkSnooze(input: unknown): Promise<{
    success: boolean
    processedCount: number
    errors: Array<{ itemId: string; error: string }>
  }> {
    try {
      if (!input || typeof input !== 'object') {
        return {
          success: false,
          processedCount: 0,
          errors: [{ itemId: '', error: 'Invalid input' }]
        }
      }

      const { itemIds, snoozeUntil, reason } = input as {
        itemIds: string[]
        snoozeUntil: string
        reason?: string
      }

      if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
        return {
          success: false,
          processedCount: 0,
          errors: [{ itemId: '', error: 'itemIds array is required' }]
        }
      }

      if (!snoozeUntil) {
        return {
          success: false,
          processedCount: 0,
          errors: [{ itemId: '', error: 'snoozeUntil is required' }]
        }
      }

      return bulkSnoozeItems(itemIds, snoozeUntil, reason)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, processedCount: 0, errors: [{ itemId: '', error: message }] }
    }
  }

  async function handleBulkFile(input: unknown): Promise<BulkResponse> {
    try {
      const parsed = BulkFileSchema.parse(input)
      const { itemIds, destination, tags } = parsed

      if (destination.type !== 'folder') {
        return {
          success: false,
          processedCount: 0,
          errors: [{ itemId: '', error: 'Bulk filing only supports folder destination' }]
        }
      }

      return bulkFileToFolder(itemIds, destination.path || '', tags)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: message }]
      }
    }
  }

  async function handleBulkImportLinks(input: unknown): Promise<BulkImportLinksResponse> {
    const parsed = BulkImportLinksSchema.parse(input)
    const totals = {
      processed: 0,
      imported: 0,
      duplicate: 0,
      invalid: 0,
      failed: 0
    }

    const results: BulkImportLinksResponse['results'] = []

    for (const row of parsed.rows) {
      totals.processed++
      const normalizedUrl = normalizeImportUrl(row.url)

      if (!normalizedUrl) {
        totals.invalid++
        results.push({
          rowNumber: row.rowNumber,
          url: row.url,
          status: 'invalid',
          error: 'Invalid URL'
        })
        continue
      }

      try {
        const capture = await deps.captureLink({
          url: normalizedUrl,
          tags: row.tags,
          force: parsed.options?.force,
          source: parsed.options?.source ?? 'api'
        })

        if (capture.success && capture.duplicate) {
          totals.duplicate++
          results.push({
            rowNumber: row.rowNumber,
            url: normalizedUrl,
            status: 'duplicate',
            existingItemId: capture.existingItem?.id
          })
          continue
        }

        if (capture.success && capture.item) {
          totals.imported++
          results.push({
            rowNumber: row.rowNumber,
            url: normalizedUrl,
            status: 'imported',
            itemId: capture.item.id
          })
          continue
        }

        totals.failed++
        results.push({
          rowNumber: row.rowNumber,
          url: normalizedUrl,
          status: 'failed',
          error: capture.error || 'Import failed'
        })
      } catch (error) {
        totals.failed++
        results.push({
          rowNumber: row.rowNumber,
          url: normalizedUrl,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Import failed'
        })
      }
    }

    return {
      success: totals.failed === 0,
      totals,
      results
    }
  }

  async function handleBulkTag(input: unknown): Promise<BulkResponse> {
    try {
      const parsed = BulkTagSchema.parse(input)
      const { itemIds, tags } = parsed
      const db = deps.requireDatabase()

      let processedCount = 0
      const errors: Array<{ itemId: string; error: string }> = []

      for (const itemId of itemIds) {
        try {
          const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
          if (!item) {
            errors.push({ itemId, error: 'Item not found' })
            continue
          }

          for (const tag of tags) {
            const normalizedTag = tag.trim().toLowerCase()
            if (!normalizedTag) continue

            const existing = db
              .select()
              .from(inboxItemTags)
              .where(and(eq(inboxItemTags.itemId, itemId), eq(inboxItemTags.tag, normalizedTag)))
              .get()

            if (!existing) {
              db.insert(inboxItemTags)
                .values({
                  id: generateId(),
                  itemId,
                  tag: normalizedTag
                })
                .run()
            }
          }
          processedCount++
        } catch (error) {
          errors.push({
            itemId,
            error: error instanceof Error ? error.message : 'Unknown error'
          })
        }
      }

      for (const itemId of itemIds) {
        deps.emitInboxEvent(InboxChannels.events.UPDATED, { id: itemId, changes: { tags } })
      }

      return {
        success: errors.length === 0,
        processedCount,
        errors
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: message }]
      }
    }
  }

  async function handleFileAllStale(): Promise<BulkResponse> {
    try {
      const staleIds = getStaleItemIds()

      if (staleIds.length === 0) {
        return {
          success: true,
          processedCount: 0,
          errors: []
        }
      }

      const result = await bulkFileToFolder(staleIds, 'Unsorted', [])

      if (result.processedCount > 0) {
        incrementProcessedCount(result.processedCount)
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: message }]
      }
    }
  }

  return {
    handleBulkArchive,
    handleBulkSnooze,
    handleBulkFile,
    handleBulkImportLinks,
    handleBulkTag,
    handleFileAllStale
  }
}

export function registerInboxBatchHandlers(handlers: InboxBatchHandlers): void {
  ipcMain.handle(InboxChannels.invoke.BULK_SNOOZE, (_, input) => handlers.handleBulkSnooze(input))
  ipcMain.handle(InboxChannels.invoke.BULK_FILE, (_, input) => handlers.handleBulkFile(input))
  ipcMain.handle(InboxChannels.invoke.BULK_IMPORT_LINKS, (_, input) =>
    handlers.handleBulkImportLinks(input)
  )
  ipcMain.handle(InboxChannels.invoke.BULK_ARCHIVE, (_, input) => handlers.handleBulkArchive(input))
  ipcMain.handle(InboxChannels.invoke.BULK_TAG, (_, input) => handlers.handleBulkTag(input))
  ipcMain.handle(InboxChannels.invoke.FILE_ALL_STALE, () => handlers.handleFileAllStale())
}

export function unregisterInboxBatchHandlers(): void {
  ipcMain.removeHandler(InboxChannels.invoke.BULK_SNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_FILE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_IMPORT_LINKS)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_ARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.FILE_ALL_STALE)
}
