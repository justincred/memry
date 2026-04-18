import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'

export interface CsvImportQueueRow {
  key: string
  rowNumber: number
  url: string
  status: 'imported' | 'duplicate'
  itemId?: string
  existingItemId?: string
}

interface CsvImportQueuePanelProps {
  queueRows: CsvImportQueueRow[]
  selectedKeys: Set<string>
  isImporting: boolean
  onToggleRow: (key: string) => void
  onSelectAll: () => void
  onAcceptSelected: () => void
  onAcceptAll: () => void
  onDiscardSelected: () => void
}

export function CsvImportQueuePanel({
  queueRows,
  selectedKeys,
  isImporting,
  onToggleRow,
  onSelectAll,
  onAcceptSelected,
  onAcceptAll,
  onDiscardSelected
}: CsvImportQueuePanelProps): React.JSX.Element {
  const canAcceptSelected = selectedKeys.size > 0 && !isImporting
  const canAcceptAll = queueRows.length > 0 && !isImporting
  const canDiscardSelected = selectedKeys.size > 0 && !isImporting

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">Import Queue (This Run)</div>
        <div className="text-xs text-muted-foreground">
          {selectedKeys.size} selected / {queueRows.length} total
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onSelectAll}>
          Select all
        </Button>
        <Button size="sm" variant="outline" onClick={onAcceptSelected} disabled={!canAcceptSelected}>
          Accept selected
        </Button>
        <Button size="sm" variant="outline" onClick={onAcceptAll} disabled={!canAcceptAll}>
          Accept all
        </Button>
        <Button size="sm" variant="outline" onClick={onDiscardSelected} disabled={!canDiscardSelected}>
          Discard selected
        </Button>
      </div>

      <div className="mt-3 max-h-48 overflow-auto rounded-md border">
        <div className="divide-y">
          {queueRows.map((row) => (
            <label
              key={row.key}
              className="flex cursor-pointer items-start justify-between gap-3 px-3 py-2"
            >
              <div className="flex min-w-0 items-start gap-2">
                <Checkbox
                  checked={selectedKeys.has(row.key)}
                  onCheckedChange={() => onToggleRow(row.key)}
                  disabled={isImporting}
                />
                <div className="min-w-0">
                  <div className="text-xs text-muted-foreground">Row {row.rowNumber}</div>
                  <div className="truncate text-sm">{row.url}</div>
                </div>
              </div>
              <div className="shrink-0 text-xs text-muted-foreground">
                {row.status === 'imported' ? 'Imported' : 'Duplicate'}
              </div>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}