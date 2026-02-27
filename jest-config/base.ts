import type { Config } from 'jest'

export const config = {
	collectCoverage: false,
	coverageDirectory: 'coverage',
	coverageProvider: 'v8',
	moduleFileExtensions: ['js', 'ts', 'json'],
	testEnvironment: 'jsdom',
	bail: true,
} as const satisfies Config
