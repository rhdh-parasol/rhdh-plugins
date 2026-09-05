const baseConfig = require('../../.eslintrc.cjs');

module.exports = {
  ...baseConfig,
  overrides: [
    ...(baseConfig.overrides ?? []),
    {
      files: ['demo/*.mjs'],
      env: { node: true, es2022: true },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
  ],
};
