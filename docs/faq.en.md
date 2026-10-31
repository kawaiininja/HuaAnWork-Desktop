# HuaAnWork FAQ

[中文](faq.md)

This page answers common questions about installation, supported platforms, the bundled runtime, and plugins in the current HuaAnWork release. The version provided by your distribution channel and the [user guide](user-guide.en.md) define the shipped product scope.

## What is HuaAnWork?

HuaAnWork is a DeepSeek Harness desktop client for Windows and macOS. It packages the official Harness local Web UI, Host service, and plugin system into a native desktop application with a window, system tray, terminal, updates, and profile management.

## Is this an official DeepSeek product?

No. HuaAnWork is not an official DeepSeek product; DeepSeek Harness is the runtime it is built on. HuaAnWork is not affiliated with or endorsed by DeepSeek. Installers come from your organization's HuaAnWork distribution channel.

## Which operating systems are supported?

HuaAnWork provides a Windows x64 installer and a universal macOS installer (Intel and Apple Silicon). Linux is outside this product's distribution scope, and no Linux installer is provided.

## Do I need to install Node.js, pnpm, or DSH?

No. The installer includes Electron, Node.js, pnpm, and pinned DSH dependencies. Ordinary users can install and launch directly, and HuaAnWork does not modify the global system PATH or user shell configuration.

## Does the first launch download a runtime?

No separate Node.js or Harness core download is required. The installer is larger because it contains the runtime and pinned dependencies, trading download size for a more deterministic first launch and dependency set. Cloud models, update checks, and new-version downloads still require network access.

## Does HuaAnWork modify official Harness?

No. The repository pins an unmodified official Harness checkout. Compatibility mode runs the upstream default Web client below an independent desktop control bar. Extended and enhanced modes each install their own layout through the plugin/profile composition boundary while retaining the official slot occupants. None of these modes edits upstream source.

## Is data stored locally?

HuaAnWork's Host, profiles, and DSH home live on the local machine. Whether content is sent to an external service depends on the model or tool providers the user configures; requests to cloud models still go to those providers.

## Can I install DSH plugins?

Yes. HuaAnWork uses the official Harness plugin system. Open DSH Terminal from the tray and run `dsh plugin add`, `dsh plugin remove`, or `dsh plugin update`. These commands default to the active profile, and HuaAnWork must be restarted after plugin changes.

## Does the HuaAnWork profile automatically sync with an existing web profile?

No plugins are copied automatically. Each profile has its own bundle and dependency composition. After switching profiles, default plugin commands target the active profile; `--profile <name>` can always select one explicitly.

## How are updates installed?

HuaAnWork has a single distribution channel. Packaged applications check the configured update service in the background but never install silently. A newer version requires confirmation. Before downloading, a native save dialog lets you choose the installer's directory and filename; cancelling it does not start a download. macOS downloads and opens a DMG; Windows downloads and starts an NSIS installer. After the upgrade and next launch, the app asks whether to delete or keep the installer. Network and download failures leave the current installation intact.

## Does the app use my system proxy?

Yes. At startup the app reads the operating system's proxy configuration — Windows Internet options or macOS network settings, including automatic configuration scripts (PAC/WPAD) — and applies it to everything it sends: model conversations, web fetches, web search, MCP servers, plugin installs, and commands the app starts in its terminal. Turning on the "system proxy" switch in a client such as Clash or v2rayN is enough; nothing needs to be entered in the app.

A few rules worth knowing:

- **A proxy you set yourself wins.** If `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` is set before launch, the app uses that one and ignores the system configuration. `NO_PROXY` is honored the same way.
- **Restart the app after changing the proxy.** The configuration is read once, at startup. After toggling the system proxy in your client, or switching to a node that changes the port, quit the app and open it again.
- **A SOCKS-only configuration cannot be used.** The app's HTTP egress accepts only `http://` and `https://` proxies. If the system proxy is configured for SOCKS alone, enable the HTTP port or the mixed port in your proxy client (Clash's "mixed port" serves both), then turn the system proxy on. The application window itself and the update check keep working either way; only the features listed above connect directly.
- **Local addresses never go through the proxy.** `localhost`, `127.0.0.1`, and this machine's own LAN addresses bypass it, so a locally running server or a LAN address is never blocked by the proxy.
- **Known limitation: on macOS, launching from the Dock or Finder does not pick up proxy variables written only in `~/.zshrc` or `~/.bashrc`.** This is deliberate — a proxy address can carry a username and password, and the app does not inherit that class of variable from shell configuration. Use the system proxy settings instead, or start the app from a terminal.
- **How to confirm it worked.** Every start writes one `outbound proxy = ...` line to the log, for example `outbound proxy = http://127.0.0.1:7890 (source: system, no_proxy: ...)`. A `source` of `system` means the system configuration was used, `environment` means a variable you set was used, and `none` means the app is connecting directly. The log lives in the `logs` folder of the application data directory, and "Export diagnostics" packages it up. Please include that line when reporting a network problem.

## Where can I get the installer or report a problem?

Installers and release information come from your organization's HuaAnWork distribution channel. Check the [troubleshooting section](user-guide.en.md#troubleshooting) first. If the problem remains, report it through your organization's internal maintenance channel with the operating system, app version, reproduction steps, and error details.
