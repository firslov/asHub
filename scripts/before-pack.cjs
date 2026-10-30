module.exports = async context => {
  require('./patch-agent-sh.cjs').apply(context.packager.projectDir + '/node_modules/agent-sh');
  await require('./mac-ripgrep.cjs').beforePack(context);
};
