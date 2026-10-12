/* eslint-disable import-x/no-named-as-default-member */

import eslintJs from '@eslint/js';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { importX } from 'eslint-plugin-import-x';
import * as pluginPackageJson from 'eslint-plugin-package-json';
import pluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import * as jsoncEslintParser from 'jsonc-eslint-parser';
import typescriptEslint from 'typescript-eslint';

const config = () =>
    typescriptEslint.config(
        {
            // test/manual scripts need playwright and sit outside every tsconfig
            ignores: ['**/node_modules/**', 'test/fixtures/**', 'test/manual/**'],
        },
        {
            linterOptions: { noInlineConfig: false, reportUnusedDisableDirectives: true },
        },
        eslintJs.configs.recommended,
        importX.flatConfigs.recommended,
        importX.flatConfigs.typescript,
        pluginPrettierRecommended,
        ...typescriptEslint.configs.strict,
        ...typescriptEslint.configs.stylistic,
        {
            rules: {
                'array-callback-return': 'error',
                curly: 'error',
                'no-else-return': 'error',
                'no-loop-func': 'error',
                'no-multi-assign': 'error',
                'no-param-reassign': 'error',
                'no-unneeded-ternary': 'error',
                'prefer-arrow-callback': 'error',
                'prefer-const': 'error',
                'prefer-object-spread': 'error',
                'prefer-template': 'error',

                '@typescript-eslint/ban-ts-comment': 'off',
                '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
                '@typescript-eslint/no-explicit-any': 'off',
                '@typescript-eslint/no-inferrable-types': 'off',
                '@typescript-eslint/no-unused-vars': [
                    'warn',
                    {
                        argsIgnorePattern: '^_',
                        caughtErrorsIgnorePattern: '^_',
                        ignoreRestSiblings: true,
                        varsIgnorePattern: '^_',
                    },
                ],
                '@typescript-eslint/prefer-for-of': 'off',

                'import-x/order': [
                    'error',
                    {
                        alphabetize: { caseInsensitive: true, order: 'asc', orderImportKind: 'asc' },
                        groups: ['builtin', 'external', 'internal', 'unknown', 'parent', 'sibling', 'index', 'object'],
                        named: true,
                        'newlines-between': 'always',
                        warnOnUnassignedImports: true,
                    },
                ],
            },
            languageOptions: { globals: globals.node },
            settings: {
                'import-x/resolver-next': [
                    createTypeScriptImportResolver({ alwaysTryTypes: true, project: 'tsconfig*json' }),
                ],
            },
        },
        ...typeInformationConfig,
        ...browserConfig,
        ...typescriptDeclarationFilesConfig,
        ...packageJsonConfig,
    );

const typeInformationConfig = typescriptEslint.config({
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    languageOptions: {
        parser: typescriptEslint.parser,
        parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/dot-notation': 'error',
    },
});

// the viewer's scripts and the 3d template a page inlines run in the browser, outside any tsconfig
const browserConfig = typescriptEslint.config({
    files: ['web/**/*.js', 'skills/*/template/**/*.mjs'],
    extends: [typescriptEslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.browser, parserOptions: { projectService: false } },

    // the template's engine imports resolve through the page's import map, and /_frame/ through the daemon
    rules: { 'import-x/no-unresolved': ['error', { ignore: ['^playcanvas', '^/_frame/'] }] },
});

const typescriptDeclarationFilesConfig = typescriptEslint.config({
    files: ['**/*.d.ts'],
    rules: {
        '@typescript-eslint/consistent-type-definitions': 'off',
        '@typescript-eslint/no-empty-object-type': 'off',
    },
});

const packageJsonConfig = typescriptEslint.config({
    files: ['**/package.json', '**/package-lock.json'],
    languageOptions: { parser: jsoncEslintParser },
    plugins: { 'package-json': pluginPackageJson },
    rules: pluginPackageJson.configs.recommended.rules,
});

export default config();
