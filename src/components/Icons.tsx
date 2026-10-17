import type { CSSProperties, ReactNode } from 'react';

import { fileExtension } from '../debug/format.ts';

export function Codicon(props: {
  name: string;
  spin?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}): ReactNode {
  const classes = ['codicon', `codicon-${props.name}`];
  if (props.spin) {
    classes.push('codicon-modifier-spin');
  }
  if (props.className) {
    classes.push(props.className);
  }
  return <i className={classes.join(' ')} style={props.style} title={props.title} aria-hidden="true" />;
}

const FILE_ICONS: Record<string, { icon: string; color: string }> = {
  c: { icon: 'file-code', color: '#519ABA' },
  h: { icon: 'file-code', color: '#519ABA' },
  cpp: { icon: 'file-code', color: '#519ABA' },
  cc: { icon: 'file-code', color: '#519ABA' },
  cxx: { icon: 'file-code', color: '#519ABA' },
  hpp: { icon: 'file-code', color: '#519ABA' },
  hh: { icon: 'file-code', color: '#519ABA' },
  json: { icon: 'json', color: '#CBCB41' },
  jsonc: { icon: 'json', color: '#CBCB41' },
  md: { icon: 'markdown', color: '#519ABA' },
  sh: { icon: 'terminal', color: '#89D185' },
  py: { icon: 'file-code', color: '#3572A5' },
  ts: { icon: 'file-code', color: '#519ABA' },
  tsx: { icon: 'file-code', color: '#519ABA' },
  js: { icon: 'file-code', color: '#CBCB41' },
  jsx: { icon: 'file-code', color: '#CBCB41' },
  rs: { icon: 'file-code', color: '#DEA584' },
  go: { icon: 'file-code', color: '#519ABA' },
  txt: { icon: 'file', color: '#C5C5C5' },
  S: { icon: 'file-code', color: '#CBCB41' },
};

export function FileIcon(props: { path: string; className?: string }): ReactNode {
  const extension = fileExtension(props.path);
  const entry = FILE_ICONS[extension] ?? { icon: 'file', color: '#C5C5C5' };
  return (
    <Codicon
      name={entry.icon}
      className={props.className}
      style={{ color: entry.color }}
      title={undefined}
    />
  );
}

export function TabIcon(props: { kind: string; path?: string }): ReactNode {
  if (props.kind === 'disassembly') {
    return <Codicon name="debug-line-by-line" />;
  }
  if (props.kind === 'memory') {
    return <Codicon name="chip" />;
  }
  if (props.kind === 'launch') {
    return <FileIcon path={props.path ?? 'launch.json'} />;
  }
  if (props.kind === 'welcome') {
    return <Codicon name="debug-alt" />;
  }
  return <FileIcon path={props.path ?? ''} />;
}
