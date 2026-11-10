/** Target automation class is independent of execution status and assessment. */
export type GuidelineAutomationClass =
  | 'automatic'
  | 'conditional-automatic'
  | 'operator-workflow'
  | 'external-fixture'
  | 'unsupported';

/** Additive projection for scan results and reports (GO-28). Contains no secrets. */
export interface GuidelineAutomationDisclosure {
  readonly automationPolicyVersion?: string;
  readonly automationClass?: GuidelineAutomationClass;
  readonly missingInputCodes?: readonly string[];
  readonly limitationCodes?: readonly string[];
}
