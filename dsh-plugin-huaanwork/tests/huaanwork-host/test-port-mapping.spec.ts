import { expect, test } from 'vitest'

import { PORT_LABEL_PATTERN, testPortMapping } from './test-port-mapping.ts'

const TASK4_NOT_DROPPED = [
  'issue #2: unbound agent automation runs without any project existing',
  'issue #2: unbound script automation runs with the neutral default root as cwd',
  'issue #2: automation bound to a vanished project still fails with the missing-project message',
]

test('legacy loop cases reconcile to 61 rows with a four-state label', () => {
  expect(testPortMapping).toHaveLength(61)
  expect(testPortMapping.filter((row) => row.file === 'loop.test.ts')).toHaveLength(14)
  expect(testPortMapping.filter((row) => row.file === 'automations-host.test.ts')).toHaveLength(41)
  expect(testPortMapping.filter((row) => row.file === 'unified-channel.test.ts')).toHaveLength(6)

  for (const row of testPortMapping) {
    expect(row.label, row.title).toMatch(PORT_LABEL_PATTERN)
    if (row.label !== '裁定不移植') {
      expect(row.evidence.trim(), row.title).not.toBe('')
    }
  }

  for (const title of TASK4_NOT_DROPPED) {
    const row = testPortMapping.find((item) => item.title === title)
    expect(row?.label, title).toBe('Task 4 新增')
    expect(row?.evidence.trim(), title).not.toBe('')
  }
})
