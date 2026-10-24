/** Cross-field rules shared by request validation (create) and the merged state (update). */
export interface ServiceConfigShape {
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
}

export interface RuleIssue {
  path: keyof ServiceConfigShape;
  message: string;
}

export function crossFieldIssues(cfg: ServiceConfigShape): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (cfg.timeoutMs >= cfg.intervalSeconds * 1000) {
    issues.push({
      path: "timeoutMs",
      message: "timeoutMs must be shorter than the check interval",
    });
  }
  if (cfg.expectedStatusMin > cfg.expectedStatusMax) {
    issues.push({
      path: "expectedStatusMin",
      message: "expectedStatusMin must not be greater than expectedStatusMax",
    });
  }
  return issues;
}
