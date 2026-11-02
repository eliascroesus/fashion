import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/build/', '**/.next/', '**/.expo/', '**/.turbo/', '**/coverage/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Plain JS config files are not part of any tsconfig.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Metro and other React Native tooling configs are CommonJS.
    files: ['apps/mobile/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['apps/mobile/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#(?:[0-9a-fA-F]{3,4}){1,2}$/]',
          message: 'No hard-coded colours: use the theme (useColors) from @outfitly/ui-tokens.',
        },
        {
          selector: 'Literal[value=/^(?:rgb|hsl)a?\\(/]',
          message: 'No hard-coded colours: use the theme (useColors) from @outfitly/ui-tokens.',
        },
        {
          selector: 'JSXText[value=/\\S/]',
          message: 'No raw text on screen: use t() with a key in src/i18n/en.json.',
        },
      ],
    },
  },
  prettier,
);
