export * from './chart-builder'
export * from './chart-domain'
export * from './chart-values'
export * from './date'
export * as displayChart from './display-chart-schema'

/** Portés de nao apps/frontend/src/lib/charts.utils.ts (logique pure) */
export const toKey = (value: string) => {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]/g, '_')
}

export function resolvePieTooltipLabel(payload?: readonly { name?: unknown }[]): string {
  if (!payload || payload.length === 0) return ''
  const names = payload.map((p) => (typeof p.name === 'string' ? p.name : String(p.name ?? '')))
  return names.join(' + ')
}

export function sortByDateKey<T extends Record<string, unknown>>(data: T[], key: string): T[] {
  const sorted = [...data].sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    const at = typeof av === 'string' || typeof av === 'number' ? new Date(av).getTime() : NaN
    const bt = typeof bv === 'string' || typeof bv === 'number' ? new Date(bv).getTime() : NaN
    if (Number.isNaN(at) || Number.isNaN(bt)) return 0
    return at - bt
  })
  return sorted
}

/** Porté de nao shared/src/map.ts (résolution de colonne case-insensitive) */
export function resolveColumnName(columns: string[], key: string): string {
  if (columns.includes(key)) {
    return key
  }
  const lower = key.toLowerCase()
  const match = columns.find((column) => column.toLowerCase() === lower)
  return match ?? key
}

export function resolveDataKey(data: Record<string, unknown>[], key: string | undefined): string {
  if (key === undefined) {
    return ''
  }
  const row = data[0]
  if (!row) {
    return key
  }
  return resolveColumnName(Object.keys(row), key)
}
