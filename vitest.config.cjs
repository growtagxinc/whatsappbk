// @ts-check
/** @type {import('vitest').defineConfig} */
module.exports = {
  test: {
    environment: 'node',
    // ESM-only tests: use .mjs extension to force ES module treatment
    include: ['__tests__/**/*.test.mjs'],
  },
};