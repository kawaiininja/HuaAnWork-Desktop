// Fixture skill script: echoes args, can dump env, emit a large payload, or fail.
const args = JSON.parse(process.env.AGENT_SCRIPT_ARGS ?? '{}')

if (args.fail === true) {
  process.stderr.write('script-boom: 技能脚本按参数失败\n')
  process.exit(1)
}

if (args.env === true) {
  process.stdout.write(JSON.stringify({ env: Object.keys(process.env) }))
  process.exit(0)
}

if (typeof args.bytes === 'number') {
  process.stdout.write('x'.repeat(args.bytes))
  process.exit(0)
}

process.stdout.write(JSON.stringify({
  args,
  stateDir: process.env.AGENT_STATE_DIR,
  workspace: process.env.AGENT_WORKSPACE,
  cwd: process.cwd(),
}))
