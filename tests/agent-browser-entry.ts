import { installChaoxingAgentBridge } from '../packages/scripts/src/agent/bridge';

// Test harness only: production userscript does not allow localhost cross-origin calls.
installChaoxingAgentBridge({
	window,
	storage: {
		get: (key) => JSON.parse(localStorage.getItem(key) || 'null'),
		set: (key, value) => localStorage.setItem(key, JSON.stringify(value))
	},
	attachmentsProvider: () => (window as any).attachments,
	allowedOrigins: [`http://localhost:${location.port}`, `http://127.0.0.1:${location.port}`]
});
