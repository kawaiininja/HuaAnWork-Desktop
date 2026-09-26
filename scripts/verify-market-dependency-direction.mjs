import { resolve } from 'node:path'
import { verifyTrackedMarketDependencyDirection } from './market-dependency-direction.mjs'

const root = resolve(import.meta.dirname, '..')
const result = verifyTrackedMarketDependencyDirection(root)

process.stdout.write(
  `verify-market-dependency-direction: ${String(result.fileCount)} tracked source files respect the market dependency direction (market sources independent of Desktop implementation; Desktop sources independent of market-server)\n`,
)
