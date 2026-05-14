export function splitArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}
