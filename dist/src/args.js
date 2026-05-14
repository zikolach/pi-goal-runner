export function splitArgs(text) {
    const args = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match;
    while ((match = pattern.exec(text)))
        args.push(match[1] ?? match[2] ?? match[3]);
    return args;
}
//# sourceMappingURL=args.js.map