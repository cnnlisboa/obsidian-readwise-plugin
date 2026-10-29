/** `@type` {import('ts-jest').JestConfigWithTsJest} */

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  modulePaths: ['<rootDir>/src'],  // mirrors tsconfig baseUrl
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'CommonJS',      // override ESNext → CJS for Jest
        moduleResolution: 'node', // match CommonJS resolution
        esModuleInterop: true,
      }
    }],
    // Also transform .js files from ESM-only node_modules
    '^.+\\.js$': 'babel-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(filenamify|filename-reserved-regex|strip-outer|trim-repeated))',
  ],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    '^obsidian$': '<rootDir>/src/test/__mocks__/obsidian.ts',
    '^filenamify$': '<rootDir>/src/test/__mocks__/filenamify.ts',
    '^filenamify/browser$': '<rootDir>/src/test/__mocks__/filenamify.ts',
  }
};
