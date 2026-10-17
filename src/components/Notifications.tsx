import type { ReactNode } from 'react';

import { useDebugStore } from '../debug/store.ts';
import { Codicon } from './Icons.tsx';

export function Notifications(): ReactNode {
  const notifications = useDebugStore((state) => state.notifications);
  const dismissNotification = useDebugStore((state) => state.dismissNotification);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="notifications" aria-live="polite">
      {notifications.map((notification) => (
        <div key={notification.id} className={`notification notification-${notification.severity}`}>
          <div className="notification-icon">
            <Codicon
              name={
                notification.severity === 'error'
                  ? 'error'
                  : notification.severity === 'warning'
                    ? 'warning'
                    : 'info'
              }
            />
          </div>
          <div className="notification-body">
            <div className="notification-message">{notification.message}</div>
            {notification.detail ? <div className="notification-detail">{notification.detail}</div> : null}
            {notification.actions && notification.actions.length > 0 ? (
              <div className="notification-actions">
                {notification.actions.map((action) => (
                  <button
                    key={action.label}
                    className="notification-action"
                    onClick={() => {
                      dismissNotification(notification.id);
                      action.action();
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            className="notification-close"
            title="Close"
            onClick={() => dismissNotification(notification.id)}
          >
            <Codicon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
