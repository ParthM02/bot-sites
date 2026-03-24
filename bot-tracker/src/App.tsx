import { useCallback, useEffect, useMemo, useState } from 'react'
import { hasSupabaseConfig, supabase } from './supabase.ts'
import './App.css'

type Transaction = {
  id: string
  bought_at: string
  slug: string | null
  question: string | null
  token_id: string | null
  side: string | null
  size: number | null
  buy_price: number | null
}

type PairRow = {
  rowId: string
  bought_at: string | null
  question: string | null
  slug: string | null
  total_size: number
  combined_buy_price: number
  estimated_pnl: number
  status: 'complete' | 'missing-counter-side' | 'extra-bug'
  status_label: string
  sides: string
}

type StatusFilter = 'all' | PairRow['status']

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 6,
})

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

const getTimestamp = (value: string | null) => {
  if (!value) {
    return Number.NEGATIVE_INFINITY
  }

  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp
}

const normalizeSide = (side: string | null) => {
  if (!side) {
    return null
  }

  const normalized = side.trim().toUpperCase()

  if (normalized === 'YES') {
    return 'YES'
  }

  if (normalized === 'NO') {
    return 'NO'
  }

  return null
}

const combinePairs = (items: Transaction[]) => {
  const groups = new Map<
    string,
    {
      slug: string
      question: string | null
      yes: Transaction[]
      no: Transaction[]
    }
  >()

  const incompleteSingles: PairRow[] = []

  for (const txn of items) {
    const side = normalizeSide(txn.side)

    if (!txn.slug || !side) {
      const combinedBuyPrice = txn.buy_price ?? 0
      incompleteSingles.push({
        rowId: txn.id,
        bought_at: txn.bought_at,
        question: txn.question,
        slug: txn.slug,
        total_size: txn.size ?? 0,
        combined_buy_price: combinedBuyPrice,
        estimated_pnl: -combinedBuyPrice,
        status: 'extra-bug',
        status_label: 'Extra Buy (Bug)',
        sides: side ? `${side} only` : 'Unknown side',
      })
      continue
    }

    const key = txn.slug
    const currentGroup = groups.get(key)

    if (!currentGroup) {
      groups.set(key, {
        slug: txn.slug,
        question: txn.question,
        yes: side === 'YES' ? [txn] : [],
        no: side === 'NO' ? [txn] : [],
      })
      continue
    }

    if (!currentGroup.question && txn.question) {
      currentGroup.question = txn.question
    }

    if (side === 'YES') {
      currentGroup.yes.push(txn)
    } else {
      currentGroup.no.push(txn)
    }
  }

  const pairRows: PairRow[] = []

  for (const [, group] of groups) {
    const yes = [...group.yes].sort(
      (a, b) => getTimestamp(a.bought_at) - getTimestamp(b.bought_at),
    )
    const no = [...group.no].sort(
      (a, b) => getTimestamp(a.bought_at) - getTimestamp(b.bought_at),
    )

    const completeCount = Math.min(yes.length, no.length)

    for (let index = 0; index < completeCount; index += 1) {
      const yesTxn = yes[index]
      const noTxn = no[index]
      const combinedBuyPrice = (yesTxn.buy_price ?? 0) + (noTxn.buy_price ?? 0)

      pairRows.push({
        rowId: `${yesTxn.id}-${noTxn.id}`,
        bought_at:
          getTimestamp(yesTxn.bought_at) >= getTimestamp(noTxn.bought_at)
            ? yesTxn.bought_at
            : noTxn.bought_at,
        question: group.question,
        slug: group.slug,
        total_size: (yesTxn.size ?? 0) + (noTxn.size ?? 0),
        combined_buy_price: combinedBuyPrice,
        estimated_pnl: 1 - combinedBuyPrice,
        status: 'complete',
        status_label: 'Complete',
        sides: 'YES + NO',
      })
    }

    const leftoverYes = yes.slice(completeCount)
    const leftoverNo = no.slice(completeCount)
    const leftovers = [...leftoverYes, ...leftoverNo].sort(
      (a, b) => getTimestamp(a.bought_at) - getTimestamp(b.bought_at),
    )

    for (const [index, txn] of leftovers.entries()) {
      const combinedBuyPrice = txn.buy_price ?? 0
      const side = normalizeSide(txn.side)
      const isMissingCounterSide = index === 0

      pairRows.push({
        rowId: txn.id,
        bought_at: txn.bought_at,
        question: group.question,
        slug: group.slug,
        total_size: txn.size ?? 0,
        combined_buy_price: combinedBuyPrice,
        estimated_pnl: -combinedBuyPrice,
        status: isMissingCounterSide ? 'missing-counter-side' : 'extra-bug',
        status_label: isMissingCounterSide
          ? 'Missing Counter-side'
          : 'Extra Buy (Bug)',
        sides: side ? `${side} only` : 'Unknown side',
      })
    }
  }

  const rows = [...pairRows, ...incompleteSingles].sort(
    (a, b) => getTimestamp(b.bought_at) - getTimestamp(a.bought_at),
  )

  const completePairs = rows.filter((row) => row.status === 'complete').length
  const missingCounterSideCount = rows.filter(
    (row) => row.status === 'missing-counter-side',
  ).length
  const extraBugCount = rows.filter((row) => row.status === 'extra-bug').length
  const extraBugLoss = rows
    .filter((row) => row.status === 'extra-bug')
    .reduce((sum, row) => sum + row.combined_buy_price, 0)
  const totalPnl = rows.reduce((sum, row) => sum + row.estimated_pnl, 0)

  return {
    rows,
    summary: {
      completePairs,
      missingCounterSideCount,
      extraBugCount,
      extraBugLoss,
      totalPnl,
    },
  }
}

