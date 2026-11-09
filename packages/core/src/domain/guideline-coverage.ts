/** Coverage is independent of RunState. No URL-count or finding-count inference. */
import catalogJson from '../../../../docs/generated/guideline-catalog.json' with { type: 'json' };
import {
  domainError, hashStable, GuidelineExecutionStatuses, GuidelineAssessments,
  type GuidelineCoverageRoute, type GuidelineRouteSnapshot, type GuidelineCoveragePlan,
  type GuidelineItemExecution, type GuidelineRunCoverage, type GuidelineCoverageForecast,
} from '@scopepilot2/contracts';

export function snapshotGuidelineRoute(route: GuidelineCoverageRoute, label = route.itemId): GuidelineRouteSnapshot {
  return immutable({
    catalog: route.catalog, guidelineId: route.guidelineId, itemId: route.itemId,
    routeId: route.routeId, assertionIds: route.assertionIds,
    evidenceRequirements: route.evidenceRequirements, guarantee: route.guarantee,
    completionPolicy: route.completionPolicy, limitationCodes: route.limitationCodes,
    routeHash: hashStable('scopepilot2.guideline-route.v1', route), label,
  });
}

function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(node: unknown): void {
    if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(freeze); Object.freeze(node);
    }
  }
  freeze(copy); return copy;
}

/** Aggregate required routes (or assertions within a route) without turning missing work into pass. */
export function aggregateGuidelineAssessment(
  policy: GuidelineCoverageRoute['completionPolicy'],
  executions: readonly GuidelineItemExecution[],
  expectedCount = executions.length,
): GuidelineItemExecution['assessment'] {
  if (executions.some((e) => e.assessment === 'fail')) return 'fail';
  if (executions.length === 0) return 'not-assessed';
  const completed = executions.filter((e) => e.executionStatus === 'completed');
  if (completed.length === 0) return 'not-assessed';
  if (policy === 'any' && completed.some((e) => e.assessment === 'pass')) return 'pass';
  if (executions.length !== expectedCount || completed.length !== executions.length) return 'inconclusive';
  if (completed.every((e) => e.assessment === 'not-applicable')) return 'not-applicable';
  if (completed.every((e) => e.assessment === 'pass' || e.assessment === 'not-applicable')) return 'pass';
  return 'inconclusive';
}

/** Explicit input/capability resolutions are provided by the planner, never guessed from catalog prose. */
export class GuidelineCoverageService {
  private readonly routes: readonly GuidelineCoverageRoute[];
  private readonly runs = new Map<string, GuidelineRunCoverage>();
  constructor(routes: readonly GuidelineCoverageRoute[]) { this.routes = immutable(routes); }

  plan(input: Omit<GuidelineCoveragePlan, 'snapshots'>): GuidelineCoveragePlan {
    const selectedItems = [...new Map(input.selectedItems.map((item) => [JSON.stringify([item.guidelineId, item.itemId]), item])).values()]
      .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
    const snapshots = selectedItems.flatMap((item) => {
      const routes = this.routes.filter((r) => r.guidelineId === item.guidelineId && r.itemId === item.itemId);
      if (routes.length === 0) throw domainError('ValidationFailed', `Unknown guideline item ${item.guidelineId}/${item.itemId}`);
      return routes.map((r) => snapshotGuidelineRoute(r));
    }).sort((a, b) => a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0);
    return immutable({
      selectedItems, snapshots,
      inputResolution: input.inputResolution.map((resolution) => ({
        ...resolution, resolvedInputRefs: [...new Set(resolution.resolvedInputRefs)].sort(),
        missingInputCodes: [...new Set(resolution.missingInputCodes)].sort(),
      })).sort((a, b) => a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0),
      capabilities: [...input.capabilities].sort((a, b) => a.engineKind < b.engineKind ? -1 : a.engineKind > b.engineKind ? 1 : 0),
    });
  }

