// ESLint flat config: recommended rules for Node ESM code.
import js from '@eslint/js'; // core recommended rules
import globals from 'globals'; // Node global variables

// Lint everything except vendored/tooling folders.
export default [
  { ignores: ['.tools/**', 'node_modules/**', 'data/**', 'test/fixtures/**', '.claude/**'] }, // skipped paths
  js.configs.recommended, // baseline rules
  { languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node } }, // Node ESM
];
