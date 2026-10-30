import { resolve } from 'node:path'
import { verifyTrackedMarketDependencyDirection } from './market-dependency-direction.mjs'

const root = resolve(import.meta.dirname, '..')
const result = verifyTrackedMarketDependencyDirection(root)

process.stdout.write(
  `verify-market-dependency-direction: ${String(result.fileCount)} tracked source files respect the market dependency direction ` +
  `(market sources independent of Desktop implementation; Desktop sources independent of market-server); ` +
  `${String(result.wrapperFileCount)} market wrapper files carry no registry bypass of the signed manifest ` +
  `(no runExternalMarketPluginInstall / --registry / --prefer-offline); ` +
  `note: this guard verifies import specifiers only -- runtime filesystem cross-reads are not covered ` +
  `(e.g. dsh-plugin-huaanwork/tests/package.spec.ts readFileSync of scripts/expected-root-gate-scripts.json; ` +
  `reading shared root fixtures that way is an in-repo convention covered by each fixture's own guard) and are guarded separately\n`,
)
