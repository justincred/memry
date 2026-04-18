import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders, getMockApi } from '@tests/utils/render'
import { CsvImportDialog } from './csv-import-dialog'

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn()
}))

vi.mock('sonner', () => ({
  toast
}))

describe('CsvImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    const api = getMockApi()
    api.inbox.bulkImportLinks = vi.fn().mockImplementation(async ({ rows }) => {
      return {
        success: true,
        totals: {
          processed: rows.length,
          imported: rows.length > 0 ? 1 : 0,
          duplicate: rows.length > 1 ? 1 : 0,
          invalid: 0,
          failed: 0
        },
        results: rows.flatMap((row, index) => {
          if (index === 0) {
            return [{ rowNumber: row.rowNumber, url: row.url, status: 'imported', itemId: 'item-1' }]
          }
          return [
            {
              rowNumber: row.rowNumber,
              url: row.url,
              status: 'duplicate',
              existingItemId: 'existing-1'
            }
          ]
        })
      }
    })
    api.inbox.bulkArchive = vi.fn().mockResolvedValue({ success: true })
    api.inbox.list = vi.fn().mockResolvedValue({ items: [], total: 0 })
    api.inbox.getStats = vi.fn().mockResolvedValue({})

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:csv-import-failed')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  it('imports a CSV and exposes run-scoped queue actions', async () => {
    const user = userEvent.setup()

    renderWithProviders(<CsvImportDialog open={true} onOpenChange={vi.fn()} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csvFile = new File(
      ['title,link\nFirst,example.com\nSecond,https://duplicate.com\nThird,bad input'],
      'links.csv',
      { type: 'text/csv' }
    )

    Object.defineProperty(fileInput, 'files', {
      value: [csvFile]
    })
    fireEvent.change(fileInput)

    await waitFor(() => {
      expect(screen.getByText('links.csv')).toBeInTheDocument()
    })

    expect(screen.getByText('URL Column')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Import 2$/i }))

    await waitFor(() => {
      expect(screen.getByText('Import Queue (This Run)')).toBeInTheDocument()
    })

    expect(screen.getByText('Row 2')).toBeInTheDocument()
    expect(screen.getByText('Row 3')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /select all/i }))
    await user.click(screen.getByRole('button', { name: /accept selected/i }))

    expect(screen.queryByText('Import Queue (This Run)')).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Accepted selected import items')
  })

  it('discards selected imported rows through bulk archive', async () => {
    const user = userEvent.setup()

    renderWithProviders(<CsvImportDialog open={true} onOpenChange={vi.fn()} />)

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const csvFile = new File(
      ['title,link\nFirst,example.com\nSecond,https://duplicate.com'],
      'links.csv',
      { type: 'text/csv' }
    )

    Object.defineProperty(fileInput, 'files', {
      value: [csvFile]
    })
    fireEvent.change(fileInput)
    await waitFor(() => {
      expect(screen.getByText('links.csv')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /^Import 2$/i }))

    await waitFor(() => {
      expect(screen.getByText('Import Queue (This Run)')).toBeInTheDocument()
    })

    const queue = screen.getByText('Import Queue (This Run)').closest('div')
    expect(queue).not.toBeNull()

    const firstRow = screen.getByText('example.com').closest('label')
    expect(firstRow).not.toBeNull()
    await user.click(within(firstRow as HTMLElement).getByRole('checkbox'))

    await user.click(screen.getByRole('button', { name: /discard selected/i }))

    const api = getMockApi()
    expect(api.inbox.bulkArchive).toHaveBeenCalledWith({ itemIds: ['item-1'] })
    expect(toast.success).toHaveBeenCalledWith('Discarded 1 item')
  })
})