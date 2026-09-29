// Analytics from raw settled trips and their items. Shared by demo mode and
// the Supabase backend (which returns the raw rows via get_analytics_data),
// so both produce identical numbers.

import type {
  Analytics,
  AnalyticsByDate,
  AnalyticsByDriver,
  AnalyticsByProduct,
  AnalyticsByRoute,
  AnalyticsByRouteProduct,
  AnalyticsBySession,
  Session,
  Trip,
  TripItem,
} from './types';

export interface AnalyticsSource {
  trips: Trip[];
  items: TripItem[];
  routeNames: Record<string, string>;
  productNames: Record<string, string>;
}

export function computeAnalytics(src: AnalyticsSource, payload: { dateFrom?: string; dateTo?: string }): Analytics {
  const settled = src.trips.filter((t) => {
    if (t.Status !== 'Settled') return false;
    if (payload.dateFrom && t.Date < payload.dateFrom) return false;
    if (payload.dateTo && t.Date > payload.dateTo) return false;
    return true;
  });

  const routeMap = new Map(Object.entries(src.routeNames));
  const productMap = new Map(Object.entries(src.productNames));
  const tripIdSet = new Set(settled.map((t) => t.TripId));
  const items = src.items.filter((i) => tripIdSet.has(i.TripId) && (Number(i.QtyDispatched) || 0) > 0);

  let totalDispatched = 0;
  let totalReturned = 0;
  let totalCash = 0;
  let totalDiscrepancy = 0;
  let totalShortage = 0;
  let totalExcess = 0;

  const byDateMap = new Map<string, AnalyticsByDate>();
  const byRouteMap = new Map<string, AnalyticsByRoute>();
  const byDriverMap = new Map<string, AnalyticsByDriver>();
  const bySessionMap = new Map<Session, AnalyticsBySession>([
    ['Morning', { session: 'Morning', dispatched: 0, returned: 0, tripCount: 0, revenue: 0 }],
    ['Evening', { session: 'Evening', dispatched: 0, returned: 0, tripCount: 0, revenue: 0 }],
  ]);

  settled.forEach((t) => {
    const dispatched = Number(t.DispatchedTotal) || 0;
    const returned = Number(t.ReturnedTotal) || 0;
    const discrepancy = Number(t.Discrepancy) || 0;
    const cash = Number(t.CashHandedOver) || 0;
    const shortage = discrepancy < 0 ? -discrepancy : 0;
    const excess = discrepancy > 0 ? discrepancy : 0;

    totalDispatched += dispatched;
    totalReturned += returned;
    totalCash += cash;
    totalDiscrepancy += discrepancy;
    totalShortage += shortage;
    totalExcess += excess;

    if (!byDateMap.has(t.Date)) {
      byDateMap.set(t.Date, { date: t.Date, dispatched: 0, returned: 0, cash: 0, discrepancy: 0, shortage: 0, tripCount: 0, revenue: 0 });
    }
    const byDate = byDateMap.get(t.Date)!;
    byDate.dispatched += dispatched;
    byDate.returned += returned;
    byDate.discrepancy += discrepancy;
    byDate.shortage += shortage;
    byDate.cash += cash;
    byDate.tripCount += 1;
    byDate.revenue = byDate.dispatched - byDate.returned;

    if (!byRouteMap.has(t.RouteId)) {
      byRouteMap.set(t.RouteId, {
        routeId: t.RouteId,
        routeName: routeMap.get(t.RouteId) || t.RouteId,
        dispatched: 0,
        returned: 0,
        discrepancy: 0,
        shortage: 0,
        excess: 0,
        tripCount: 0,
        revenue: 0,
        firstDate: t.Date,
        lastDate: t.Date,
      });
    }
    const byRoute = byRouteMap.get(t.RouteId)!;
    if (t.Date < byRoute.firstDate) byRoute.firstDate = t.Date;
    if (t.Date > byRoute.lastDate) byRoute.lastDate = t.Date;
    byRoute.dispatched += dispatched;
    byRoute.returned += returned;
    byRoute.discrepancy += discrepancy;
    byRoute.shortage += shortage;
    byRoute.excess += excess;
    byRoute.tripCount += 1;
    byRoute.revenue = byRoute.dispatched - byRoute.returned;

    const driver = t.Driver.trim() || '(no driver)';
    if (!byDriverMap.has(driver)) {
      byDriverMap.set(driver, { driver, tripCount: 0, shortTrips: 0, shortage: 0, excess: 0, discrepancy: 0 });
    }
    const byDriver = byDriverMap.get(driver)!;
    byDriver.tripCount += 1;
    if (shortage > 0) byDriver.shortTrips += 1;
    byDriver.shortage += shortage;
    byDriver.excess += excess;
    byDriver.discrepancy += discrepancy;

    const bySession = bySessionMap.get(t.Session);
    if (bySession) {
      bySession.dispatched += dispatched;
      bySession.returned += returned;
      bySession.tripCount += 1;
      bySession.revenue = bySession.dispatched - bySession.returned;
    }
  });

  const tripDate = new Map(settled.map((t) => [t.TripId, t.Date]));
  const tripRoute = new Map(settled.map((t) => [t.TripId, t.RouteId]));
  const byRouteProductMap = new Map<string, AnalyticsByRouteProduct>();
  const byProductMap = new Map<string, AnalyticsByProduct>();
  items.forEach((i) => {
    const date = tripDate.get(i.TripId)!;
    if (!byProductMap.has(i.ProductId)) {
      byProductMap.set(i.ProductId, {
        productId: i.ProductId,
        productName: productMap.get(i.ProductId) || i.ProductId,
        qtyDispatched: 0,
        qtyReturned: 0,
        dispatchedValue: 0,
        returnedValue: 0,
        revenue: 0,
        returnRate: 0,
        firstDate: date,
        lastDate: date,
      });
    }
    const p = byProductMap.get(i.ProductId)!;
    if (date < p.firstDate) p.firstDate = date;
    if (date > p.lastDate) p.lastDate = date;
    p.qtyDispatched += Number(i.QtyDispatched) || 0;
    p.qtyReturned += Number(i.QtyReturned) || 0;
    p.dispatchedValue += Number(i.DispatchedValue) || 0;
    p.returnedValue += Number(i.ReturnedValue) || 0;
    p.revenue = p.dispatchedValue - p.returnedValue;
    p.returnRate = p.qtyDispatched > 0 ? p.qtyReturned / p.qtyDispatched : 0;

    const routeId = tripRoute.get(i.TripId)!;
    const key = `${routeId}|${i.ProductId}`;
    if (!byRouteProductMap.has(key)) {
      byRouteProductMap.set(key, { routeId, productId: i.ProductId, qtyDispatched: 0, qtyReturned: 0, dispatchedValue: 0, returnedValue: 0 });
    }
    const rp = byRouteProductMap.get(key)!;
    rp.qtyDispatched += Number(i.QtyDispatched) || 0;
    rp.qtyReturned += Number(i.QtyReturned) || 0;
    rp.dispatchedValue += Number(i.DispatchedValue) || 0;
    rp.returnedValue += Number(i.ReturnedValue) || 0;
  });

  return {
    summary: {
      totalDispatched,
      totalReturned,
      totalRevenue: totalDispatched - totalReturned,
      totalCash,
      totalDiscrepancy,
      totalShortage,
      totalExcess,
      tripCount: settled.length,
    },
    byDate: Array.from(byDateMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    byRoute: Array.from(byRouteMap.values()).sort((a, b) => b.revenue - a.revenue),
    byDriver: Array.from(byDriverMap.values()).sort((a, b) => b.shortage - a.shortage || b.excess - a.excess),
    bySession: Array.from(bySessionMap.values()),
    byProduct: Array.from(byProductMap.values()).sort((a, b) => b.revenue - a.revenue),
    byRouteProduct: Array.from(byRouteProductMap.values()),
  };
}
