// OmniSight custom ESLint rule — Prisma projection discipline (hardening area 5).
//
// `client.findMany()` without a `select`/`include` projection hydrates EVERY
// column of EVERY matched row — including JSON blob columns (screenshot
// analysis, signals, metadata) and oversized text. Those full-row reads have
// repeatedly been the tail-latency and memory hazard in this codebase (the
// bounded-scope scans that had to be re-introduced with `select` after memory
// pressure).
//
// This rule flags `.findMany()` calls whose argument object omits both `select`
// and `include`. It targets `findMany` ONLY on purpose: `findUnique`/`findFirst`
// without a projection are used deliberately (and pervasively) inside
// transactions where the row is written back in full — enforcing those would
// be noise, not signal.
//
// Severity in eslint.config.mjs is `warn` and scoped to src/** so the rule
// never fails a build while making projection debt visible to reviewers.

const META = {
  type: 'suggestion',
  docs: {
    description: 'Prisma .findMany() should pass a select/include projection to bound row size',
    category: 'Best Practices',
  },
  schema: [],
  messages: {
    missingProjection:
      'Prisma .findMany() without `select` or `include` loads every column of every matched row ' +
      '(JSON/blob columns included). Add a projection to bound row size.',
  },
};

const create = (context) => ({
  CallExpression(node) {
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression') return;
    if (!callee.property || callee.property.type !== 'Identifier') return;
    if (callee.property.name !== 'findMany') return;

    // Prisma delegate calls always receive an object argument; calls with zero
    // args or non-object args are not the Prisma delegate shape being policed.
    if (node.arguments.length === 0) return;
    const arg = node.arguments[0];
    if (!arg || arg.type !== 'ObjectExpression') return;

    const hasProjection = arg.properties.some((p) => {
      if (p.type !== 'Property' || p.computed || !p.key) return false;
      const keyName =
        p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : '';
      return keyName === 'select' || keyName === 'include';
    });
    if (hasProjection) return;

    context.report({ node, messageId: 'missingProjection' });
  },
});

const plugin = {
  meta: { name: 'omnisight-prisma-select', version: '1.0.0' },
  rules: {
    'prisma-select': { meta: META, create },
  },
};

export default plugin;