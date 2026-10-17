import type { ReactNode } from 'react';

import { useDebugStore } from '../../debug/store.ts';
import { Codicon } from '../Icons.tsx';

export function ProblemsView(): ReactNode {
  const launchFile = useDebugStore((state) => state.launchFile);
  const openLaunchJson = useDebugStore((state) => state.openLaunchJson);

  const errors = launchFile?.errors ?? [];
  const warnings = (launchFile?.configs ?? []).flatMap((config) =>
    config.warnings.map((warning) => `${config.name}: ${warning}`),
  );

  if (errors.length === 0 && warnings.length === 0) {
    return (
      <div className="problems-empty">
        <Codicon name="check" />
        <span>No problems have been detected in the workspace.</span>
      </div>
    );
  }

  return (
    <div className="problems">
      {errors.map((error) => (
        <button
          key={error}
          className="problem-row error"
          onClick={() => void openLaunchJson()}
          title="Open launch.json"
        >
          <Codicon name="error" />
          <span>{error}</span>
          <span className="problem-source">launch.json</span>
        </button>
      ))}
      {warnings.map((warning) => (
        <button
          key={warning}
          className="problem-row warning"
          onClick={() => void openLaunchJson()}
          title="Open launch.json"
        >
          <Codicon name="warning" />
          <span>{warning}</span>
          <span className="problem-source">launch.json</span>
        </button>
      ))}
    </div>
  );
}
