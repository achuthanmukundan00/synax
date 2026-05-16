/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: './src',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.ts', '!**/__tests__/**'],
  coverageDirectory: '../coverage',
  coveragePathIgnorePatterns: ['/node_modules/', '/__tests__/'],
};
