// Holds the Node event loop open until this process is killed.
// The parent passes stdio: 'ignore', so this must not read stdin.
setInterval(() => {}, 2 ** 30)
