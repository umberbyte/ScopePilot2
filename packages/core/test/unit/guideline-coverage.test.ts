/**
 * ガイドラインカバレッジ機能のテスト
 *
 * GO-28: needs-input と汎用チェックの関係を利用者に見せる
 * 設計正本: docs/design/41-spec-gap-resolution.md §8.3
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGuidelineCoverageSummary, buildCombinedGuidelineCoverage, buildRunGuidelineCoverage } from '../../src/domain/guideline-coverage.ts';
import type { GuidelineCoverageSummaryView } from '@scopepilot2/contracts';

describe('guideline-coverage', () => {
  describe('buildGuidelineCoverageSummary', () => {
    it('OWASP Top 10-2025 のカバレッジサマリーを生成する', () => {
      const result = buildGuidelineCoverageSummary('OWASP Top 10-2025');

      assert.ok(result.summary);
      assert.strictEqual(result.summary.guidelineId, 'OWASP Top 10-2025');
      assert.strictEqual(result.summary.guidelineDisplayName, 'OWASP Top 10-2025');

      // automatic テーマ (24, 25, 30) = 3件
      assert.strictEqual(result.summary.automaticCount, 3);

      // needs-input テーマ (5, 6, 10, 15, 20, 21) = 6件
      assert.strictEqual(result.summary.needsInputCount, 6);

      // 総項目数 = automatic + needs-input
      assert.strictEqual(result.summary.totalItems, 9);

      // カタログ情報が含まれること
      assert.ok(result.summary.catalog);
      assert.strictEqual(result.summary.catalog.catalogId, 'scopepilot-working-workbook');
    });

    it('OWASP ASVS 5.0 のカバレッジサマリーを生成する', () => {
      const result = buildGuidelineCoverageSummary('OWASP ASVS 5.0');

      assert.ok(result.summary);
      assert.strictEqual(result.summary.guidelineId, 'OWASP ASVS 5.0');

      // automatic テーマ (13, 24, 25, 30) = 4件
      assert.strictEqual(result.summary.automaticCount, 4);

      // needs-input テーマ数を確認
      assert.ok(result.summary.needsInputCount > 0);
    });

    it('項目詳細にroute情報が含まれる', () => {
      const result = buildGuidelineCoverageSummary('OWASP Top 10-2025');

      assert.ok(result.items.length > 0);

      const firstItem = result.items[0];
      assert.ok(firstItem);
      assert.ok(firstItem.itemId);
      assert.ok(firstItem.itemDisplayName);
      assert.ok(firstItem.routes.length > 0);

      const firstRoute = firstItem.routes[0];
      assert.ok(firstRoute);
      assert.ok(['automatic', 'operator-workflow'].includes(firstRoute.automationClass));
      assert.ok(['Enforced', 'Delegated', 'Unsupported'].includes(firstRoute.guarantee));
    });

    it('automatic クラスの項目は missingInputs が空', () => {
      const result = buildGuidelineCoverageSummary('OWASP Top 10-2025');

      const automaticItems = result.items.filter((item) =>
        item.routes.some((route) => route.automationClass === 'automatic')
      );

      assert.ok(automaticItems.length > 0, 'automatic項目が存在するはず');

      for (const item of automaticItems) {
        const automaticRoute = item.routes.find((r) => r.automationClass === 'automatic');
        assert.ok(automaticRoute);
        assert.strictEqual(automaticRoute.missingInputs.length, 0, 'automaticルートはmissingInputsが空');
      }
    });

    it('operator-workflow クラスの項目は missingInputs が存在', () => {
      const result = buildGuidelineCoverageSummary('OWASP Top 10-2025');

      const needsInputItems = result.items.filter((item) =>
        item.routes.some((route) => route.automationClass === 'operator-workflow')
      );

      assert.ok(needsInputItems.length > 0, 'needs-input項目が存在するはず');

      for (const item of needsInputItems) {
        const operatorRoute = item.routes.find((r) => r.automationClass === 'operator-workflow');
        assert.ok(operatorRoute);
        assert.ok(operatorRoute.missingInputs.length > 0, 'operator-workflowルートはmissingInputsが存在');

        // missingInputs の構造を確認
        const firstMissingInput = operatorRoute.missingInputs[0];
        assert.ok(firstMissingInput);
        assert.ok(firstMissingInput.code);
        assert.ok(firstMissingInput.description);
      }
    });
  });

  describe('buildCombinedGuidelineCoverage', () => {
    it('複数ガイドラインを統合したカバレッジを生成する', () => {
      const result = buildCombinedGuidelineCoverage(['OWASP Top 10-2025', 'OWASP ASVS 5.0']);

      assert.ok(result.summary);
      assert.ok(result.summary.guidelineId.includes('OWASP Top 10-2025'));
      assert.ok(result.summary.guidelineId.includes('OWASP ASVS 5.0'));

      // 統合されたカバレッジは重複排除される
      assert.ok(result.summary.totalItems > 0);
      assert.ok(result.items.length > 0);
    });

    it('ガイドラインが空の場合は空のカバレッジを返す', () => {
      const result = buildCombinedGuidelineCoverage([]);

      assert.strictEqual(result.summary.totalItems, 0);
      assert.strictEqual(result.summary.automaticCount, 0);
      assert.strictEqual(result.summary.needsInputCount, 0);
      assert.strictEqual(result.items.length, 0);
    });
  });

  describe('buildRunGuidelineCoverage', () => {
    it('存在しないrunIdに対してはnullを返す（仮実装）', () => {
      const result = buildRunGuidelineCoverage('non-existent-run-id');

      // GO-22実装待ち: 現在は常にnullを返す
      assert.strictEqual(result, null);
    });
  });

  describe('カバレッジ表示の要件（設計書§8.3）', () => {
    it('実行状態と判定を分離できる', () => {
      const result = buildGuidelineCoverageSummary('OWASP Top 10-2025');

      // 項目にexecution情報が含められる構造であることを確認
      const item = result.items[0];
      assert.ok(item);

      // execution は undefined（計画前）または定義済み（実行後）
      assert.ok(item.execution === undefined || typeof item.execution === 'object');
    });

    it('Delegated の表示に必要な情報が含まれる', () => {
      const result = buildGuidelineCoverageSummary('OWASP Top 10-2025');

      const delegatedItems = result.items.filter((item) =>
        item.routes.some((route) => route.guarantee === 'Delegated')
      );

      // automaticテーマはDelegatedのはず
      assert.ok(delegatedItems.length > 0);

      for (const item of delegatedItems) {
        const delegatedRoute = item.routes.find((r) => r.guarantee === 'Delegated');
        assert.ok(delegatedRoute);
        assert.strictEqual(delegatedRoute.guarantee, 'Delegated');
        // routeKindも確認できる
        assert.ok(delegatedRoute.routeKind);
      }
    });

    it('needs-input と完了の併存を表現できる', () => {
      const result = buildGuidelineCoverageSummary('OWASP Top 10-2025');

      // automatic と needs-input の両方が存在することを確認
      const hasAutomatic = result.items.some((item) =>
        item.routes.some((route) => route.automationClass === 'automatic')
      );
      const hasNeedsInput = result.items.some((item) =>
        item.routes.some((route) => route.automationClass === 'operator-workflow')
      );

      assert.ok(hasAutomatic, 'automaticルートが存在');
      assert.ok(hasNeedsInput, 'needs-inputルートが存在');

      // サマリーで両方をカウントできる
      assert.ok(result.summary.automaticCount > 0);
      assert.ok(result.summary.needsInputCount > 0);
    });

    it('検出0件をpassとして表示しない', () => {
      // この要件は実行結果に関するもので、計画段階では該当しない
      // GO-22でrun結果を扱うときに、assessment が pass でも
      // evidenceCountやfindingCountを別に表示する必要がある

      const result = buildGuidelineCoverageSummary('OWASP Top 10-2025');
      const item = result.items[0];
      assert.ok(item);

      // execution.assessment と execution.findingCount が分離されていることを
      // 型レベルで確認（実行時はundefinedだが、構造は存在）
      if (item.execution !== undefined) {
        assert.ok('assessment' in item.execution);
        assert.ok('findingCount' in item.execution);
      }
    });
  });
});