  planForObservedTargets(guidelineIds: readonly string[], targetRefs: readonly string[], capabilities: GuidelineCoveragePlan['capabilities']): GuidelineCoveragePlan {
    const selectedItems = this.itemsForGuidelines(guidelineIds);
    const plan = this.plan({ selectedItems, inputResolution: [], capabilities });
    return this.plan({ selectedItems, capabilities, inputResolution: plan.snapshots.map((s) => ({
      routeId: s.routeId, resolvedInputRefs: [...targetRefs],
      missingInputCodes: targetRefs.length === 0 && s.guarantee !== 'Unsupported' ? ['OBSERVED_HTTP_TARGETS_REQUIRED'] : [],
    })) });
  }

  itemsForGuidelines(guidelineIds: readonly string[]): GuidelineCoveragePlan['selectedItems'] {
    const canonicalIds = guidelineIds.map((id) => id === 'IPA/NISC/WebAppPentestGuidelines' ? 'WebAppPentestGuidelines v1.2' : id);
    return [...new Map(this.routes.filter((r) => canonicalIds.includes(r.guidelineId)).map((r) => [JSON.stringify([r.guidelineId, r.itemId]), { guidelineId: r.guidelineId, itemId: r.itemId }])).values()];
  }

  forecast(guidelineId: string, plan?: GuidelineCoveragePlan): GuidelineCoverageForecast {
    guidelineId = guidelineId === 'IPA/NISC/WebAppPentestGuidelines' ? 'WebAppPentestGuidelines v1.2' : guidelineId;
    const routes = this.routes.filter((r) => r.guidelineId === guidelineId);
    if (routes.length === 0) throw domainError('ValidationFailed', `Unknown guideline ${guidelineId}`);
    return immutable({ guidelineId, items: [...new Set(routes.map((r) => r.itemId))].map((itemId) => {
      const snapshots = routes.filter((r) => r.itemId === itemId).map((r) => snapshotGuidelineRoute(r));
      const missingInputCodes = [...new Set(snapshots.flatMap((s) => this.initialExecution('', s, plan).missingInputCodes))];
      const states = snapshots.map((s) => this.initialExecution('', s, plan).executionStatus);
      const selected = plan === undefined || plan.selectedItems.some((i) => i.guidelineId === guidelineId && i.itemId === itemId);
      const executionStatus = !selected ? 'not-planned' : states.includes('unavailable') ? 'unavailable' : states.includes('needs-input') ? 'needs-input' : 'queued';
      return { itemId, routes: snapshots, executionStatus, missingInputCodes };
    }) });
  }

  startRun(runId: string, plan: GuidelineCoveragePlan): GuidelineRunCoverage {
    if (this.runs.has(runId)) throw domainError('Conflict', `Coverage snapshot already exists for ${runId}`);
    const expected = this.plan(plan);
    if (hashStable('coverage-snapshots', expected.snapshots) !== hashStable('coverage-snapshots', plan.snapshots)) {
      throw domainError('Conflict', 'Coverage routes changed; rebuild and confirm the plan');
    }
    const executions = plan.snapshots.map((s) => this.initialExecution(runId, s, plan));
    const value = immutable({ runId, snapshots: plan.snapshots, executions, items: assessGuidelineItems(plan.snapshots, executions) });
    this.runs.set(runId, value); return value;
  }

