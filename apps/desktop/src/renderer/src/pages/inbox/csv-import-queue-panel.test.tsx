import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CsvImportQueuePanel, type CsvImportQueueRow } from './csv-import-queue-panel'

describe('CsvImportQueuePanel', () => {
  const queueRows: CsvImportQueueRow[] = [
    {
      key: 'imported:item-1',
      rowNumber: 2,
      url: 'https://example.com/',
      status: 'imported',
      itemId: 'item-1'
    },
    {
      key: 'duplicate:existing-1:3',
      rowNumber: 3,
      url: 'https://duplicate.com/',
      status: 'duplicate',
      existingItemId: 'existing-1'
    }
  ]

  it('renders queue rows and supports selection actions', async () => {
    const user = userEvent.setup()
    const onToggleRow = vi.fn()
    const onSelectAll = vi.fn()
    const onAcceptSelected = vi.fn()
    const onAcceptAll = vi.fn()
    const onDiscardSelected = vi.fn()

    render(
      <CsvImportQueuePanel
        queueRows={queueRows}
        selectedKeys={new Set(['imported:item-1'])}
        isImporting={false}
        onToggleRow={onToggleRow}
        onSelectAll={onSelectAll}
        onAcceptSelected={onAcceptSelected}
        onAcceptAll={onAcceptAll}
        onDiscardSelected={onDiscardSelected}
      />
    )

    expect(screen.getByText('Import Queue (This Run)')).toBeInTheDocument()
    expect(screen.getByText('Row 2')).toBeInTheDocument()
    expect(screen.getByText('Row 3')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /select all/i }))
    await user.click(screen.getByRole('button', { name: /accept selected/i }))
    await user.click(screen.getByRole('button', { name: /accept all/i }))
    await user.click(screen.getByRole('button', { name: /discard selected/i }))

    expect(onSelectAll).toHaveBeenCalledTimes(1)
    expect(onAcceptSelected).toHaveBeenCalledTimes(1)
    expect(onAcceptAll).toHaveBeenCalledTimes(1)
    expect(onDiscardSelected).toHaveBeenCalledTimes(1)

    await user.click(screen.getAllByRole('checkbox')[0])
    expect(onToggleRow).toHaveBeenCalledWith('imported:item-1')
  })
})