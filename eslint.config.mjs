import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  ts.configs.recommended,
);
