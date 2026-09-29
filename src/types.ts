export interface Product {
  ProductId: string;
  Name: string;
  Unit: string;
  Price: number;
  Active: boolean;
}

export interface Route {
  RouteId: string;
  Name: string;
  Villages: string;
  DefaultVehicle: string;
  DefaultDriver: string;
  Active: boolean;
}

export interface TripItem {
  TripItemId: string;
  TripId: string;
  ProductId: string;
  Price: number;
  QtyDispatched: number;
  QtyReturned: number;
  DispatchedValue: number;
  ReturnedValue: number;
}

export type Session = 'Morning' | 'Evening';

export interface Trip {
  TripId: string;
  Date: string;
  Session: Session;
  RouteId: string;
  Driver: string;
  Vehicle: string;
  Status: 'Dispatched' | 'Settled';
  DispatchedTotal: number;
  ReturnedTotal: number | '';
  AmountDue: number | '';
  CashHandedOver: number | '';
  Discrepancy: number | '';
  CreatedAt: string;
  SettledAt: string;
  DispatchedBy?: string;
  SettledBy?: string;
  ReopenedBy?: string;
  ReopenedAt?: string;
  RouteName?: string;
}

export interface TripWithItems {
  trip: Trip;
  items: TripItem[];
}

export interface Shop {
  ShopId: string;
  Name: string;
  OwnerName: string;
  Phone: string;
  RouteId: string;
  Active: boolean;
  HasPin: boolean;
}

/** A staff account, as listed for admins. */
export interface Staff {
  StaffId: string;
  Name: string;
  Phone: string;
  Role: 'admin' | 'staff';
  Active: boolean;
}

/** The logged-in staff member. */
export interface StaffUser {
  id: string;
  name: string;
  role: 'admin' | 'staff';
}

export interface MasterData {
  products: Product[];
  routes: Route[];
  shops: Shop[];
  staff: Staff[]; // admins only; empty for other staff
}

/** A shop's order for one delivery (date + session). */
export interface Indent {
  indentId: string;
  date: string;
  session: Session;
  shopId: string;
  routeId: string;
  items: { productId: string; qty: number }[];
  total: number;
  updatedAt: string; // 'yyyy-MM-dd HH:mm'
}

export interface DashboardData {
  trips: Trip[];
  orders: { routeId: string; session: Session; shops: number; ordered: number }[];
}

// ---- Shop owner portal ----

export interface ShopProduct {
  ProductId: string;
  Name: string;
  Unit: string;
  Price: number;
}

export interface ShopSlot {
  date: string;
  session: Session;
  cutoff: string; // 'yyyy-MM-dd HH:mm'
  order: Indent | null;
}

export interface ShopHome {
  shop: { name: string; ownerName: string; routeName: string };
  products: ShopProduct[];
  slots: ShopSlot[]; // the next few open deliveries (quick tabs)
  orders: Indent[]; // all of this shop's orders for today or later, incl. advance orders
  lastOrder: Indent | null;
  maxDate: string; // last date the shop may order for
  now: string; // 'yyyy-MM-dd HH:mm', India time
}

/** Everything the Route screen needs, in one request. */
export interface RouteDay extends MasterData {
  session: Session; // the session to open
  trips: TripWithItems[]; // this route's trips on the date: 0–2, one per session
  indents: Indent[]; // shop orders for this route on the date (both sessions)
}

export interface AnalyticsSummary {
  totalDispatched: number;
  totalReturned: number;
  totalRevenue: number;
  totalCash: number;
  totalDiscrepancy: number;
  totalShortage: number;
  totalExcess: number;
  tripCount: number;
}

export interface AnalyticsByDate {
  date: string;
  dispatched: number;
  returned: number;
  cash: number;
  discrepancy: number;
  shortage: number;
  tripCount: number;
  revenue: number;
}

export interface AnalyticsByRoute {
  routeId: string;
  routeName: string;
  dispatched: number;
  returned: number;
  discrepancy: number;
  shortage: number;
  excess: number;
  tripCount: number;
  revenue: number;
}

export interface AnalyticsByDriver {
  driver: string;
  tripCount: number;
  shortTrips: number;
  shortage: number;
  excess: number;
  discrepancy: number;
}

export interface AnalyticsBySession {
  session: Session;
  dispatched: number;
  returned: number;
  tripCount: number;
  revenue: number;
}

export interface AnalyticsByProduct {
  productId: string;
  productName: string;
  qtyDispatched: number;
  qtyReturned: number;
  dispatchedValue: number;
  returnedValue: number;
  revenue: number;
  returnRate: number;
}

export interface Analytics {
  summary: AnalyticsSummary;
  byDate: AnalyticsByDate[];
  byRoute: AnalyticsByRoute[];
  byDriver: AnalyticsByDriver[];
  bySession: AnalyticsBySession[];
  byProduct: AnalyticsByProduct[];
  previous?: Analytics; // comparison range, when requested
}
