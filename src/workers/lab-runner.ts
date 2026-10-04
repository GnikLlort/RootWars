/**
 * RootWars lab runner.
 *
 * Public entry point used by the durable outbox worker (`lab_scan` jobs) and by
 * lab policy checks. Real tool execution is delegated to the Docker lab backend,
 * which fails closed when no isolated lab endpoint is available.
 */

import { getConfig, type LabRuntimeConfig } from '../server/config.js';
import {
  LAB_ISOLATION_MODE,
  LAB_UNAVAILABLE_MODE,
  buildSanitizedScanArgs,
  getLabBackendStatus,
  parseNmapOutputPorts,
  resetLabBackendStatusCache,
  runDockerLabScan,
  sanitizeLabServices,
  validateLabToolRequest,
  type DiscoveredPort,
  type LabBackendStatus,
  type LabIsolationMode,
  type LabScanRequest,
  type LabScanResult,
  type LabServiceSpec
} from './lab-docker-backend.js';

export type { DiscoveredPort, LabBackendStatus, LabIsolationMode, LabScanRequest, LabScanResult, LabServiceSpec };
export {
  LAB_ISOLATION_MODE,
  LAB_UNAVAILABLE_MODE,
  buildSanitizedScanArgs,
  getLabBackendStatus,
  parseNmapOutputPorts,
  resetLabBackendStatusCache,
  sanitizeLabServices,
  validateLabToolRequest
};

export interface LabAvailabilityReport extends LabBackendStatus {
  /** Human readable summary suitable for logs and operator-facing terminal output. */
  summary: string;
}

/** Reports whether real isolated lab scanning is possible in this environment. */
export async function getLabAvailability(): Promise<LabAvailabilityReport> {
  const config = getConfig();
  const status = await getLabBackendStatus(config.lab);
  return {
    ...status,
    summary: status.available
      ? `Lab backend ready: ${status.nmapVersion} in ${status.scannerImage} on ${status.dockerHost ?? 'default docker context'}`
      : `Lab backend UNAVAILABLE — lab missions fail closed. Reason: ${status.reason}`
  };
}

/**
 * Executes one lab scan against the mission-assigned target.
 *
 * The `LabScanRequest.targetIp` value always originates from the active
 * `lab_sessions` row for the requesting operator; it is re-validated here against
 * the RootWars lab CIDR and against `assignedTargetIp`, so a user-supplied
 * address can never reach the scanner.
 */
export async function executeIsolatedLabScan(req: LabScanRequest): Promise<LabScanResult> {
  const config = getConfig();
  return runDockerLabScan(config.lab, req);
}

/** Convenience accessor so callers can surface the effective lab configuration. */
export function getLabRuntimeConfig(): LabRuntimeConfig {
  return getConfig().lab;
}
