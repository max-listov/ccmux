/** Public resident monitoring API. Importing this module never starts a CLI or observer. */
export { VERSION as MONITORING_READER_VERSION } from "./util/version.ts";
export {
  readMonitoringStatus,
  MONITORING_CONFIG_MAX_BYTES, MONITORING_MAX_READERS,
  MONITORING_DEFAULT_TIMEOUT_MS, MONITORING_MAX_TIMEOUT_MS,
  type MonitoringReadOptions,
} from "./monitoring/native-read.ts";
export {
  MonitoringReadSchema, MonitoringSnapshotSchema, MonitoringRowSchema,
  STATUS_MAX_BYTES, STATUS_MAX_ITEMS, STATUS_MAX_AGE_MS,
  type MonitoringRead, type MonitoringSnapshot, type MonitoringRow,
} from "./monitoring/schema.ts";
