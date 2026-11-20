export type Market = 'sh' | 'sz' | 'bj' | 'hk';
export type Currency = 'CNY' | 'HKD';
export interface Security { id: string; code: string; name: string; market: Market; kind: 'stock' | 'fund' | 'index'; currency: Currency; }
export interface Group { id: string; name: string; symbols: string[]; }
export interface Position { quantity: number; cost: number; }
export interface PortfolioState { version: 1; groups: Group[]; securities: Record<string, Security>; positions: Record<string, Position>; }
export interface Quote { id: string; name: string; price: number | null; previousClose: number | null; change: number | null; changePercent: number | null; currency: Currency; time: string; date: string; fetchedAt: number; stale?: boolean; }
export type MarketQuote = Omit<Quote, 'currency'> & { currency: Currency | 'USD' };
export type MarketInstrument = Omit<Security, 'market' | 'kind' | 'currency'> & {
  market: Market | 'london'; kind: 'index' | 'metal'; currency: Currency | 'USD';
};
export interface Metrics { daily: number | null; dailyPercent: number | null; profit: number | null; profitPercent: number | null; marketValue: number | null; costValue: number; }
export interface CurrencySummary { currency: Currency; daily: number | null; dailyPercent: number | null; profit: number | null; profitPercent: number | null; marketValue: number | null; count: number; validCount: number; incomplete: boolean; date: string; }
export interface Snapshot { state: PortfolioState; quotes: Record<string, Quote>; metrics: Record<string, Metrics>; summaries: CurrencySummary[]; refreshing: boolean; error: string; updatedAt: number | null; today: string;
  markets: MarketInstrument[]; marketQuotes: Record<string, MarketQuote>; marketError: string;
  preferences: import('./preferences').Preferences; sorts: Record<string, import('./preferences').SortOrder>;
}
