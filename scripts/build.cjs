const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { integrations, projectRoot } = require('./builtin-integrations.cjs');

const noEmit = process.argv.includes('--noEmit');
const config = path.join(projectRoot, 'tsconfig.json');
const formatHost = {
  getCanonicalFileName: file => file,
  getCurrentDirectory: () => projectRoot,
  getNewLine: () => ts.sys.newLine,
};
function check(diagnostics) {
  if (!diagnostics.length) return;
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  process.exit(1);
}

const read = ts.readConfigFile(config, ts.sys.readFile);
if (read.error) check([read.error]);
const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, projectRoot, { noEmit }, config);
check(parsed.errors);
const selected = integrations();
const disabled = selected.filter(item => !item.enabled);
function isDisabled(file) {
  return disabled.some(({ source }) => {
    const relative = path.relative(source, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  });
}
const program = ts.createProgram(parsed.fileNames.filter(file => !isDisabled(file)), parsed.options);
for (const file of program.getSourceFiles()) {
  if (isDisabled(file.fileName)) {
    throw new Error(`An included module imports an excluded integration: ${file.fileName}`);
  }
}
check(ts.getPreEmitDiagnostics(program));
if (!noEmit) {
  // Remove stale outputs, including modules moved out of the core since the last build.
  fs.rmSync(parsed.options.outDir, { recursive: true, force: true });
  check(program.emit().diagnostics);
  for (const { name, source, enabled } of selected) {
    if (!enabled) continue;
    const assets = path.join(source, 'assets');
    if (fs.existsSync(assets)) {
      fs.cpSync(assets, path.join(parsed.options.outDir, 'builtin-plugins', name, 'assets'), { recursive: true });
    }
  }
}
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), ...(noEmit ? ['--noEmit'] : []), '-p', 'examples/extensions/desktop-control'], {
  cwd: projectRoot,
  stdio: 'inherit',
});
