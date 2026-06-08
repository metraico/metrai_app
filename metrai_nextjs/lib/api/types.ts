// Auth
export interface LoginRequest { username: string; password: string }
export interface LogoutRequest { refresh_token: string }
export interface LoginResponse {
  access_token: string
  refresh_token: string
  token_type: string
  user_id: string
  retailer_account_id: string
  full_name: string
}
export interface RegisterRequest {
  username: string
  password: string
  email: string
  full_name: string
}
export interface RegisterResponse {
  user_id: string
  username: string
  email: string
  full_name: string
  role: string
}

// Mappings
export interface StoreItemMapping { store_id: string; item_id: string }
export interface DCItemMapping { dc_id: string; item_id: string }
export interface SupplierItemMapping { supplier_id: string; item_id: string }
export interface StoreToDCMapping { from_store_id: string; to_dc_id: string; mapping_type: string }
export interface DCToNodeMapping { from_dc_id: string; to_node_id: string; mapping_type: string }
export interface MappingsResponse {
  store_items: StoreItemMapping[]
  dc_items: DCItemMapping[]
  supplier_items: SupplierItemMapping[]
  store_mappings: StoreToDCMapping[]
  dc_mappings: DCToNodeMapping[]
}

// Promos
export interface Promo {
  promo_id: string
  promo_name: string
  start_date: string
  end_date: string
  demand_multiplier: number
  promo_group_name: string
  item_ids: string[]
}

// Scenario validate
export interface ScenarioValidateRequest {
  scenario_yaml: string
  start_date: string
  end_date: string
}
export interface PromoWindow {
  promo_id: string
  promo_name: string
  window_start: string
  window_end: string
  factor: number
  item_ids: string[]
  store_ids: string[]
}
export interface ScenarioValidateResponse {
  valid: boolean
  scenario_type: 'promo_forecast' | 'hidden_lost_sales'
  preview: unknown[]
  warnings: string[]
  promo_windows: PromoWindow[]
}

// Retailers
export interface RetailerAccount {
  retailer_account_id: string
  retailer_account_code: string
  retailer_account_name: string
  retailer_account_type?: string
  country_code: string | null
  currency_code: string
  is_active: boolean
  role: string
  joined_at: string
}
export interface CreateAccountRequest {
  retailer_account_code: string
  retailer_account_name: string
  country_code?: string
  currency_code?: string
}

// Entities
export interface Item {
  item_id: string
  item_code: string
  item_description: string
}
export interface Store {
  store_id: string
  store_code: string
  store_name: string
}
export interface DC {
  dc_id: string
  dc_code: string
  dc_name: string
  dc_role: string
}
export interface Supplier {
  supplier_id: string
  supplier_code: string
  supplier_name: string
}
export interface EntitiesResponse {
  items: Item[]
  stores: Store[]
  dcs: DC[]
  suppliers: Supplier[]
}

// Demand
export interface DemandGenerateRequest {
  retailer_account_id: string
  start_date: string
  end_date: string
  seed: number
  force_regenerate?: boolean
}
export interface DemandJobResponse {
  job_id: string
  retailer_account_id: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED'
  message: string | null
  demand_rows: number | null
  start_week: string
  end_week: string
  seed: number
  created_at: string
  updated_at: string
}

// Simulation
export interface RunYamlResponse {
  simulation_id: string
  status: string
}
export interface RunConfig {
  simulation_id: string
  retailer_account_id: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED'
  simulation_granularity: string
  full_config: Record<string, unknown> | null
}
export interface SimulationRun {
  simulation_id: string
  simulation_name: string
  simulation_status: 'RUNNING' | 'COMPLETED' | 'FAILED'
  created_at: string
  start_week: string
  end_week: string
  random_seed: number
  notes: string
  simulation_granularity: string
}

// Analytics meta
export interface ItemMeta {
  item_id: string
  item_code: string
  item_description: string
  item_name: string
  category: string
  subcategory: string
  velocity_class: string
  unit_price: number
  uom: string
}
export interface StoreMeta {
  store_id: string
  store_code: string
  store_name: string
  region: string
}
export interface DCMeta {
  dc_id: string
  dc_code: string
  dc_name: string
  region: string
  dc_role: string
}
export interface AnalyticsMeta {
  simulation_id: string
  retailer_account_id: string
  items_meta: ItemMeta[]
  stores_meta: StoreMeta[]
  dcs_meta: DCMeta[]
  store_dc_map: Record<string, string>
}

// Analytics data — ClickHouse returns numeric fields as strings
export interface POSRecord {
  store_id: string
  store_code: string
  item_id: string
  item_code: string
  pos_week: string
  demand_qty: string
  sales_qty: string
  lost_sales_qty: string
  sales_amount: string
  is_promo_demand: string
}
export interface StoreInventoryRecord {
  store_id: string
  store_code: string
  item_id: string
  item_code: string
  inventory_week: string
  on_hand_quantity: string
  available_quantity: string
  on_order_quantity: string
  inventory_status: 'AVAILABLE' | 'LOW' | 'ZERO'
}
export interface StoreSalesResponse {
  weekly_pos: POSRecord[]
  store_inventory: StoreInventoryRecord[]
}
export interface ShipmentRecord {
  supplier_dc_id: string
  supplier_dc_code: string
  retailer_dc_id: string
  retailer_dc_code: string
  item_id: string
  item_code: string
  shipment_week: string
  ordered_qty: string
  shipped_qty: string
  fill_rate: string
}
export interface SupplyChainSalesResponse {
  weekly_shipments: ShipmentRecord[]
}
export interface DCInventoryRecord {
  dc_id: string
  dc_code: string
  item_id: string
  item_code: string
  inventory_week: string
  on_hand_quantity: string
  available_quantity: string
  on_order_quantity: string
  inventory_status: 'AVAILABLE' | 'LOW' | 'ZERO'
}
export interface SupplierDCInventoryRecord {
  supplier_dc_id: string
  supplier_dc_code: string
  item_id: string
  item_code: string
  inventory_week: string
  on_hand_quantity: string
  on_order_quantity: string
  inventory_status: 'AVAILABLE' | 'LOW' | 'ZERO'
}
export interface UpstreamInventoryResponse {
  dc_inventory: DCInventoryRecord[]
  supplier_dc_inventory: SupplierDCInventoryRecord[]
}
