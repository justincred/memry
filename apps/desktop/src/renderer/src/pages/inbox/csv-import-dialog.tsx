import { useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { AlertCircle, Check, Loader2, Upload } from '@/lib/icons'
import { parseCsvImport, parseCsvText } from '@/lib/csv-import'
import { inboxService } from '@/services/inbox-service'
import { inboxKeys } from '@/hooks/use-inbox'
import { CsvImportQueuePanel, type CsvImportQueueRow } from './csv-import-queue-panel'

const IMPORT_CHUNK_SIZE = 100
const PREVIEW_ROWS = 10

interface CsvImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ImportProgress {
  processed: number
  total: number
}

interface ImportSummary {
  imported: number
  duplicate: number
  invalid: number
  failed: number
}

interface FailedImportRow {
  rowNumber: number
  url: string
  originalValue?: string
}

export function CsvImportDialog({ open, onOpenChange }: CsvImportDialogProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [fileName, setFileName] = useState<string>('')
  const [csvText, setCsvText] = useState<string>('')
  const [selectedColumnMode, setSelectedColumnMode] = useState<string>('auto')
  const [hasHeader, setHasHeader] = useState<boolean>(false)
  const [isImporting, setIsImporting] = useState<boolean>(false)
  const [progress, setProgress] = useState<ImportProgress>({ processed: 0, total: 0 })
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [failedRows, setFailedRows] = useState<FailedImportRow[]>([])
  const [queueRows, setQueueRows] = useState<CsvImportQueueRow[]>([])
  const [selectedQueueKeys, setSelectedQueueKeys] = useState<Set<string>>(new Set())

  const rawRows = useMemo(() => parseCsvText(csvText), [csvText])
  const maxColumns = useMemo(
    () => rawRows.reduce((max, row) => Math.max(max, row.length), 0),
    [rawRows]
  )

  const autoParsed = useMemo(() => parseCsvImport(csvText), [csvText])
  const selectedColumnIndex = useMemo(() => {
    if (selectedColumnMode === 'auto') {
      return autoParsed.urlColumnIndex
    }
    const parsed = Number.parseInt(selectedColumnMode, 10)
    return Number.isNaN(parsed) ? null : parsed
  }, [selectedColumnMode, autoParsed.urlColumnIndex])

  const parsed = useMemo(
    () =>
      parseCsvImport(csvText, {
        urlColumnIndex: selectedColumnIndex,
        hasHeader
      }),
    [csvText, selectedColumnIndex, hasHeader]
  )

  const validRows = useMemo(
    () => parsed.rows.filter((row) => row.isValidUrl && row.normalizedUrl !== null),
    [parsed.rows]
  )

  const invalidRows = useMemo(() => parsed.rows.filter((row) => !row.isValidUrl), [parsed.rows])

  const handleReset = (): void => {
    setFileName('')
    setCsvText('')
    setSelectedColumnMode('auto')
    setHasHeader(false)
    setSummary(null)
    setFailedRows([])
    setQueueRows([])
    setSelectedQueueKeys(new Set())
    setProgress({ processed: 0, total: 0 })
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && !isImporting) {
      handleReset()
    }
    onOpenChange(nextOpen)
  }

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      setFileName(file.name)
      setCsvText(text)
      const detected = parseCsvImport(text)
      setHasHeader(detected.headers !== null)
      setSelectedColumnMode('auto')
      setSummary(null)
      setFailedRows([])
      setQueueRows([])
      setSelectedQueueKeys(new Set())
      setProgress({ processed: 0, total: 0 })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to read CSV file')
    } finally {
      event.target.value = ''
    }
  }

  const handleImport = async (): Promise<void> => {
    if (isImporting || validRows.length === 0) return

    await runImport(
      validRows.map((row) => ({
        rowNumber: row.rowNumber,
        url: row.normalizedUrl!,
        originalValue: row.rawUrl
      })),
      invalidRows.length,
      'replace'
    )
  }

  const runImport = async (
    rowsToImport: FailedImportRow[],
    invalidCount: number,
    queueMode: 'replace' | 'append'
  ): Promise<void> => {
    if (rowsToImport.length === 0) return

    const totalRows = rowsToImport.length + invalidCount
    const aggregate: ImportSummary = {
      imported: 0,
      duplicate: 0,
      invalid: invalidCount,
      failed: 0
    }
    const nextFailedRows: FailedImportRow[] = []
    const nextQueueRows: CsvImportQueueRow[] = []

    setIsImporting(true)
    setSummary(null)
    setFailedRows([])
    if (queueMode === 'replace') {
      setQueueRows([])
      setSelectedQueueKeys(new Set())
    }
    setProgress({ processed: invalidCount, total: totalRows })

    try {
      for (let i = 0; i < rowsToImport.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = rowsToImport.slice(i, i + IMPORT_CHUNK_SIZE)
        const chunkByRowNumber = new Map(chunk.map((row) => [row.rowNumber, row]))

        const response = await inboxService.bulkImportLinks({
          rows: chunk.map((row) => ({
            rowNumber: row.rowNumber,
            url: row.url,
            originalValue: row.originalValue
          })),
          options: { source: 'api' }
        })

        aggregate.imported += response.totals.imported
        aggregate.duplicate += response.totals.duplicate
        aggregate.failed += response.totals.failed

        for (const result of response.results) {
          const original = chunkByRowNumber.get(result.rowNumber)
          if (!original) continue

          if (result.status === 'failed') {
            nextFailedRows.push(original)
            continue
          }

          if (result.status === 'imported' && result.itemId) {
            nextQueueRows.push({
              key: `imported:${result.itemId}`,
              rowNumber: result.rowNumber,
              url: result.url,
              status: 'imported',
              itemId: result.itemId
            })
            continue
          }

          if (result.status === 'duplicate' && result.existingItemId) {
            nextQueueRows.push({
              key: `duplicate:${result.existingItemId}:${result.rowNumber}`,
              rowNumber: result.rowNumber,
              url: result.url,
              status: 'duplicate',
              existingItemId: result.existingItemId
            })
          }
        }

        setProgress({
          processed: invalidCount + Math.min(i + chunk.length, rowsToImport.length),
          total: totalRows
        })
      }

      setSummary(aggregate)
      setFailedRows(nextFailedRows)
      setQueueRows((prev) => {
        if (queueMode === 'replace') return nextQueueRows
        const map = new Map<string, CsvImportQueueRow>()
        for (const row of prev) map.set(row.key, row)
        for (const row of nextQueueRows) map.set(row.key, row)
        return Array.from(map.values())
      })
      await queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      await queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })

      toast.success(`CSV import completed: ${aggregate.imported} imported`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'CSV import failed')
    } finally {
      setIsImporting(false)
    }
  }

  const handleRetryFailed = async (): Promise<void> => {
    if (isImporting || failedRows.length === 0) return
    await runImport(failedRows, 0, 'append')
  }

  const handleToggleQueueRow = (key: string): void => {
    setSelectedQueueKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleSelectAllQueueRows = (): void => {
    setSelectedQueueKeys(new Set(queueRows.map((row) => row.key)))
  }

  const handleAcceptSelected = (): void => {
    if (selectedQueueKeys.size === 0) return
    setQueueRows((prev) => prev.filter((row) => !selectedQueueKeys.has(row.key)))
    setSelectedQueueKeys(new Set())
    toast.success('Accepted selected import items')
  }

  const handleAcceptAll = (): void => {
    if (queueRows.length === 0) return
    setQueueRows([])
    setSelectedQueueKeys(new Set())
    toast.success('Accepted all import items')
  }

  const handleDiscardSelected = async (): Promise<void> => {
    if (selectedQueueKeys.size === 0 || isImporting) return

    const selectedRows = queueRows.filter((row) => selectedQueueKeys.has(row.key))
    const importedItemIds = selectedRows
      .filter((row) => row.status === 'imported' && row.itemId)
      .map((row) => row.itemId as string)

    if (importedItemIds.length === 0) {
      toast.info('Only imported items can be discarded')
      return
    }

    try {
      await inboxService.bulkArchive({ itemIds: importedItemIds })
      setQueueRows((prev) => prev.filter((row) => !selectedQueueKeys.has(row.key)))
      setSelectedQueueKeys(new Set())
      await queryClient.invalidateQueries({ queryKey: inboxKeys.lists() })
      await queryClient.invalidateQueries({ queryKey: inboxKeys.stats() })
      toast.success(`Discarded ${importedItemIds.length} item${importedItemIds.length > 1 ? 's' : ''}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to discard selected items')
    }
  }

  const handleExportFailed = (): void => {
    if (failedRows.length === 0) return

    const escapeCell = (value: string): string => `"${value.replace(/"/g, '""')}"`
    const lines = ['rowNumber,url,originalValue']
    for (const row of failedRows) {
      lines.push(
        [String(row.rowNumber), escapeCell(row.url), escapeCell(row.originalValue ?? '')].join(',')
      )
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'csv-import-failed-rows.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const canImport = csvText.length > 0 && validRows.length > 0 && !isImporting
  const canRetryFailed = failedRows.length > 0 && !isImporting
  const previewRows = parsed.rows.slice(0, PREVIEW_ROWS)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import CSV Links</DialogTitle>
          <DialogDescription>
            Upload a CSV file, verify URL mapping, and import links into the import queue flow.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleFileSelect}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
            >
              <Upload className="mr-2 h-4 w-4" />
              Choose CSV
            </Button>
            <span className="text-sm text-muted-foreground">{fileName || 'No file selected'}</span>
          </div>

          {csvText && (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>URL Column</Label>
                  <Select
                    value={selectedColumnMode}
                    onValueChange={setSelectedColumnMode}
                    disabled={isImporting || maxColumns === 0}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose URL column" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Auto detect</SelectItem>
                      {Array.from({ length: maxColumns }).map((_, index) => {
                        const header = rawRows[0]?.[index]?.trim()
                        const label = header ? `${header} (column ${index + 1})` : `Column ${index + 1}`
                        return (
                          <SelectItem key={index} value={String(index)}>
                            {label}
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Checkbox
                      checked={hasHeader}
                      onCheckedChange={(checked) => setHasHeader(Boolean(checked))}
                      disabled={isImporting || rawRows.length === 0}
                    />
                    First row is a header
                  </label>
                </div>
              </div>

              <div className="rounded-md border p-3 text-sm">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div>
                    <div className="text-muted-foreground">Rows</div>
                    <div className="font-medium">{parsed.rows.length}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Valid</div>
                    <div className="font-medium text-emerald-600">{validRows.length}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Invalid</div>
                    <div className="font-medium text-amber-600">{invalidRows.length}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">URL column</div>
                    <div className="font-medium">
                      {parsed.urlColumnIndex === null ? 'Not detected' : parsed.urlColumnIndex + 1}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-md border">
                <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Preview
                </div>
                <div className="max-h-56 overflow-auto">
                  {previewRows.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-muted-foreground">No rows available.</div>
                  ) : (
                    <div className="divide-y">
                      {previewRows.map((row) => (
                        <div key={row.rowNumber} className="flex items-start justify-between gap-3 px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-xs text-muted-foreground">Row {row.rowNumber}</div>
                            <div className="truncate text-sm">{row.rawUrl || '(empty)'}</div>
                          </div>
                          <div className="shrink-0">
                            {row.isValidUrl ? (
                              <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                                <Check className="h-3.5 w-3.5" /> Valid
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                                <AlertCircle className="h-3.5 w-3.5" /> {row.error}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {isImporting && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span>Import progress</span>
                    <span className="text-muted-foreground">
                      {progress.processed} / {progress.total}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-foreground transition-[width] duration-200"
                      style={{
                        width:
                          progress.total > 0
                            ? `${Math.min(100, (progress.processed / progress.total) * 100)}%`
                            : '0%'
                      }}
                    />
                  </div>
                </div>
              )}

              {summary && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                  <div className="font-medium">Import summary</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                    <div>Imported: {summary.imported}</div>
                    <div>Duplicate: {summary.duplicate}</div>
                    <div>Invalid: {summary.invalid}</div>
                    <div>Failed: {summary.failed}</div>
                  </div>
                  {failedRows.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => void handleRetryFailed()}>
                        Retry failed ({failedRows.length})
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleExportFailed}>
                        Export failed CSV
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {queueRows.length > 0 && (
                <CsvImportQueuePanel
                  queueRows={queueRows}
                  selectedKeys={selectedQueueKeys}
                  isImporting={isImporting}
                  onToggleRow={handleToggleQueueRow}
                  onSelectAll={handleSelectAllQueueRows}
                  onAcceptSelected={handleAcceptSelected}
                  onAcceptAll={handleAcceptAll}
                  onDiscardSelected={() => void handleDiscardSelected()}
                />
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isImporting}>
            Close
          </Button>
          <Button variant="outline" onClick={() => void handleRetryFailed()} disabled={!canRetryFailed}>
            Retry failed
          </Button>
          <Button onClick={() => void handleImport()} disabled={!canImport}>
            {isImporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Importing...
              </>
            ) : (
              `Import ${validRows.length > 0 ? validRows.length : ''}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
