import { describe, it, expect, vi } from 'vitest'
import {
  createInboxBatchHandlers,
  type InboxBatchHandlerDeps
} from './inbox-batch-handlers'

describe('inbox-batch-handlers', () => {
  it('imports normalized links and reports duplicate/invalid/failed rows', async () => {
    const captureLink = vi.fn<InboxBatchHandlerDeps['captureLink']>(async ({ url }) => {
      if (url.includes('duplicate.com')) {
        return {
          success: true,
          item: null,
          duplicate: true,
          existingItem: {
            id: 'existing-1',
            title: 'Existing',
            createdAt: new Date().toISOString()
          }
        }
      }

      if (url.includes('failed.com')) {
        return { success: false, item: null, error: 'Capture failed' }
      }

      return {
        success: true,
        item: {
          id: 'new-item-1'
        } as never
      }
    })

    const handlers = createInboxBatchHandlers({
      requireDatabase: vi.fn() as never,
      emitInboxEvent: vi.fn(),
      archiveItem: vi.fn(),
      captureLink
    })

    const result = await handlers.handleBulkImportLinks({
      rows: [
        { rowNumber: 2, url: 'example.com' },
        { rowNumber: 3, url: 'https://duplicate.com/a' },
        { rowNumber: 4, url: 'bad input' },
        { rowNumber: 5, url: 'https://failed.com/a' }
      ]
    })

    expect(result.success).toBe(false)
    expect(result.totals).toEqual({
      processed: 4,
      imported: 1,
      duplicate: 1,
      invalid: 1,
      failed: 1
    })

    expect(result.results).toEqual([
      {
        rowNumber: 2,
        url: 'https://example.com/',
        status: 'imported',
        itemId: 'new-item-1'
      },
      {
        rowNumber: 3,
        url: 'https://duplicate.com/a',
        status: 'duplicate',
        existingItemId: 'existing-1'
      },
      {
        rowNumber: 4,
        url: 'bad input',
        status: 'invalid',
        error: 'Invalid URL'
      },
      {
        rowNumber: 5,
        url: 'https://failed.com/a',
        status: 'failed',
        error: 'Capture failed'
      }
    ])
  })

  it('passes source and force options into capture link', async () => {
    const captureLink = vi.fn<InboxBatchHandlerDeps['captureLink']>(async () => ({
      success: true,
      item: { id: 'item-1' } as never
    }))

    const handlers = createInboxBatchHandlers({
      requireDatabase: vi.fn() as never,
      emitInboxEvent: vi.fn(),
      archiveItem: vi.fn(),
      captureLink
    })

    await handlers.handleBulkImportLinks({
      rows: [{ rowNumber: 1, url: 'example.com', tags: ['one'] }],
      options: { source: 'quick-capture', force: true }
    })

    expect(captureLink).toHaveBeenCalledWith({
      url: 'https://example.com/',
      tags: ['one'],
      source: 'quick-capture',
      force: true
    })
  })
})