function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [isLoading, setIsLoading] = useState(hasSupabaseConfig)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const fetchTransactions = useCallback(async () => {
    if (!supabase) {
      return
    }

    try {
      const pageSize = 1000
      let from = 0
      const allTransactions: Transaction[] = []

      while (true) {
        const { data, error: requestError } = await supabase
          .from('transactions')
          .select('id, bought_at, slug, question, token_id, side, size, buy_price')
          .order('bought_at', { ascending: false })
          .range(from, from + pageSize - 1)

        if (requestError) {
          setError(requestError.message)
          setTransactions([])
          return
        }

        const pageData = data ?? []
        allTransactions.push(...pageData)

        if (pageData.length < pageSize) {
          break
        }

        from += pageSize
      }

      setError(null)
      setTransactions(allTransactions)
    } catch {
      setError('Failed to fetch transactions.')
      setTransactions([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!hasSupabaseConfig) {
      return
    }

    void fetchTransactions()
  }, [fetchTransactions])

  const combinedData = useMemo(() => combinePairs(transactions), [transactions])

  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') {
      return combinedData.rows
    }

    return combinedData.rows.filter((row) => row.status === statusFilter)
  }, [combinedData.rows, statusFilter])

  const filterCounts = useMemo(
    () => ({
      all: combinedData.rows.length,
      complete: combinedData.summary.completePairs,
      'missing-counter-side': combinedData.summary.missingCounterSideCount,
      'extra-bug': combinedData.summary.extraBugCount,
    }),
    [combinedData.rows.length, combinedData.summary],
  )

  const statusText = useMemo(() => {
    if (!hasSupabaseConfig) {
      return 'Configuration required'
    }
    if (isLoading) {
      return 'Loading transactions...'
    }
    if (error) {
      return 'Could not load transactions'
    }
    return `${transactions.length} transactions loaded • ${combinedData.rows.length} combined rows`
  }, [combinedData.rows.length, error, isLoading, transactions.length])

  const renderCell = (value: string | number | null, fallback = '—') => {
    if (value === null || value === '') {
      return fallback
    }
    return String(value)
  }

  return (
    <main className="page">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h1>Transactions</h1>
            <p>{statusText}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setError(null)
              setIsLoading(true)
              void fetchTransactions()
            }}
            disabled={isLoading}
          >
            {isLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {!hasSupabaseConfig && (
          <div className="alert">
            Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in your .env file.
          </div>
        )}

        {error && <div className="alert error">{error}</div>}

        <div className="summary-wrap">
          <table>
            <thead>
              <tr>
                <th>Total Transactions</th>
                <th>Complete Pairs</th>
                <th>Missing Counter-side</th>
                <th>Extra Buys (Bug / Loss)</th>
                <th>Total PnL</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{numberFormatter.format(transactions.length)}</td>
                <td>{numberFormatter.format(combinedData.summary.completePairs)}</td>
                <td>{numberFormatter.format(combinedData.summary.missingCounterSideCount)}</td>
                <td>
                  {numberFormatter.format(combinedData.summary.extraBugCount)} /{' '}
                  <span className="pnl-negative">
                    -{numberFormatter.format(combinedData.summary.extraBugLoss)}
                  </span>
                </td>
                <td className={combinedData.summary.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                  {numberFormatter.format(combinedData.summary.totalPnl)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="filters">
          <span className="filters-label">Filter rows:</span>
          <button
            type="button"
            className={`filter-btn ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All ({numberFormatter.format(filterCounts.all)})
          </button>
          <button
            type="button"
            className={`filter-btn ${statusFilter === 'complete' ? 'active' : ''}`}
            onClick={() => setStatusFilter('complete')}
          >
            Complete ({numberFormatter.format(filterCounts.complete)})
          </button>
          <button
            type="button"
            className={`filter-btn ${statusFilter === 'missing-counter-side' ? 'active' : ''}`}
            onClick={() => setStatusFilter('missing-counter-side')}
          >
            Missing ({numberFormatter.format(filterCounts['missing-counter-side'])})
          </button>
          <button
            type="button"
            className={`filter-btn ${statusFilter === 'extra-bug' ? 'active' : ''}`}
            onClick={() => setStatusFilter('extra-bug')}
          >
            Extra Bug ({numberFormatter.format(filterCounts['extra-bug'])})
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Bought At</th>
                <th>Question</th>
                <th>Slug</th>
                <th>Sides</th>
                <th>Total Size</th>
                <th>Combined Buy Price</th>
                <th>Estimated PnL</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {!isLoading && filteredRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    No transactions found.
                  </td>
                </tr>
              )}

              {filteredRows.map((row) => {
                const boughtAt = row.bought_at
                  ? dateFormatter.format(new Date(row.bought_at))
                  : '—'

                return (
                  <tr key={row.rowId}>
                    <td>{boughtAt}</td>
                    <td>{renderCell(row.question)}</td>
                    <td>{renderCell(row.slug)}</td>
                    <td>
                      <span className="pill">{renderCell(row.sides)}</span>
                    </td>
                    <td>
                      {numberFormatter.format(row.total_size)}
                    </td>
                    <td>{numberFormatter.format(row.combined_buy_price)}</td>
                    <td>
                      <span className={row.estimated_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                        {numberFormatter.format(row.estimated_pnl)}
                      </span>
                    </td>
                    <td>
                      <span className={`pill ${row.status}`}>
                        {row.status_label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

export default App