  recordExecution(execution: GuidelineItemExecution): GuidelineRunCoverage {
    const run = this.getRun(execution.runId);
    const snapshot = run.snapshots.find((s) => s.routeId === execution.routeId && s.itemId === execution.itemId);
    if (snapshot === undefined || snapshot.guarantee !== execution.guarantee) throw domainError('ValidationFailed', 'Execution does not match run snapshot');
    if (!GuidelineExecutionStatuses.includes(execution.executionStatus) || !GuidelineAssessments.includes(execution.assessment)) throw domainError('ValidationFailed', 'Invalid execution/assessment');
    if (execution.executionStatus !== 'completed' && execution.assessment !== 'not-assessed') throw domainError('ValidationFailed', 'Incomplete execution must remain not-assessed');
    if (snapshot.guarantee === 'Unsupported' && execution.executionStatus !== 'unavailable') throw domainError('ValidationFailed', 'Unsupported route cannot execute');
    if (execution.executionStatus === 'completed' && (execution.missingInputCodes.length > 0 || (snapshot.evidenceRequirements.length > 0 && execution.evidenceRefs.length === 0))) {
      throw domainError('ValidationFailed', 'Completed coverage requires resolved input and evidence');
    }
    const executions = run.executions.map((e) => e.routeId === execution.routeId ? {
      ...execution, limitationCodes: [...new Set([...snapshot.limitationCodes, ...execution.limitationCodes])],
    } : e);
    const value = immutable({ ...run, executions, items: assessGuidelineItems(run.snapshots, executions) });
    this.runs.set(execution.runId, value); return value;
  }

  getRun(runId: string): GuidelineRunCoverage {
    const value = this.runs.get(runId);
    if (value === undefined) throw domainError('ValidationFailed', `No guideline coverage for run ${runId}`);
    return value;
  }

  private initialExecution(runId: string, snapshot: GuidelineRouteSnapshot, plan?: GuidelineCoveragePlan): GuidelineItemExecution {
    const route = this.routes.find((r) => r.routeId === snapshot.routeId)!;
    const resolution = plan?.inputResolution.find((r) => r.routeId === snapshot.routeId);
    const missingInputCodes = resolution === undefined || (route.inputSchemaRefs.length > 0 && resolution.resolvedInputRefs.length === 0)
      ? route.inputSchemaRefs : resolution.missingInputCodes;
    const engineKind = route.routeKind === 'zap-rule' ? 'zap' : route.routeKind === 'nuclei-template' ? 'nuclei' : route.routeKind === 'browser' ? 'playwright' : 'node-http';
    const available = plan?.capabilities.some((c) => c.engineKind === engineKind && c.source === 'measured' && c.guaranteeLevels.preSendScopeEnforcement === route.guarantee) ?? false;
    return {
      runId, itemId: snapshot.itemId, routeId: snapshot.routeId,
      executionStatus: snapshot.guarantee === 'Unsupported' || !available ? 'unavailable' : missingInputCodes.length > 0 ? 'needs-input' : 'queued',
      assessment: 'not-assessed', guarantee: snapshot.guarantee, evidenceRefs: [], missingInputCodes,
      limitationCodes: snapshot.limitationCodes,
    };
  }
}

/** Load the generated bundle, not the source workbook. */
export function bundledGuidelineCoverage(): GuidelineCoverageService {
  const catalog = catalogJson as unknown as { catalogHash: string; coverageRoutes: GuidelineCoverageRoute[] };
  const { catalogHash, ...body } = catalog;
  if (hashStable('scopepilot2.catalog', body) !== catalogHash) throw domainError('ValidationFailed', 'Guideline catalog integrity check failed');
  return new GuidelineCoverageService(catalog.coverageRoutes);
}

export function assessGuidelineItems(snapshots: readonly GuidelineRouteSnapshot[], executions: readonly GuidelineItemExecution[]): GuidelineRunCoverage['items'] {
  const groups = new Map<string, GuidelineRouteSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = JSON.stringify([snapshot.guidelineId, snapshot.itemId]);
    groups.set(key, [...(groups.get(key) ?? []), snapshot]);
  }
  return [...groups.values()].map((routes) => ({
    guidelineId: routes[0]!.guidelineId, itemId: routes[0]!.itemId,
    assessment: aggregateGuidelineAssessment(
      routes.every((r) => r.completionPolicy === 'any') ? 'any' : 'all',
      executions.filter((e) => routes.some((r) => r.routeId === e.routeId && r.itemId === e.itemId)), routes.length,
    ),
  }));
}
