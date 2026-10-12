const port = process.argv[2] ?? "9223";
const expression = process.argv[3];
if (!expression) {
  console.error("usage: node scripts/spike/cdp.mjs <port> <js expression>");
  process.exit(1);
}
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) {
  console.error("no page target");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 0;
function send(method, params) {
  const messageId = ++nextId;
  ws.send(JSON.stringify({ id: messageId, method, params }));
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== messageId) return;
      ws.removeEventListener("message", onMessage);
      resolve(data);
    };
    ws.addEventListener("message", onMessage);
  });
}
const evaluated = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log(JSON.stringify(evaluated.result, null, 2));
ws.close();
