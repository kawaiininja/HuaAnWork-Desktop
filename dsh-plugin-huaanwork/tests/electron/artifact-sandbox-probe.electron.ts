/**
 * 真实 Electron renderer 沙箱探针：在隐藏窗口的 srcDoc iframe 中执行内联脚本，
 * 再验证网络、父页面、Node、弹窗、表单、顶层导航与后续文档导航全部被拒。
 *
 * 只请求本机接收端：同一 renderer 的 HTTP/WS control 必须先成功，再清零计数；
 * 每个导航动作按唯一 URL 与固定 frameTreeNodeId 等待真实 preventDefault 记录并核对零请求。
 * 本文件后缀不匹配公共 `tests/**\/*.spec.ts`，只由 vitest.artifact-sandbox.config.ts 启动。
 */
import { expect, it } from "vitest";
import { _electron as electron } from "playwright-core";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import { withArtifactContentSecurity } from "../../src/client-huaanwork/ArtifactHtmlView.tsx";

it(
  "executes inline scripts while denying network and privileged access",
  async () => {
    const mainUrl = new URL("./artifact-sandbox-main.mjs", import.meta.url).href;
    // Electron npm 包运行时 require 返回可执行文件路径，类型声明却是 Electron API。
    const electronPath: unknown = createRequire(import.meta.url)("electron");
    if (typeof electronPath !== "string") throw new Error("electron executable path unavailable");
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    // 只改子进程环境副本：探针必须以真实 renderer 运行，不能落进 Node 模式。
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({
      executablePath: electronPath,
      args: [fileURLToPath(mainUrl)],
      env,
      chromiumSandbox: true,
    });
    let receiver: ReturnType<typeof createServer> | undefined;
    let sockets: WebSocketServer | undefined;
    try {
      const requests: string[] = [];
      const socketRequests: string[] = [];
      receiver = createServer((request, response) => {
        requests.push(request.url ?? "");
        response.setHeader("access-control-allow-origin", "*");
        if (request.url?.startsWith("/redirect")) {
          response.writeHead(302, { location: "/received" });
          response.end();
          return;
        }
        response.setHeader("content-type", "text/html");
        response.end("<!doctype html><body>probe</body>");
      });
      sockets = new WebSocketServer({ server: receiver });
      sockets.on("connection", (socket, request) => {
        socketRequests.push(request.url ?? "");
        socket.send("connected");
      });
      await new Promise<void>((resolve, reject) => {
        receiver!.once("error", reject);
        receiver!.listen(0, "127.0.0.1", resolve);
      });
      const address = receiver.address();
      if (typeof address !== "object" || address === null) throw new Error("probe receiver unavailable");
      const forbiddenUrl = `http://127.0.0.1:${address.port}`;
      const page = await app.firstWindow();
      await page.goto(`${forbiddenUrl}/parent`);
      // control 正例：同一 renderer 的 HTTP 与 WS 都必须真的到达本机接收端。
      await page.evaluate(async (base) => {
        await fetch(`${base}/http-control`);
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws-control`);
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error("renderer websocket control timeout"));
          }, 2000);
          socket.onopen = () => {
            clearTimeout(timer);
            socket.close();
            resolve();
          };
          socket.onerror = () => {
            clearTimeout(timer);
            reject(new Error("renderer websocket control failed"));
          };
        });
      }, forbiddenUrl);
      await expect
        .poll(() => requests.includes("/http-control") && socketRequests.includes("/ws-control"))
        .toBe(true);
      requests.length = 0;
      socketRequests.length = 0;
      const secured = withArtifactContentSecurity("<script>window.ran=true</script>");
      const frameName = "huaanwork-artifact-11111111-1111-4111-8111-111111111111";
      await page.setContent(`<iframe name="${frameName}" sandbox="allow-scripts" src="about:blank"></iframe>`);
      const frameTreeNodeId = await app.evaluate(
        async (_electron, input) => {
          const { guard, artifactFrameId } = await import(input.mainUrl);
          guard.registerEmptyFrame(input.frameName);
          return artifactFrameId(input.frameName);
        },
        { mainUrl, frameName },
      );
      expect(typeof frameTreeNodeId).toBe("number");
      await page.locator("iframe").evaluate((element, content) => {
        element.removeAttribute("src");
        element.setAttribute("srcdoc", content);
      }, secured);
      const frame = page.frames().find((item) => item !== page.mainFrame());
      if (!frame) throw new Error("artifact iframe missing");
      await frame.waitForFunction(() => Reflect.get(window, "ran") === true);
      const result = await frame.evaluate(async (forbiddenUrl) => {
        const rejects = async (run: () => unknown) => {
          try {
            await run();
            return false;
          } catch {
            return true;
          }
        };
        const wsUrl = `${forbiddenUrl.replace("http:", "ws:")}/ws-blocked`;
        const wsEvidence = await new Promise<{ denied: boolean; blockedURI?: string }>((resolve) => {
          let socket: WebSocket | undefined;
          let errorObserved = false;
          let blockedURI: string | undefined;
          const finish = (denied: boolean): void => {
            clearTimeout(timer);
            document.removeEventListener("securitypolicyviolation", onViolation);
            if (socket) {
              socket.onerror = null;
              socket.onopen = null;
              socket.close();
            }
            resolve({ denied, ...(blockedURI === undefined ? {} : { blockedURI }) });
          };
          const settle = (): void => {
            if (errorObserved && blockedURI !== undefined) finish(true);
          };
          const onViolation = (event: SecurityPolicyViolationEvent): void => {
            if (event.effectiveDirective !== "connect-src") return;
            try {
              // 浏览器可裁去路径，按 WS 协议和 origin 匹配，不借用 fetch/XHR 的 HTTP 违规。
              if (new URL(event.blockedURI).origin !== new URL(wsUrl).origin) return;
            } catch {
              return;
            }
            blockedURI = event.blockedURI;
            settle();
          };
          const timer = setTimeout(() => finish(false), 2000);
          document.addEventListener("securitypolicyviolation", onViolation);
          try {
            socket = new WebSocket(wsUrl);
            socket.onerror = () => {
              errorObserved = true;
              settle();
            };
            socket.onopen = () => finish(false);
          } catch (error) {
            errorObserved = error instanceof DOMException && error.name === "SecurityError";
            if (!errorObserved) finish(false);
            else settle();
          }
        });
        const result = {
          requireDenied: typeof require === "undefined",
          processDenied: typeof process === "undefined",
          parentDenied: (() => {
            try {
              void window.parent.location.href;
              return false;
            } catch {
              return true;
            }
          })(),
          openerDenied: window.opener === null,
          popupDenied: window.open(forbiddenUrl) === null,
          fetchDenied: await rejects(() => fetch(forbiddenUrl)),
          xhrDenied: await new Promise<boolean>((resolve) => {
            const request = new XMLHttpRequest();
            const timer = setTimeout(() => resolve(false), 1000);
            request.onerror = () => {
              clearTimeout(timer);
              resolve(true);
            };
            request.onload = () => {
              clearTimeout(timer);
              resolve(false);
            };
            request.open("GET", forbiddenUrl);
            request.send();
          }),
          webSocketDenied: wsEvidence.denied,
          webSocketPolicyObserved: wsEvidence.blockedURI !== undefined,
          webSocketBlockedURI: wsEvidence.blockedURI,
          topNavigationDenied: (() => {
            try {
              window.top!.location.href = forbiddenUrl;
              return false;
            } catch {
              return true;
            }
          })(),
        };
        return result;
      }, forbiddenUrl);
      expect(result).toMatchObject({
        requireDenied: true,
        processDenied: true,
        parentDenied: true,
        openerDenied: true,
        popupDenied: true,
        fetchDenied: true,
        xhrDenied: true,
        webSocketDenied: true,
        topNavigationDenied: true,
        webSocketPolicyObserved: true,
      });
      const formResult = await frame.evaluate(async (forbiddenUrl) => {
        const before = location.href;
        const form = document.createElement("form");
        form.action = forbiddenUrl;
        document.body.append(form);
        form.submit();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return location.href === before;
      }, forbiddenUrl);
      expect(formResult).toBe(true);
      for (const mode of ["script", "link", "meta", "renamed", "redirect"]) {
        const navigationUrl = `${forbiddenUrl}/${mode === "redirect" ? "redirect" : "received"}?case=${mode}`;
        await frame.evaluate(
          ({ mode, url }) => {
            if (mode === "link") {
              const link = document.createElement("a");
              link.href = url;
              document.body.append(link);
              link.click();
            } else if (mode === "meta") {
              const meta = document.createElement("meta");
              meta.httpEquiv = "refresh";
              meta.content = `0;url=${url}`;
              document.head.append(meta);
            } else {
              if (mode === "renamed") window.name = "renamed-by-content";
              location.href = url;
            }
          },
          { mode, url: navigationUrl },
        );
        await expect
          .poll(
            async () =>
              app.evaluate(
                async (_electron, input) => {
                  const { blockedNavigations } = await import(input.mainUrl);
                  return blockedNavigations.some(
                    (event: { url: string; frameTreeNodeId?: number }) =>
                      event.url === input.url && event.frameTreeNodeId === input.frameTreeNodeId,
                  );
                },
                { mainUrl, url: navigationUrl, frameTreeNodeId },
              ),
            { timeout: 2000 },
          )
          .toBe(true);
        expect(frame.url()).toBe("about:srcdoc");
        expect(requests).toEqual([]);
        expect(socketRequests).toEqual([]);
      }
    } finally {
      try {
        await app.close();
      } finally {
        try {
          if (sockets) {
            for (const socket of sockets.clients) socket.terminate();
            await new Promise<void>((resolve, reject) =>
              sockets!.close((error) => (error ? reject(error) : resolve())),
            );
          }
        } finally {
          if (receiver?.listening) {
            receiver.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
              receiver!.close((error) => (error ? reject(error) : resolve())),
            );
          }
        }
      }
    }
  },
  30_000,
);
