// ── A stack, read ─────────────────────────────────────────────────────────────

// What the hook keeps of the stack that made a call, so the panel's Trace links each frame to its
// source: a frame's function, its script and its position, read from an error's `stack` as V8 and
// SpiderMonkey write one. A frame with no position — native code, say — says nothing to link.

// interfaces

/** One frame of a stack: where it runs, its line and its column from 1, and its function's name. */
export interface IStackFrame {
  column: number;
  functionName?: string | undefined;
  line: number;
  url: string;
}

// constants

// V8's frame: `    at name (url:line:column)`, or `    at url:line:column` for one with no name
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

// SpiderMonkey's and JavaScriptCore's: `name@url:line:column`, the name left empty for none
const AT_FRAME = /^(.*?)@(.+?):(\d+):(\d+)$/;

// definition

/** The frames of a stack, in its order, each that holds a position; none for what reads as none. */
export const framesOf = (stack: string | undefined): IStackFrame[] => {
  return (stack ?? '').split('\n').flatMap((text) => {
    const match = V8_FRAME.exec(text) ?? AT_FRAME.exec(text);

    if (match === null) {
      return [];
    }

    const [, name, url = '', line = '', column = ''] = match;

    return [
      {
        column: Number(column),
        functionName: name === undefined || name === '' ? undefined : name,
        line: Number(line),
        url,
      },
    ];
  });
};
