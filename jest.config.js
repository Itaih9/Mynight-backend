/**
 * Tests run against src/ directly through ts-jest — there is no build step to
 * keep in sync, and tsconfig already keeps *.test.ts out of dist.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Tests type-check against tsconfig.test.json, which adds jest's globals
  // without letting the production build see them.
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }] },
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Mirrors the "@/*" paths in tsconfig.json; without it every module under
  // test fails to resolve its own imports.
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  setupFiles: ['<rootDir>/jest.setup.js'],
};
