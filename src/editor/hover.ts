import { monaco } from './monaco.ts';
import { useDebugStore } from '../debug/store.ts';

const LANGUAGES = ['c', 'cpp', 'rust', 'python', 'go', 'plaintext', 'asm'];

const EXPRESSION_PATTERN = /\b([A-Za-z_]\w*(?:(?:\.|->)[A-Za-z_]\w*|\[[^\]]+\])*)/g;

interface ExpressionRange {
  expression: string;
  start: number;
  end: number;
}

/** Blank comments and literals without changing column offsets. */
function maskNonCode(line: string): string {
  return line
    .replace(/\/\/.*$/, (match) => ' '.repeat(match.length))
    .replace(/\/\*.*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/"(?:\\.|[^"\\])*"/g, (match) => ' '.repeat(match.length))
    .replace(/'(?:\\.|[^'\\])*'/g, (match) => ' '.repeat(match.length));
}

/** Find the expression under the cursor, including member and index chains. */
export function expressionAt(line: string, column: number): ExpressionRange | null {
  const masked = maskNonCode(line);
  const pattern = new RegExp(EXPRESSION_PATTERN.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const start = match.index;
    const end = start + match[1].length;
    if (column >= start + 1 && column <= end + 1) {
      return { expression: match[1], start, end };
    }
  }
  return null;
}

let registered = false;

/**
 * Hover evaluation. Registered once for the languages that can appear in a
 * debugger source view; returns gdb's value plus its type, like cpptools.
 */
export function registerHoverProvider(): void {
  if (registered) {
    return;
  }
  registered = true;
  for (const language of LANGUAGES) {
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model, position) {
        const state = useDebugStore.getState();
        if (state.status !== 'stopped' || state.selectedFrameId === null) {
          return null;
        }
        if (model.isDisposed()) {
          return null;
        }
        const line = model.getLineContent(position.lineNumber);
        const found = expressionAt(line, position.column);
        if (!found) {
          return null;
        }
        const result = await state.evaluateForHover(found.expression, state.selectedFrameId);
        if (!result) {
          return null;
        }
        const typeSuffix = result.type ? `: ${result.type}` : '';
        return {
          range: new monaco.Range(position.lineNumber, found.start + 1, position.lineNumber, found.end + 1),
          contents: [
            { value: `\`\`\`cpp\n${found.expression}${typeSuffix} = ${result.value}\n\`\`\`` },
          ],
        };
      },
    });
  }
}
