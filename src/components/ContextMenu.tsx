import { useEffect, type ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';

export function ContextMenu(): ReactNode {
  const menu = useDebugStore((state) => state.contextMenu);
  const setContextMenu = useDebugStore((state) => state.setContextMenu);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu, setContextMenu]);

  if (!menu) {
    return null;
  }

  const style = {
    left: Math.min(menu.x, window.innerWidth - 280),
    top: Math.min(menu.y, window.innerHeight - 320),
  };

  return (
    <div
      className="context-menu"
      style={style}
      onMouseDown={(event) => event.stopPropagation()}
      role="menu"
    >
      {menu.items.map((item, index) =>
        item.separator ? (
          <div key={`separator-${index}`} className="context-menu-separator" />
        ) : (
          <button
            key={`${item.label}-${index}`}
            className="context-menu-item"
            disabled={item.disabled}
            onClick={() => {
              setContextMenu(null);
              item.action?.();
            }}
            role="menuitem"
          >
            <span>{item.label}</span>
            {item.keybinding ? <span className="context-menu-keybinding">{item.keybinding}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}
