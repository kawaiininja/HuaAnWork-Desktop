# HuaAnWork User Guide

## Installation and first launch

Get the macOS or Windows installer from your organization's HuaAnWork distribution channel. The installer includes Electron, Node.js, and its pinned DSH dependencies, so ordinary users do not need to install Node.js or pnpm separately.

On first launch, the application prepares the default profile and starts the official DSH Web surface locally; follow the on-screen prompt to create an account or sign in. Closing the window normally hides it; use **Quit** from the tray when you want to stop the application and Host process.

## Launching with a folder

Besides choosing a directory inside the interface, you can name a folder when the application starts. The folder is registered as a workspace and opened. A folder that is already a workspace is simply opened again; nothing is duplicated.

- **Windows drag and drop**: drop the folder onto the **HuaAnWork** desktop shortcut or its Start menu entry. A stopped application starts first; a running one comes to the front and opens the workspace.
- **Command line**: run `huaanwork <folder>`. Relative paths resolve against the current directory. The installed executable also accepts one absolute folder argument.

When the path does not exist, names a file, or lives on unsupported Windows storage such as exFAT, FAT32, or a network drive, the application shows a native message and registers nothing. Launching with a folder is one-shot: a later restart triggered from settings does not reopen it.

Known limit: a HuaAnWork icon pinned to the Windows taskbar does not accept drops yet. HuaAnWork ships for macOS and Windows only.

## Profiles

A profile is a composition of DSH bundles, dependencies, and patches. The first launch creates a `desktop` profile automatically; the tray **Profile** menu lists existing profiles and offers **New Profile…**.

Selecting a profile performs an orderly restart. If the new profile cannot start, use the Recovery Assistant to switch back to a working profile or repair the configuration. Built-in profiles normally share the same DSH home, so sessions, settings, and storage usually do not need to be migrated. A custom configuration (patch) that deliberately redirects a persistence root wins for that profile.

Switching profiles does not copy plugins from the old profile into the new one. Use an explicit profile in the terminal when preparing another profile, or use the default commands after switching.

## Window modes and materials

- **Compatibility mode** keeps the selected profile's official layout and adds an independent desktop control bar above it; it offers the best compatibility.
- **Extended mode** adds an independent titlebar and sidebar around the official content area, with optional glass.
- **Enhanced mode** uses a desktop layout with adjusted sidebars, content panels, and window controls.

On macOS, custom-window modes can turn the glass background on or off. Windows has no material choice and always uses an opaque window. Legacy Windows Acrylic and Mica preferences are safely treated as off, and Acrylic is also migrated when its settings file is writable. Changing mode or material restarts the application; it does not hot-swap the interface or native material in a live renderer.

## Local Web port

The application starts its local Web service at port `43120` by default, and that service binds only to `127.0.0.1`. If the port is already in use, it tries up to 32 subsequent ports. You can also choose a port in the desktop settings; `0` asks the operating system for a random port. Changing the port performs an orderly restart.

A port change also changes the page origin. UI plugins that rely on browser `localStorage` are isolated by origin, so keep a fixed port for them when their settings must survive a restart.

To open the current profile in an ordinary browser, enable browser access in the desktop settings; it is available only in compatibility mode. With the "local network" scope, the application provides an HTTPS entry point for other devices on the same LAN, but each device must first install and trust the certificate provided by this computer. The application shows a risk confirmation before enabling access.

## Plugin management

Plugins are extensions that add capabilities to DSH, such as models, tools, interfaces, and workflows. HuaAnWork uses the official Harness plugin system, so official plugins install and work directly; multiple plugins follow the same conventions and can be installed and used together.

Ordinary DSH plugins use the upstream CLI semantics:

```sh
dsh plugin --profile desktop add <plugin>
dsh plugin --profile desktop remove <plugin>
dsh plugin --profile desktop update
```

In the terminal opened from the HuaAnWork tray, bare `dsh` and plugin commands without `--profile` default to the active profile:

```sh
dsh plugin add <plugin>
dsh plugin remove <plugin>
dsh plugin update
```

An explicit `--profile <name>` always wins. Restart HuaAnWork after plugin changes so the new bundle enters the Loader composition.

## Opening the terminal

Choose **Open DSH Terminal** from the tray, desktop settings, or the window control bar. The settings action has a restart menu beside it for an ordinary restart or **Restart in Recovery Mode**; both require confirmation. macOS opens Terminal; Windows prefers Windows Terminal and falls back to PowerShell or Command Prompt when it is unavailable.

The welcome text shows the application version, active profile, profile directory, and DSH home. HuaAnWork creates private `dsh`, `pnpm`, and `node` shims in its user-data directory and prepends that directory only for the new terminal process. It does not modify the system PATH or the user's shell files.

## Updates

HuaAnWork has a single distribution channel. Packaged macOS and Windows applications check the deployment update service in the background; unless overridden, the default is the intranet address `http://update.intranet.lan:8790` with the path `/api/desktop/version`. Startup is not blocked; network errors, non-200 responses, invalid versions, and a server version that is not newer remain silent in the background. A newer version updates the tray and raises one non-blocking system notification per version instead of opening a download confirmation automatically; clicking the notification reveals the application.

**Check for Updates…** in the tray checks that distribution channel manually. It shows a result even when the installed version is current and reports a retry message when the check fails. When a newer version exists, it first asks whether to download it.

After confirmation, the app opens the native **Save Update Installer** dialog, defaulting to the Downloads directory. You can choose another directory and filename; cancelling the dialog does not start a download. Only after the destination is confirmed does the app request the current platform's installer from the update service, and it remembers the installer location. macOS opens the DMG for the user to replace the application in Applications; Windows prepares the NSIS installer and then asks whether to restart and run it. After the upgrade completes and the app starts again, it asks whether to delete the installer to free disk space or keep it. Download or installer failures do not damage the current version, and the tray operation can be retried.

## Troubleshooting

HuaAnWork confirmations, warnings, and operation results open as separate desktop modal windows rather than as overlays inside the official page. The Recovery Assistant first shows why it opened and then provides quick recovery, plugin management, rollback, profile switching, reset and data management, and diagnostics.

- **The application reaches the tray**: right-click the tray icon and choose **Export Diagnostics…**. After the privacy confirmation, the app creates a `diagnostics-*.zip` archive and reveals it in the file manager.
- **The application crashes repeatedly before the tray appears**: run the installed executable directly with the recovery option. The command below assumes the installer's default location; replace the path if you selected another installation directory.

  ```powershell
  & "$env:LOCALAPPDATA\Programs\HuaAnWork\HuaAnWork.exe" --export-diagnostics
  ```

  For npm installs, run `huaanwork --export-diagnostics`. This command does not start Host, profiles, plugins, or a window. It prints the absolute diagnostics ZIP path when complete.
- **Diagnostic archive contents**: recent application logs, local Crashpad `.dmp` files, the active-run marker, and `system-info.txt`. System information records the HuaAnWork, Electron, Node, platform, and architecture versions. Recognized credentials are masked in logs, but local paths, workspace IDs, session IDs, and crash-time memory fragments may remain. Review the archive before sharing and send sensitive dumps only through a trusted channel.
- **The window disappeared**: check the system tray; closing the window is not quitting.
- **A plugin is missing**: confirm the command targeted the intended profile and restart the application.
- **A terminal command is missing**: open a fresh HuaAnWork terminal from the tray; HuaAnWork does not modify the global PATH.
- **No update notification appeared**: background failures are silent; use the manual tray check to see the result.

The lower-level lifecycle, packaging, and platform limits belong to the developer documentation; see the [documentation index](README.md).
