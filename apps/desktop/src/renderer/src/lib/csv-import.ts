export type UrlDetectionReason = 'header-alias' | 'url-score' | 'none'

export interface UrlColumnDetection {
  index: number | null
  hasHeader: boolean
  reason: UrlDetectionReason
}

export interface ParsedImportRow {
  rowNumber: number
  cells: string[]
  rawUrl: string
  normalizedUrl: string | null
  isValidUrl: boolean
  error?: 'missing-url' | 'invalid-url'
}

export interface ParsedCsvImport {
  headers: string[] | null
  urlColumnIndex: number | null
  rows: ParsedImportRow[]
}

export interface ParseCsvImportOptions {
  urlColumnIndex?: number | null
  hasHeader?: boolean
}

const URL_HEADER_ALIASES = new Set(['url', 'link', 'source', 'website'])

function isLikelyWebHost(hostname: string): boolean {
  if (hostname === 'localhost') return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true
  return hostname.includes('.')
}

function isEmptyRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === '')
}

export function parseCsvText(csvText: string): string[][] {
  if (!csvText) return []

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i]
    const next = csvText[i + 1]

    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }

    if (char === ',') {
      row.push(field)
      field = ''
      continue
    }

    if (char === '\n' || char === '\r') {
      row.push(field)
      field = ''

      if (rows.length === 0 && row.length > 0) {
        row[0] = row[0].replace(/^\uFEFF/, '')
      }

      if (!isEmptyRow(row)) {
        rows.push(row)
      }
      row = []

      if (char === '\r' && next === '\n') {
        i++
      }
      continue
    }

    field += char
  }

  row.push(field)
  if (rows.length === 0 && row.length > 0) {
    row[0] = row[0].replace(/^\uFEFF/, '')
  }

  if (!isEmptyRow(row)) {
    rows.push(row)
  }

  return rows
}

export function normalizeImportUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  let candidate = trimmed
  if (candidate.startsWith('//')) {
    candidate = `https:${candidate}`
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    // Treat plain host/path as web URL for import convenience.
    candidate = `https://${candidate}`
  }

  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }

    if (!parsed.hostname || !isLikelyWebHost(parsed.hostname)) {
      return null
    }

    return parsed.toString()
  } catch {
    return null
  }
}

function getMaxColumns(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0)
}

export function detectUrlColumn(rows: string[][]): UrlColumnDetection {
  if (rows.length === 0) {
    return { index: null, hasHeader: false, reason: 'none' }
  }

  const firstRow = rows[0]
  const headerAliasIndex = firstRow.findIndex((cell) => URL_HEADER_ALIASES.has(cell.trim().toLowerCase()))
  if (headerAliasIndex >= 0) {
    return { index: headerAliasIndex, hasHeader: true, reason: 'header-alias' }
  }

  const maxColumns = getMaxColumns(rows)
  let bestIndex: number | null = null
  let bestValidCount = 0
  let bestScore = 0

  for (let colIndex = 0; colIndex < maxColumns; colIndex++) {
    let nonEmptyCount = 0
    let validCount = 0

    for (const row of rows) {
      const cell = (row[colIndex] || '').trim()
      if (!cell) continue

      nonEmptyCount++
      if (normalizeImportUrl(cell)) {
        validCount++
      }
    }

    if (nonEmptyCount === 0) continue

    const score = validCount / nonEmptyCount
    const isBetter =
      validCount > bestValidCount || (validCount === bestValidCount && score > bestScore)

    if (isBetter) {
      bestIndex = colIndex
      bestValidCount = validCount
      bestScore = score
    }
  }

  if (bestIndex === null || bestValidCount === 0 || bestScore < 0.5) {
    return { index: null, hasHeader: false, reason: 'none' }
  }

  return { index: bestIndex, hasHeader: false, reason: 'url-score' }
}

export function parseCsvImport(
  csvText: string,
  options: ParseCsvImportOptions = {}
): ParsedCsvImport {
  const rows = parseCsvText(csvText)
  const detection = detectUrlColumn(rows)

  const resolvedUrlColumnIndex =
    options.urlColumnIndex !== undefined ? options.urlColumnIndex : detection.index
  const resolvedHasHeader = options.hasHeader !== undefined ? options.hasHeader : detection.hasHeader

  const headers = resolvedHasHeader && rows.length > 0 ? rows[0] : null
  const startIndex = resolvedHasHeader ? 1 : 0

  const parsedRows: ParsedImportRow[] = rows.slice(startIndex).map((cells, index) => {
    const rowNumber = startIndex + index + 1
    const rawUrl = resolvedUrlColumnIndex === null ? '' : (cells[resolvedUrlColumnIndex] ?? '').trim()

    if (!rawUrl) {
      return {
        rowNumber,
        cells,
        rawUrl,
        normalizedUrl: null,
        isValidUrl: false,
        error: 'missing-url'
      }
    }

    const normalized = normalizeImportUrl(rawUrl)
    if (!normalized) {
      return {
        rowNumber,
        cells,
        rawUrl,
        normalizedUrl: null,
        isValidUrl: false,
        error: 'invalid-url'
      }
    }

    return {
      rowNumber,
      cells,
      rawUrl,
      normalizedUrl: normalized,
      isValidUrl: true
    }
  })

  return {
    headers,
    urlColumnIndex: resolvedUrlColumnIndex,
    rows: parsedRows
  }
}
