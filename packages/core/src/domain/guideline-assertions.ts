/** Stable IDs used by the implemented HTTP workflow assertions. */
export const WORKFLOW_SCAN_CHECK_IDS = [
  'security-headers',
  'cookie-security',
  'cors-policy',
  'error-disclosure',
  'dom-source-sink',
  'reflected-input',
  'sql-error',
  'open-redirect',
  'path-traversal',
] as const;
