import { describe, it, expect } from 'vitest'
import {
  parseCsvText,
  detectUrlColumn,
  normalizeImportUrl,
  parseCsvImport
} from '@/lib/csv-import'

describe('csv-import', () => {
  describe('parseCsvText', () => {
    it('parses quoted fields, commas, and escaped quotes', () => {
      const csv = [
        'title,url,notes',
        '"One, Two",https://example.com,"He said ""hello"""',
        'Plain,https://example.org,Done'
      ].join('\n')

      const rows = parseCsvText(csv)
      expect(rows).toEqual([
        ['title', 'url', 'notes'],
        ['One, Two', 'https://example.com', 'He said "hello"'],
        ['Plain', 'https://example.org', 'Done']
      ])
    })

    it('handles CRLF and trailing blank lines', () => {
      const csv = 'url\r\nhttps://example.com\r\n\r\n'
      const rows = parseCsvText(csv)
      expect(rows).toEqual([['url'], ['https://example.com']])
    })
  })

  describe('normalizeImportUrl', () => {
    it('prepends https when protocol is missing', () => {
      expect(normalizeImportUrl('example.com/page')).toBe('https://example.com/page')
      expect(normalizeImportUrl('www.example.com')).toBe('https://www.example.com/')
    })

    it('preserves valid http/https urls', () => {
      expect(normalizeImportUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
      expect(normalizeImportUrl('http://example.com')).toBe('http://example.com/')
    })

    it('rejects invalid or unsupported urls', () => {
      expect(normalizeImportUrl('')).toBeNull()
      expect(normalizeImportUrl('notaurl')).toBeNull()
      expect(normalizeImportUrl('ftp://example.com/file')).toBeNull()
    })
  })

  describe('detectUrlColumn', () => {
    it('detects url column by header alias', () => {
      const rows = [
        ['Title', 'Website', 'Notes'],
        ['A', 'example.com', 'x'],
        ['B', 'https://example.org', 'y']
      ]

      const result = detectUrlColumn(rows)
      expect(result).toEqual({ index: 1, hasHeader: true, reason: 'header-alias' })
    })

    it('detects url column without headers by url-likeness', () => {
      const rows = [
        ['Item A', 'example.com', 'alpha'],
        ['Item B', 'https://example.org/page', 'beta'],
        ['Item C', 'not-a-url', 'gamma']
      ]

      const result = detectUrlColumn(rows)
      expect(result).toEqual({ index: 1, hasHeader: false, reason: 'url-score' })
    })
  })

  describe('parseCsvImport', () => {
    it('returns rows with normalized url and validation status', () => {
      const csv = [
        'title,link',
        'First,example.com',
        'Second,https://example.org',
        'Third,not a url',
        'Fourth,'
      ].join('\n')

      const parsed = parseCsvImport(csv)

      expect(parsed.urlColumnIndex).toBe(1)
      expect(parsed.headers).toEqual(['title', 'link'])
      expect(parsed.rows).toEqual([
        {
          rowNumber: 2,
          cells: ['First', 'example.com'],
          rawUrl: 'example.com',
          normalizedUrl: 'https://example.com/',
          isValidUrl: true
        },
        {
          rowNumber: 3,
          cells: ['Second', 'https://example.org'],
          rawUrl: 'https://example.org',
          normalizedUrl: 'https://example.org/',
          isValidUrl: true
        },
        {
          rowNumber: 4,
          cells: ['Third', 'not a url'],
          rawUrl: 'not a url',
          normalizedUrl: null,
          isValidUrl: false,
          error: 'invalid-url'
        },
        {
          rowNumber: 5,
          cells: ['Fourth', ''],
          rawUrl: '',
          normalizedUrl: null,
          isValidUrl: false,
          error: 'missing-url'
        }
      ])
    })
  })
})
