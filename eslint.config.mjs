import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [{
  files: ['src/**/*.ts', 'src/**/*.tsx', 'lab/**/*.ts', 'tests/**/*.ts'],
  languageOptions: { parser: tsparser },
  plugins: { '@typescript-eslint': tseslint },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error'
  }
}];
