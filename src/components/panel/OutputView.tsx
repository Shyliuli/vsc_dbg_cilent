import { useEffect, useRef, type ReactNode } from 'react';

import { useDebugStore } from '../../debug/store.ts';
import { renderAnsi } from './DebugConsole.tsx';

export function OutputView(): ReactNode {
  const lines = useDebugStore((state) => state.outputLines);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const onScroll = () => {
      autoScrollRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    };
    element.addEventListener('scroll', onScroll);
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="output-view" ref={scrollRef}>
      <div className="output-channel">gdb-client — Debug Adapter</div>
      {lines.length === 0 ? (
        <div className="console-empty">No output yet. Start a debug session to see adapter messages.</div>
      ) : null}
      {lines.map((line) => (
        <div key={line.id} className={`output-line${line.kind === 'error' ? ' error' : ''}`}>
          {renderAnsi(line.text)}
        </div>
      ))}
    </div>
  );
}
