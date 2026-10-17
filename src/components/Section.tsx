import { useState, type ReactNode } from 'react';

import { Codicon } from './Icons.tsx';

interface SectionProps {
  title: string;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
  defaultCollapsed?: boolean;
}

export function Section(props: SectionProps): ReactNode {
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed ?? false);
  return (
    <div className="section">
      <div className="section-header" onClick={() => setCollapsed((value) => !value)}>
        <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} className="section-twisty" />
        <span className="section-title">{props.title}</span>
        {typeof props.count === 'number' && props.count > 0 ? (
          <span className="section-count">{props.count}</span>
        ) : null}
        <span className="section-actions" onClick={(event) => event.stopPropagation()}>
          {props.actions}
        </span>
      </div>
      {collapsed ? null : <div className="section-body">{props.children}</div>}
    </div>
  );
}
