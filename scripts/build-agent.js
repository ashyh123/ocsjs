const path = require('path');

async function buildAgent(outDir = path.resolve(__dirname, '../dist')) {
	const vite = require(require.resolve('vite', { paths: [path.resolve(__dirname, '../packages/scripts')] }));
	await vite.build({
		configFile: path.resolve(__dirname, '../packages/scripts/vite.agent.config.ts'),
		root: path.resolve(__dirname, '../packages/scripts'),
		build: { outDir }
	});
}

exports.buildAgent = buildAgent;
if (require.main === module)
	buildAgent().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
