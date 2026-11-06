import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// App rules: colours come from @outfitly/ui-tokens, and every visible or spoken word from i18n.
const NO_COLOUR = 'No hard-coded colours: use the theme (useColors) from @outfitly/ui-tokens.';
const NO_RAW_TEXT = 'No raw text: use t() with a key in src/i18n/en.json.';
const COLOR_PROPS =
  '^(?:color|backgroundColor|border\\w*Color|tintColor|shadowColor|textDecorationColor|overlayColor)$';
const TEXT_PROPS = '^(?:accessibilityLabel|accessibilityHint|placeholder|title|label|alt)$';

export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/build/',
    '**/.next/',
    '**/.expo/',
    '**/.turbo/',
    '**/coverage/',
    // Python's packages (torch ships some JavaScript) and the model files.
    '**/.venv/',
    'services/embedder/models/',
  ]),
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
      // The app's WebCrypto shim only does SHA-256 (src/lib/web-crypto.ts).
      'no-restricted-properties': [
        'error',
        { property: 'getClaims', message: 'Not available in the app (see src/lib/web-crypto.ts).' },
      ],
      'no-restricted-syntax': [
        'error',
        ...[
          'Literal[value=/^#(?:[0-9a-fA-F]{3,4}){1,2}$/]',
          'Literal[value=/^(?:rgb|hsl)a?\\(/]',
          `Property[key.name=/${COLOR_PROPS}/] > Literal:not([value='transparent'])`,
        ].map((selector) => ({ selector, message: NO_COLOUR })),
        ...[
          'JSXText[value=/\\S/]',
          'JSXElement > JSXExpressionContainer > Literal[value=/\\S/]',
          'JSXElement > JSXExpressionContainer > TemplateLiteral',
          `JSXAttribute[name.name=/${TEXT_PROPS}/] > Literal`,
          `JSXAttribute[name.name=/${TEXT_PROPS}/] > JSXExpressionContainer > Literal`,
          `JSXAttribute[name.name=/${TEXT_PROPS}/] > JSXExpressionContainer > TemplateLiteral`,
        ].map((selector) => ({ selector, message: NO_RAW_TEXT })),
      ],
    },
  },
  prettier,
);
