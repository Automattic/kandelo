// Some stacks contain frames without the Error's message. Preserve both so
// a collected application failure retains its actual reason on every host.
export function describeError(error) {
  const message=String(error),stack=typeof error?.stack==='string'?error.stack:'';
  return stack?(stack.includes(message)?stack:message+'\n'+stack):message;
}
