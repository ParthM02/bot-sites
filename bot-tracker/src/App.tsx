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
type MarketFilter = 'all' | 'btc' | 'eth' | 'xrp' | 'sol' | 'doge'

type DailyBlackoutRow = {
  dayKey: string
  dayLabel: string
  slotLabel: string
  tradesInSlot: number
  slotPnl: number
  avoidableLoss: number
  dayPnl: number
  projectedDayPnl: number
}

type BlackoutWindow = 30 | 60 | 120

type BlackoutWindowResult = {
  windowMinutes: BlackoutWindow
  totalAvoidableLoss: number
  rows: DailyBlackoutRow[]
}

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

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
})

const getDayKey = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatSlotLabel = (hour: number, minute: number, durationMinutes: number) => {
  const endMinuteTotal = hour * 60 + minute + durationMinutes
  const endHour = Math.floor(endMinuteTotal / 60) % 24
  const endMinute = endMinuteTotal % 60

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} - ${String(
    endHour,
  ).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`
}

const isFiveMinuteContract = (slug: string | null) =>
  Boolean(slug && slug.includes('-5m-'))

const detectMarket = (
  slug: string | null,
  question: string | null,
): 'btc' | 'eth' | 'xrp' | 'sol' | 'doge' | null => {
  const slugText = (slug ?? '').toLowerCase()
  const questionText = (question ?? '').toLowerCase()
  const combined = `${slugText} ${questionText}`

  if (combined.includes('btc') || combined.includes('bitcoin')) {
    return 'btc'
  }

  if (combined.includes('eth') || combined.includes('ethereum')) {
    return 'eth'
  }

  if (combined.includes('xrp') || combined.includes('ripple')) {
    return 'xrp'
  }

  if (combined.includes('sol') || combined.includes('solana')) {
    return 'sol'
  }

  if (combined.includes('doge') || combined.includes('dogecoin')) {
    return 'doge'
  }

  return null
}

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
      const shouldMarkAsExtraBug = completeCount > 0
      const isMissingCounterSide = !shouldMarkAsExtraBug && index === 0

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

const getSummaryFromRows = (rows: PairRow[]) => {
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
    completePairs,
    missingCounterSideCount,
    extraBugCount,
    extraBugLoss,
    totalPnl,
  }
}

function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [isLoading, setIsLoading] = useState(hasSupabaseConfig)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [marketFilter, setMarketFilter] = useState<MarketFilter>('all')
  const [blackoutWindow, setBlackoutWindow] = useState<BlackoutWindow>(30)

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

  const marketCounts = useMemo(() => {
    let btc = 0
    let eth = 0
    let xrp = 0
    let sol = 0
    let doge = 0

    for (const row of combinedData.rows) {
      const market = detectMarket(row.slug, row.question)
      if (market === 'btc') {
        btc += 1
      }
      if (market === 'eth') {
        eth += 1
      }
      if (market === 'xrp') {
        xrp += 1
      }
      if (market === 'sol') {
        sol += 1
      }
      if (market === 'doge') {
        doge += 1
      }
    }

    return {
      all: combinedData.rows.length,
      btc,
      eth,
      xrp,
      sol,
      doge,
    }
  }, [combinedData.rows])

  const marketPnl = useMemo(() => {
    let btc = 0
    let eth = 0
    let xrp = 0
    let sol = 0
    let doge = 0

    for (const row of combinedData.rows) {
      const market = detectMarket(row.slug, row.question)
      if (market === 'btc') {
        btc += row.estimated_pnl
      }
      if (market === 'eth') {
        eth += row.estimated_pnl
      }
      if (market === 'xrp') {
        xrp += row.estimated_pnl
      }
      if (market === 'sol') {
        sol += row.estimated_pnl
      }
      if (market === 'doge') {
        doge += row.estimated_pnl
      }
    }

    return {
      btc,
      eth,
      xrp,
      sol,
      doge,
    }
  }, [combinedData.rows])

  const marketFilteredRows = useMemo(() => {
    if (marketFilter === 'all') {
      return combinedData.rows
    }

    return combinedData.rows.filter(
      (row) => detectMarket(row.slug, row.question) === marketFilter,
    )
  }, [combinedData.rows, marketFilter])

  const marketFilteredTransactionsCount = useMemo(() => {
    if (marketFilter === 'all') {
      return transactions.length
    }

    return transactions.filter(
      (txn) => detectMarket(txn.slug, txn.question) === marketFilter,
    ).length
  }, [marketFilter, transactions])

  const selectedSummary = useMemo(
    () => getSummaryFromRows(marketFilteredRows),
    [marketFilteredRows],
  )

  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') {
      return marketFilteredRows
    }

    return marketFilteredRows.filter((row) => row.status === statusFilter)
  }, [marketFilteredRows, statusFilter])

  const filterCounts = useMemo(
    () => ({
      all: marketFilteredRows.length,
      complete: selectedSummary.completePairs,
      'missing-counter-side': selectedSummary.missingCounterSideCount,
      'extra-bug': selectedSummary.extraBugCount,
    }),
    [marketFilteredRows.length, selectedSummary],
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
    const marketLabel = marketFilter === 'all' ? 'all markets' : marketFilter.toUpperCase()
    return `${transactions.length} transactions loaded • ${marketFilteredRows.length} combined rows (${marketLabel})`
  }, [error, isLoading, marketFilter, marketFilteredRows.length, transactions.length])

  const blackoutAnalysis = useMemo(() => {
    const windows: BlackoutWindow[] = [30, 60, 120]

    const analyzeWindow = (windowMinutes: BlackoutWindow): BlackoutWindowResult => {
      const dailyMap = new Map<
        string,
        {
          dayLabel: string
          dayPnl: number
          slots: Map<string, { pnl: number; trades: number; hour: number; minute: number }>
        }
      >()

      for (const row of marketFilteredRows) {
        if (!row.bought_at || !isFiveMinuteContract(row.slug)) {
          continue
        }

        const date = new Date(row.bought_at)
        if (Number.isNaN(date.getTime())) {
          continue
        }

        const dayKey = getDayKey(date)
        const dayLabel = dayFormatter.format(date)
        const minuteOfDay = date.getHours() * 60 + date.getMinutes()
        const bucketMinuteOfDay = Math.floor(minuteOfDay / windowMinutes) * windowMinutes
        const bucketHour = Math.floor(bucketMinuteOfDay / 60)
        const bucketMinute = bucketMinuteOfDay % 60
        const slotKey = `${String(bucketHour).padStart(2, '0')}:${String(bucketMinute).padStart(2, '0')}`

        const dayEntry = dailyMap.get(dayKey)
        if (!dayEntry) {
          dailyMap.set(dayKey, {
            dayLabel,
            dayPnl: row.estimated_pnl,
            slots: new Map([
              [
                slotKey,
                {
                  pnl: row.estimated_pnl,
                  trades: 1,
                  hour: bucketHour,
                  minute: bucketMinute,
                },
              ],
            ]),
          })
          continue
        }

        dayEntry.dayPnl += row.estimated_pnl
        const slotEntry = dayEntry.slots.get(slotKey)

        if (!slotEntry) {
          dayEntry.slots.set(slotKey, {
            pnl: row.estimated_pnl,
            trades: 1,
            hour: bucketHour,
            minute: bucketMinute,
          })
        } else {
          slotEntry.pnl += row.estimated_pnl
          slotEntry.trades += 1
        }
      }

      const rows: DailyBlackoutRow[] = []

      for (const [dayKey, dayEntry] of dailyMap) {
        const slotValues = [...dayEntry.slots.values()]
        if (slotValues.length === 0) {
          continue
        }

        const worstSlot = slotValues.reduce((worst, current) =>
          current.pnl < worst.pnl ? current : worst,
        )

        const avoidableLoss = worstSlot.pnl < 0 ? -worstSlot.pnl : 0

        rows.push({
          dayKey,
          dayLabel: dayEntry.dayLabel,
          slotLabel: formatSlotLabel(worstSlot.hour, worstSlot.minute, windowMinutes),
          tradesInSlot: worstSlot.trades,
          slotPnl: worstSlot.pnl,
          avoidableLoss,
          dayPnl: dayEntry.dayPnl,
          projectedDayPnl: dayEntry.dayPnl + avoidableLoss,
        })
      }

      rows.sort((a, b) => b.dayKey.localeCompare(a.dayKey))

      return {
        windowMinutes,
        rows,
        totalAvoidableLoss: rows.reduce((sum, row) => sum + row.avoidableLoss, 0),
      }
    }

    return windows.map(analyzeWindow)
  }, [marketFilteredRows])

  const selectedBlackout = useMemo(
    () =>
      blackoutAnalysis.find((result) => result.windowMinutes === blackoutWindow) ?? {
        windowMinutes: blackoutWindow,
        rows: [],
        totalAvoidableLoss: 0,
      },
    [blackoutAnalysis, blackoutWindow],
  )

  const bestBlackoutWindow = useMemo(
    () =>
      blackoutAnalysis.reduce<BlackoutWindowResult | null>((best, current) => {
        if (!best || current.totalAvoidableLoss > best.totalAvoidableLoss) {
          return current
        }
        return best
      }, null),
    [blackoutAnalysis],
  )

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

        <div className="filters market-filters">
          <span className="filters-label">Market:</span>
          <button
            type="button"
            className={`filter-btn ${marketFilter === 'all' ? 'active' : ''}`}
            onClick={() => setMarketFilter('all')}
          >
            All ({numberFormatter.format(marketCounts.all)})
          </button>
          <button
            type="button"
            className={`filter-btn ${marketFilter === 'btc' ? 'active' : ''}`}
            onClick={() => setMarketFilter('btc')}
          >
            BTC ({numberFormatter.format(marketCounts.btc)} / {numberFormatter.format(marketPnl.btc)})
          </button>
          <button
            type="button"
            className={`filter-btn ${marketFilter === 'eth' ? 'active' : ''}`}
            onClick={() => setMarketFilter('eth')}
          >
            ETH ({numberFormatter.format(marketCounts.eth)} / {numberFormatter.format(marketPnl.eth)})
          </button>
          <button
            type="button"
            className={`filter-btn ${marketFilter === 'xrp' ? 'active' : ''}`}
            onClick={() => setMarketFilter('xrp')}
          >
            XRP ({numberFormatter.format(marketCounts.xrp)} / {numberFormatter.format(marketPnl.xrp)})
          </button>
          <button
            type="button"
            className={`filter-btn ${marketFilter === 'sol' ? 'active' : ''}`}
            onClick={() => setMarketFilter('sol')}
          >
            SOL ({numberFormatter.format(marketCounts.sol)} / {numberFormatter.format(marketPnl.sol)})
          </button>
          <button
            type="button"
            className={`filter-btn ${marketFilter === 'doge' ? 'active' : ''}`}
            onClick={() => setMarketFilter('doge')}
          >
            DOGE ({numberFormatter.format(marketCounts.doge)} / {numberFormatter.format(marketPnl.doge)})
          </button>
        </div>

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
                <td>{numberFormatter.format(marketFilteredTransactionsCount)}</td>
                <td>{numberFormatter.format(selectedSummary.completePairs)}</td>
                <td>{numberFormatter.format(selectedSummary.missingCounterSideCount)}</td>
                <td>
                  {numberFormatter.format(selectedSummary.extraBugCount)} /{' '}
                  <span className="pnl-negative">
                    -{numberFormatter.format(selectedSummary.extraBugLoss)}
                  </span>
                </td>
                <td className={selectedSummary.totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                  {numberFormatter.format(selectedSummary.totalPnl)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="blackout-wrap">
          <div className="blackout-header">
            <h2>Daily Blackout Suggestion (5m Contracts)</h2>
            <p>
              One blackout slot per day • selected window total avoidable loss:{' '}
              <span className="pnl-positive">
                {numberFormatter.format(selectedBlackout.totalAvoidableLoss)}
              </span>
            </p>
            {bestBlackoutWindow && (
              <p>
                Auto-best window:{' '}
                <span className="best-window-pill">{bestBlackoutWindow.windowMinutes}m</span>{' '}
                • max avoidable loss:{' '}
                <span className="pnl-positive">
                  {numberFormatter.format(bestBlackoutWindow.totalAvoidableLoss)}
                </span>
              </p>
            )}
          </div>

          <div className="blackout-controls">
            {blackoutAnalysis.map((entry) => (
              <button
                key={entry.windowMinutes}
                type="button"
                className={`filter-btn ${blackoutWindow === entry.windowMinutes ? 'active' : ''}`}
                onClick={() => setBlackoutWindow(entry.windowMinutes)}
              >
                {entry.windowMinutes}m ({numberFormatter.format(entry.totalAvoidableLoss)})
                {bestBlackoutWindow?.windowMinutes === entry.windowMinutes && (
                  <span className="best-chip">Best</span>
                )}
              </button>
            ))}
          </div>

          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Suggested Blackout Slot</th>
                <th>Trades In Slot</th>
                <th>Slot PnL</th>
                <th>Avoidable Loss</th>
                <th>Day PnL</th>
                <th>Projected Day PnL (With Blackout)</th>
              </tr>
            </thead>
            <tbody>
              {!isLoading && selectedBlackout.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty">
                    No 5-minute contract rows available.
                  </td>
                </tr>
              )}

              {selectedBlackout.rows.map((row) => (
                <tr key={row.dayKey}>
                  <td>{row.dayLabel}</td>
                  <td>{row.slotLabel}</td>
                  <td>{numberFormatter.format(row.tradesInSlot)}</td>
                  <td className={row.slotPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                    {numberFormatter.format(row.slotPnl)}
                  </td>
                  <td className={row.avoidableLoss > 0 ? 'pnl-positive' : ''}>
                    {numberFormatter.format(row.avoidableLoss)}
                  </td>
                  <td className={row.dayPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                    {numberFormatter.format(row.dayPnl)}
                  </td>
                  <td className={row.projectedDayPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>
                    {numberFormatter.format(row.projectedDayPnl)}
                  </td>
                </tr>
              ))}
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
