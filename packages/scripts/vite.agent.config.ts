import { defineConfig } from 'vite';
import { version } from '../../package.json';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const metadata = `// ==UserScript==
// @name         OCS Agent - 超星视频
// @namespace    https://github.com/ashyh123/ocsjs/agent
// @version      ${version}.agent.1
// @description  超星视频控制、结构化状态、课程记忆，供 Egolite 等浏览器 agent 调用。
// @author       OCS contributors
// @license      MIT
// @source       https://github.com/ashyh123/ocsjs
// @match        *://*.chaoxing.com/*
// @match        *://*.xuexi365.com/*
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==
`;

export default defineConfig({
	plugins: [
		{
			name: 'ocs-agent-userscript-header',
			generateBundle(_options, bundle) {
				const license = readFileSync(resolve(__dirname, '../../LICENSE'), 'utf8').replace(/\*\//g, '* /');
				for (const chunk of Object.values(bundle)) {
					if (chunk.type === 'chunk') chunk.code = `${metadata}\n/*\n${license}\n*/\n${chunk.code}`;
				}
			}
		}
	],
	build: {
		emptyOutDir: false,
		minify: false,
		lib: {
			entry: 'src/agent/userscript.ts',
			name: 'OCSAgentScript',
			formats: ['iife'],
			fileName: () => 'ocs.agent.user.js'
		}
	}
});
