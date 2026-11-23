import { defineConfig } from 'tsdown'

export default defineConfig([
	{
		entry: { index: 'src/index.ts' },
		outDir: 'lib',
		format: 'esm',
		fixedExtension: false,
		platform: 'node',
		target: 'es2024',
		dts: true,
		clean: true,
		// Host services resolve from the running harness at runtime.
		deps: { neverBundle: [/^@deepseek-ai\//] },
	},
])
