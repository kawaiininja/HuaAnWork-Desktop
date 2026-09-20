import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { sidecarStatus } from "./logic/accountStatus.ts";

type Props = {
  username: string;
  collapsed: boolean;
  ready: boolean;
  sidecarDead: boolean;
  logoutDisabled: boolean;
  onOpenSettings: () => void;
  onLogout: () => void;
};

export default function AccountFooter({
  username,
  collapsed,
  ready,
  sidecarDead,
  logoutDisabled,
  onOpenSettings,
  onLogout,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, placed: false });
  const rowRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const logoutRef = useRef<HTMLButtonElement>(null);
  const status = sidecarStatus(ready, sidecarDead);

  function closeMenu(restoreFocus = false) {
    setMenuOpen(false);
    setMenuPos((prev) => ({ ...prev, placed: false }));
    if (restoreFocus) rowRef.current?.focus();
  }

  useEffect(() => {
    setMenuOpen(false);
    setMenuPos((prev) => ({ ...prev, placed: false }));
    void collapsed;
  }, [collapsed]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = () => {
      setMenuOpen(false);
      setMenuPos((prev) => ({ ...prev, placed: false }));
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || rowRef.current?.contains(target))) return;
      dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const row = rowRef.current;
    const menu = menuRef.current;
    if (!row || !menu) return;
    const rect = row.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let top: number;
    let left: number;
    if (collapsed) {
      left = rect.right + 8;
      top = rect.top;
      if (left + mw > window.innerWidth - 8) left = rect.left - mw - 8;
      if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
    } else {
      top = rect.top - mh - 6;
      left = rect.left;
      if (top < 8) top = rect.bottom + 6;
      if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
    }
    if (top < 8) top = 8;
    if (left < 8) left = 8;
    setMenuPos({ top, left, placed: true });
    settingsRef.current?.focus();
  }, [menuOpen, collapsed]);

  function focusItem(index: 0 | 1) {
    (index === 0 ? settingsRef : logoutRef).current?.focus();
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [settingsRef.current, logoutRef.current];
    const current = items.findIndex((el) => el === document.activeElement);
    const idx = current < 0 ? 0 : current;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(idx === 0 ? 1 : 0);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      focusItem(event.shiftKey ? (idx === 0 ? 1 : 0) : idx === 1 ? 0 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    }
  }

  function onSettings() {
    closeMenu();
    onOpenSettings();
  }

  function onLogoutClick() {
    if (logoutDisabled) return;
    closeMenu();
    onLogout();
  }

  return (
    <footer className="side-footer">
      <button
        ref={rowRef}
        type="button"
        className="user-row"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <span className="avatar">
          华
          <span className={`sidecar-badge tone-${status.tone}`} aria-hidden />
        </span>
        <span className="uname">{username}</span>
        <span className={`ustate tone-dot tone-${status.tone}`} aria-hidden />
      </button>
      {menuOpen ? (
        <>
          <div className="context-overlay" />
          <div
            ref={menuRef}
            className="context-menu account-menu"
            role="menu"
            style={{ top: menuPos.top, left: menuPos.left, visibility: menuPos.placed ? "visible" : "hidden" }}
            onKeyDown={onMenuKeyDown}
          >
            <div className="account-menu-head">
              <span className="avatar">华</span>
              <div>
                <div className="account-menu-name">{username}</div>
                <div className="account-menu-status">{status.label}</div>
              </div>
            </div>
            <button
              ref={settingsRef}
              type="button"
              role="menuitem"
              className="context-menu-item"
              onClick={onSettings}
            >
              <span>设置</span>
              <span className="kbd">⌘,</span>
            </button>
            <button
              ref={logoutRef}
              type="button"
              role="menuitem"
              className="context-menu-item"
              aria-disabled={logoutDisabled}
              title={logoutDisabled ? "任务进行中，结束后再退出" : undefined}
              onClick={onLogoutClick}
            >
              退出登录
            </button>
          </div>
        </>
      ) : null}
    </footer>
  );
}
