import type { Linter } from 'eslint';
import prettier from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Perfectionist's own option types are not exported per-rule, so the shared
// fragments below are typed as plain rule entries.
type RuleEntry = Linter.RuleEntry;

// Extension point (unused on purpose): a discriminated union sorts badly under
// a plain natural sort, because the discriminant key belongs first rather than
// alphabetically. This builds the per-shape override that pins it there.
const makeDiscriminatedUnionRule = (key: string, restKeys: string[]) => ({
  customGroups: { unionKey: `^${key}$` },
  groups: ['unionKey', 'unknown'],
  type: 'natural',
  useConfigurationIf: {
    allNamesMatchPattern: `^(${[key, ...restKeys].join('|')})$`,
  },
});

const sortObjectLikeConfigBase = [
  'error',
  // NOTE(secondfry): discriminated union rules can be added here as needed
  // makeDiscriminatedUnionRule('input', ['crlfDelay']),
] as const;

const sortObjectLikeConfig: RuleEntry = [
  ...sortObjectLikeConfigBase,
  { groups: ['property', 'method', 'unknown'], type: 'natural' },
];

const sortObjectTypesConfig: RuleEntry = [
  ...sortObjectLikeConfigBase,
  { groups: ['unknown', 'index-signature'], type: 'natural' },
];

// The no-restricted-syntax selectors are named rather than inlined because
// ESLint severity is per-rule, not per-selector: overriding one of them means
// restating the whole rule, and a named fragment keeps that from duplicating
// the selectors it is not touching.
const testFileExtensionSelector = {
  message:
    'Test files must use .spec.ts extension, not .test.ts. Use filename.spec.ts instead.',
  selector:
    'Program[sourceFile.fileName=/\\.test\\.ts$/]:not([sourceFile.fileName=/node_modules/])',
};

const inlineExportSelector = {
  message:
    'Inline exports are not allowed. Group all exports at the bottom of the file using export { ... } statements.',
  selector: 'ExportNamedDeclaration[declaration!=null]',
};

const functionDeclarationSelector = {
  message: 'Use arrow functions instead of function declarations.',
  selector: 'FunctionDeclaration:not([generator=true])',
};

const functionExpressionSelector = {
  message:
    'Use arrow functions instead of function expressions. Method shorthands, accessors and generators are exempt.',
  // Accessors are marked `method: false, kind: 'get' | 'set'` in ESTree, so the
  // method-shorthand exemption does not cover them — and a getter has no arrow
  // form at all, so matching one would be an unsatisfiable report.
  selector:
    ":not(MethodDefinition, Property[method=true], Property[kind='get'], Property[kind='set']) > FunctionExpression:not([generator=true])",
};

const config = defineConfig(
  {
    ignores: ['.claude/**', 'dist/**', 'node_modules/**'],
  },

  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  perfectionist.configs['recommended-natural'],

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      'no-restricted-exports': [
        'error',
        { restrictDefaultExports: { direct: true } },
      ],

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*', '../**'],
              message:
                'Imports from parent directories (..) are not allowed. Use absolute imports instead.',
            },
            {
              group: [
                '**/utils',
                '**/utils/**',
                '$features/utils',
                '$features/utils/**',
              ],
              message:
                '"utils" is a forbidden directory name. Place code in a feature module or a more descriptive location.',
            },
            {
              group: [
                '**/helpers',
                '**/helpers/**',
                '$features/helpers',
                '$features/helpers/**',
              ],
              message:
                '"helpers" is a forbidden directory name. Place code in a feature module or a more descriptive location.',
            },
          ],
        },
      ],

      'no-restricted-syntax': [
        'error',
        testFileExtensionSelector,
        inlineExportSelector,
        functionDeclarationSelector,
        functionExpressionSelector,
      ],

      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            ['side-effect-style', 'style'],
            'builtin',
            'external',
            ['tsconfig-path', 'internal'],
            'sibling',
            'unknown',
          ],
          newlinesBetween: 1,
          sortSideEffects: true,
          tsconfig: { rootDir: '.' },
        },
      ],
      'perfectionist/sort-interfaces': sortObjectTypesConfig,
      'perfectionist/sort-intersection-types': [
        'error',
        { groups: ['unknown', 'nullish'], type: 'natural' },
      ],
      'perfectionist/sort-modules': ['off'],
      'perfectionist/sort-object-types': sortObjectTypesConfig,
      'perfectionist/sort-objects': sortObjectLikeConfig,
      'perfectionist/sort-union-types': [
        'error',
        { groups: ['unknown', 'nullish'], type: 'natural' },
      ],
    },
  },

  // manifest.config.ts is imported by vite.config.ts, which Vite loads through
  // a bare esbuild bundle that applies neither tsconfig paths nor any plugin.
  // So this one module cannot use aliases, and the version it reads genuinely
  // lives at the repo root, outside every alias root.
  {
    files: ['src/manifest.config.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Build and lint configuration files are consumed by tools that require a
  // default export; the project's own ban on default exports cannot apply.
  {
    files: ['eslint.config.ts', 'vite.config.ts'],
    rules: {
      'no-restricted-exports': 'off',
    },
  },

  // TEMPORARY — see docs/TODO.md.
  //
  // recommendedTypeChecked reports ~78 pre-existing findings that predate this
  // config: `any` leaking out of DOM lookups and message responses, promises
  // passed to addEventListener, unawaited fire-and-forget calls. Every one of
  // them wants a real fix at the call site — the project bans type assertions
  // precisely so these cannot be papered over — and doing that here would bury
  // the config change under an unrelated refactor. They stay visible as
  // warnings until they are fixed for real, one area at a time.
  {
    rules: {
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/require-await': 'warn',
    },
  },
);

export default config;
export { makeDiscriminatedUnionRule };
