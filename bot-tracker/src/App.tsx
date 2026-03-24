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

function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [isLoading, setIsLoading] = useState(hasSupabaseConfig)
  const [error, setError] = useState<string | null>(null)

  const fetchTransactions = useCallback(async () => {
    if (!supabase) {
      return
    }

    try {
      const { data, error: requestError } = await supabase
        .from('transactions')
        .select('id, bought_at, slug, question, token_id, side, size, buy_price')
        .order('bought_at', { ascending: false })
        .limit(200)

      if (requestError) {
        setError(requestError.message)
        setTransactions([])
        return
      }

      setError(null)
      setTransactions(data ?? [])
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
    return `${transactions.length} transactions loaded`
  }, [error, isLoading, transactions.length])

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

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Bought At</th>
                <th>Question</th>
                <th>Slug</th>
                <th>Token ID</th>
                <th>Side</th>
                <th>Size</th>
                <th>Buy Price</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {!isLoading && transactions.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    No transactions found.
                  </td>
                </tr>
              )}

              {transactions.map((txn) => {
                const boughtAt = txn.bought_at
                  ? dateFormatter.format(new Date(txn.bought_at))
                  : '—'

                return (
                  <tr key={txn.id}>
                    <td>{boughtAt}</td>
                    <td>{renderCell(txn.question)}</td>
                    <td>{renderCell(txn.slug)}</td>
                    <td>{renderCell(txn.token_id)}</td>
                    <td>
                      <span className="pill">{renderCell(txn.side)}</span>
                    </td>
                    <td>
                      {txn.size === null
                        ? '—'
                        : numberFormatter.format(txn.size)}
                    </td>
                    <td>
                      {txn.buy_price === null
                        ? '—'
                        : numberFormatter.format(txn.buy_price)}
                    </td>
                    <td>{txn.id}</td>
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
