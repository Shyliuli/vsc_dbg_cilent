import { Fragment, type ReactNode } from 'react';

import { breadcrumbSegments } from '../debug/store.ts';
import { useDebugStore } from '../debug/store.ts';
import type { EditorTab } from '../debug/types.ts';
import { Codicon } from './Icons.tsx';

export function Breadcrumbs(props: { tab: EditorTab | undefined }): ReactNode {
  const frames = useDebugStore((state) => state.frames);
  const selectedFrameId = useDebugStore((state) => state.selectedFrameId);
  const workspaceRoot = useDebugStore((state) => state.workspace?.root);
  const selectedFrame = frames.find((frame) => frame.id === selectedFrameId);

  if (!props.tab) {
    return null;
  }

  const tab = props.tab;
  if (tab.kind === 'source' && tab.path) {
    // VS Code breadcrumbs are workspace-relative; this also keeps absolute
    // home directories out of screenshots and recordings.
    const displayPath =
      workspaceRoot && tab.path.startsWith(workspaceRoot + '/')
        ? tab.path.slice(workspaceRoot.length + 1)
        : tab.path;
    const segments = breadcrumbSegments(displayPath);
    return (
      <div className="breadcrumbs">
        {segments.map((segment, index) => (
          <Fragment key={`${segment}-${index}`}>
            {index > 0 ? <Codicon name="chevron-right" className="breadcrumb-separator" /> : null}
            <span className="breadcrumb">{segment}</span>
          </Fragment>
        ))}
        {selectedFrame && selectedFrame.sourcePath === tab.path ? (
          <>
            <Codicon name="chevron-right" className="breadcrumb-separator" />
            <Codicon name="symbol-function" className="breadcrumb-icon" />
            <span className="breadcrumb symbol">{selectedFrame.name}</span>
          </>
        ) : null}
      </div>
    );
  }

  if (tab.kind === 'launch') {
    return (
      <div className="breadcrumbs">
        <span className="breadcrumb">.vscode</span>
        <Codicon name="chevron-right" className="breadcrumb-separator" />
        <span className="breadcrumb">launch.json</span>
      </div>
    );
  }

  return (
    <div className="breadcrumbs">
      <Codicon name={tab.kind === 'disassembly' ? 'debug-line-by-line' : tab.kind === 'memory' ? 'chip' : 'debug-alt'} className="breadcrumb-icon" />
      <span className="breadcrumb">{tab.title}</span>
    </div>
  );
}
