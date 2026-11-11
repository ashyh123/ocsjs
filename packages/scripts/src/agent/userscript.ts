import { installChaoxingAgentBridge } from './bridge';

declare const unsafeWindow: Window;
declare function GM_getValue(key: string): unknown;
declare function GM_setValue(key: string, value: unknown): void;

// This dedicated entry never starts the legacy automatic project lifecycles.
if (typeof unsafeWindow === 'undefined' || typeof GM_getValue === 'undefined' || typeof GM_setValue === 'undefined') {
	throw new Error('OCS Agent requires Tampermonkey or ScriptCat.');
}

installChaoxingAgentBridge({
	window: unsafeWindow,
	storage: { get: (key) => GM_getValue(key), set: (key, value) => GM_setValue(key, value) },
	attachmentsProvider: () => (unsafeWindow as Window & { attachments?: unknown }).attachments
});
