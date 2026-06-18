// ─────────────────────────────────────────────────────────────────────────────
// Auth  (engine: POST /auth/login, /auth/register, /auth/refresh)
// ─────────────────────────────────────────────────────────────────────────────
export interface LoginRequest { username: string; password: string }
export interface LoginResponse {
  access_token: string
  token_type: string
  refresh_token: string
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
export interface RefreshRequest { refresh_token: string }
export interface AccessTokenResponse {
  access_token: string
  token_type: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Retailers  (engine: GET /retailers, POST /retailers)
// ─────────────────────────────────────────────────────────────────────────────
export interface RetailerAccount {
  retailer_account_id: string
  retailer_account_code: string
  retailer_account_name: string
  country_code: string | null
  currency_code: string
  is_active: boolean
  role?: string
  joined_at?: string
}
export interface CreateRetailerRequest {
  retailer_account_code: string
  retailer_account_name: string
  country_code?: string
  currency_code?: string
}
export interface CreateRetailerResponse {
  retailer_account_id: string
  retailer_account_code: string
  retailer_account_name: string
  country_code: string | null
  currency_code: string
  is_active: boolean
}
export interface CreateRetailerResponse {
  retailer_account_id: string
  retailer_account_code: string
  retailer_account_name: string
  country_code: string | null
  currency_code: string
  is_active: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Demand  (engine: POST /demand/generate, GET /demand/status/{job_id})
// ─────────────────────────────────────────────────────────────────────────────
export interface DemandGenerateRequest {
  retailer_account_id: string
  start_date: string
  end_date: string
  seed: number
}
export interface DemandGenerateResponse {
  job_id: string
  status: string
}
export interface DemandJobResponse {
  job_id: string
  retailer_account_id: string
  status: string
  message: string | null
  demand_rows: number | null
  start_week: string | null
  end_week: string | null
  seed: number | null
  created_at: string | null
  updated_at: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulations  (engine: POST /simulate, GET /runs, GET /run-config/{id})
// ─────────────────────────────────────────────────────────────────────────────
export interface SimulationSummary {
  weekly_pos: Array<{
    pos_week: string
    demand_qty: number
    sales_qty: number
    stockout_qty: number
    sales_amount: number
  }>
  store_inventory: Array<{
    inventory_week: string
    on_hand_quantity: number
    available_quantity: number
    on_order_quantity: number
  }>
  weekly_shipments: Array<{
    shipment_week: string
    ordered_qty: number
    shipped_qty: number
    avg_fill_rate: number
  }>
  dc_inventory: Array<{
    inventory_week: string
    on_hand_quantity: number
    available_quantity: number
    on_order_quantity: number
  }>
  supplier_dc_inventory: Array<{
    inventory_week: string
    on_hand_quantity: number
    on_order_quantity: number
  }>
}

// GET /simulate/preview
export interface PromoPreviewItem {
  promo_id: string
  promo_name: string
  event_type: string
  start_date: string
  end_date: string
  demand_multiplier: number
  store_count: number
  item_count: number
}

export interface SimulatePreviewResponse {
  retailer_account_id: string
  start_date: string
  end_date: string
  total_promos: number
  active_promos: number
  total_promo_groups: number
  promos: PromoPreviewItem[]
  excluded_promos: PromoPreviewItem[]
}

// POST /simulate → SimulateSyncResponse
export interface RunYamlResponse {
  simulation_id: string
  status: string
  simulation_elapsed_seconds: number
  summary?: SimulationSummary
}

// GET /runs → RunSummaryItem[]
export interface SimulationRun {
  simulation_id: string
  simulation_name: string
  simulation_status: string
  created_at: string
  start_week: string
  end_week: string
  random_seed: number
  notes: string
  simulation_granularity: string
  scenario_type?: string  // 'no_scenario' when no scenario was applied
  is_extended: boolean
  extension_count: number
}

// GET /simulation/{id}/extensions
export interface SimulationExtensionRecord {
  id: string
  simulation_id: string
  extension_number: number
  previous_end_week: string
  new_end_week: string
  scenario_type: string
  scenario_name: string
  promo_config: string
  scenario_config: string
  status: string
  created_at: string
  created_by: string | null
}

// POST /simulation/{id}/extend
export interface ExtendSimulationPayload {
  extension_end_date: string   // YYYY-MM-DD
  simulation_name?: string
  notes?: string
  promo_yaml?: string
  scenario_yaml?: string
  seed?: number
  session_id?: string
}

// POST /simulation/{id}/extension-promos
export interface ExtensionPromoInput {
  promo_id?: string
  promo_name: string
  promo_group_name: string
  event_type: string
  start_date: string   // YYYY-MM-DD
  end_date: string     // YYYY-MM-DD
  demand_multiplier: number
  is_disabled: boolean
}

export interface SaveExtensionPromosResponse {
  session_id: string
  saved: number
}

// POST /demand/generate/extend
export interface GenerateExtensionDemandRequest {
  session_id: string
  simulation_id: string
  retailer_account_id: string
  start_date: string   // YYYY-MM-DD
  end_date: string     // YYYY-MM-DD
  seed: number
}

// GET /simulation/{id}/ending-inventory
export interface EndingInventoryRecord {
  entity_id: string
  entity_code: string
  item_id: string
  item_code: string
  on_hand_quantity: number
  on_order_quantity: number
}
export interface EndingInventoryResponse {
  simulation_id: string
  base_end_week: string
  store_inventory: EndingInventoryRecord[]
  dc_inventory: EndingInventoryRecord[]
  supplier_dc_inventory: EndingInventoryRecord[]
}

// GET /run-config/{simulation_id} → RunConfigResponse
export interface RunConfig {
  simulation_id: string
  retailer_account_id: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED'
  simulation_granularity: string
  full_config: Record<string, unknown> | null
  end_week: string | null
  start_week: string | null
  is_extended: boolean
  extension_count: number
}

// GET /simulation/{simulation_id} — full ClickHouse output (untyped, large)
export type FullSimulationOutput = Record<string, unknown[]>

// DELETE /simulation/{simulation_id}
export interface DeleteResponse { deleted: string }

// ─────────────────────────────────────────────────────────────────────────────
// Scenario  (engine: POST /scenario/validate)
// ─────────────────────────────────────────────────────────────────────────────
export interface ScenarioValidateRequest {
  scenario_yaml: string
  retailer_account_id?: string
  start_date?: string
  end_date?: string
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
  scenario_type: string
  preview: unknown[]
  warnings: unknown[]
  promo_windows: unknown[] | null
  disruptions: unknown[] | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics — Meta  (engine: GET /analytics/{id}/meta)
// ─────────────────────────────────────────────────────────────────────────────
export interface ItemMeta {
  item_id: string
  item_code: string
  item_description: string
  uom: string
  unit_price?: number
  category?: string
  subcategory?: string
  brand?: string
  velocity_class?: string
}
export interface StoreMeta {
  store_id: string
  store_code: string
  store_name: string
  region?: string
}
export interface DCMeta {
  dc_id: string
  dc_code: string
  dc_name: string
  dc_role: string
  region?: string
}
export interface AnalyticsMeta {
  simulation_id: string
  retailer_account_id: string
  items_meta: ItemMeta[]
  stores_meta: StoreMeta[]
  dcs_meta: DCMeta[]
  store_dc_map: Record<string, string>
  store_item_map: Record<string, string[]>
  dc_item_map: Record<string, string[]>
  supplier_dc_item_map: Record<string, string[]>
  rdc_to_sdc_map: Record<string, string[]>
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics — Detail rows  (ClickHouse returns numerics as strings)
// engine: /analytics/{id}/store-sales, /supplier-sales, /store-inventory, /dc-inventory
// ─────────────────────────────────────────────────────────────────────────────
export interface POSRecord {
  store_id: string
  store_code: string
  item_id: string
  item_code: string
  pos_week: string
  demand_qty: string
  sales_qty: string
  stockout_qty: string
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
  inventory_status?: string
}
export interface StoreSalesResponse {
  weekly_pos: POSRecord[]
  store_inventory: StoreInventoryRecord[]
}

// /analytics/{id}/supplier-sales (renamed from supply-chain-sales)
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

// /analytics/{id}/dc-inventory (renamed from upstream-inventory)
export interface DCInventoryRecord {
  dc_id: string
  dc_code: string
  item_id: string
  item_code: string
  inventory_week: string
  on_hand_quantity: string
  available_quantity: string
  on_order_quantity: string
  inventory_status?: string
}
export interface SupplierDCInventoryRecord {
  supplier_dc_id: string
  supplier_dc_code: string
  item_id: string
  item_code: string
  inventory_week: string
  on_hand_quantity: string
  on_order_quantity: string
  inventory_status?: string
}
export interface UpstreamInventoryResponse {
  dc_inventory: DCInventoryRecord[]
  supplier_dc_inventory: SupplierDCInventoryRecord[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Promo catalog  (engine: GET /promos, GET /promo-groups)
// ─────────────────────────────────────────────────────────────────────────────
export interface PromoResponse {
  promo_id: string
  promo_name: string
  promo_group_id: string | null
  promo_group_name: string | null
  event_type: string
  start_date: string | null
  end_date: string | null
  demand_multiplier: number
  post_promo_decay_days: number
  post_promo_decay_shape: string
  store_ids: string[]
}

export interface PromoGroupResponse {
  promo_group_id: string
  promo_group_name: string
  category: string
  brand: string
  description: string
  item_ids: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend-only types (not in engine swagger — kept for auth store compat)
// ─────────────────────────────────────────────────────────────────────────────
export interface BackendLoginResponse extends LoginResponse {
  user_id: string
  retailer_account_id: string | null
  full_name: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Entities  (backend: GET /entities)
// ─────────────────────────────────────────────────────────────────────────────
export interface EntityItem { item_id: string; item_code: string; item_description: string }
export interface EntityStore { store_id: string; store_code: string; store_name: string }
export interface EntityDC { dc_id: string; dc_code: string; dc_name: string; dc_role: string }
export interface EntitySupplier { supplier_id: string; supplier_code: string; supplier_name: string }
export interface EntitiesResponse {
  items: EntityItem[]
  stores: EntityStore[]
  dcs: EntityDC[]
  suppliers: EntitySupplier[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappings  (backend: GET/POST /mappings)
// ─────────────────────────────────────────────────────────────────────────────
export interface StoreItemRecord { store_id: string; item_id: string }
export interface DCItemRecord { dc_id: string; item_id: string }
export interface SupplierItemRecord { supplier_id: string; item_id: string }
export interface StoreMappingRecord { from_store_id: string; to_dc_id: string; mapping_type: string }
export interface DCMappingRecord { from_dc_id: string; to_node_id: string; mapping_type: string }
export interface MappingsResponse {
  store_items: StoreItemRecord[]
  dc_items: DCItemRecord[]
  supplier_items: SupplierItemRecord[]
  store_mappings: StoreMappingRecord[]
  dc_mappings: DCMappingRecord[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Promo  (backend: GET /promos)
// ─────────────────────────────────────────────────────────────────────────────
export interface Promo {
  promo_id: string
  promo_name: string
  start_date: string
  end_date: string
  demand_multiplier: number
  promo_group_name: string
  item_ids: string[]
}
