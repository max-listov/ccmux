/** Public resident monitoring API. Importing this module never starts a CLI or observer. */

export {
  MONITORING_CONFIG_MAX_BYTES,
  MONITORING_DEFAULT_TIMEOUT_MS,
  MONITORING_MAX_READERS,
  MONITORING_MAX_TIMEOUT_MS,
  type MonitoringReadOptions,
  readMonitoringStatus,
} from './monitoring/native-read.ts';
export {
  type MonitoringRead,
  MonitoringReadSchema,
  type MonitoringRow,
  MonitoringRowSchema,
  type MonitoringSnapshot,
  MonitoringSnapshotSchema,
  STATUS_MAX_AGE_MS,
  STATUS_MAX_BYTES,
  STATUS_MAX_ITEMS,
} from './monitoring/schema.ts';
export { VERSION as MONITORING_READER_VERSION } from './util/version.ts';
