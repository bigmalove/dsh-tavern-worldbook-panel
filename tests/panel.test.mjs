// 插件浏览器侧的端到端检查：真 client.js + jsdom + 真实 React，只在 Tavern 的 HTTP 路由上打桩。
// 跑法：node --test plugins/dsh-tavern-worldbook-panel/tests/panel.test.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const ENTRY_CONSTANT = { ref: 'entry:0', title: '王城设定', comment: '王城设定', content: '王城位于大陆中央。', enabled: true, constant: true, selective: false, position: 1, depth: 4, primaryKeys: [], secondaryKeys: [], order: 100 }
const ENTRY_KEYWORD = { ref: 'entry:1', title: '雨季', comment: '雨季', content: '每年七月进入雨季。', enabled: true, constant: false, selective: true, position: 0, depth: 3, primaryKeys: ['雨'], secondaryKeys: [], order: 90 }

// 与宿主真实返回结构一致：catalog 给 standalone/embedded 行，get 给 { source, view, globalEnabled }。
function catalogOf(entries) {
	return {
		listWorldBooks: () => ({
			standalone: [{ kind: 'standalone', path: 'worldbooks/a.json', name: '王城世界', globalEnabled: false, entryCount: entries.length, enabledCount: entries.length, diagnostics: 0, importedAt: 0, updatedAt: 0 }],
			embedded: [],
			diagnostics: [],
		}),
		getWorldBook: () => ({
			source: { kind: 'standalone', path: 'worldbooks/a.json' },
			globalEnabled: false,
			view: { displayName: '王城世界', entryCount: entries.length, enabledCount: entries.length, scanDepth: 2, entries },
		}),
	}
}

async function boot(handlers) {
	const dom = new JSDOM('<!doctype html><html><body><div id="anchor" style="position:fixed;top:10px;left:400px;width:28px;height:28px"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
	const calls = []
	const fetch = async (url, options) => {
		const method = String(url).replace('/api/dsh-tavern/', '')
		const body = options && options.body ? JSON.parse(options.body) : {}
		calls.push([method, body])
		const handler = handlers[method]
		const payload = handler ? await handler(body, calls) : {}
		return { ok: true, status: 200, text: async () => JSON.stringify(payload) }
	}

	globalThis.window = dom.window
	globalThis.document = dom.window.document
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
	globalThis.HTMLElement = dom.window.HTMLElement
	globalThis.Element = dom.window.Element
	globalThis.Node = dom.window.Node
	globalThis.CustomEvent = dom.window.CustomEvent
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	const realFetch = globalThis.fetch
	globalThis.fetch = fetch

	const React = (await import('react')).default
	const ReactDOMClient = await import('react-dom/client')
	const ReactDOM = await import('react-dom')
	const provided = { react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient }

	let plugin = null
	dom.window.__ModuleLoader__ = {
		load(definition) {
			plugin = definition.factory((name) => {
				if (!(name in provided)) throw new Error('测试没有提供模块：' + name)
				return provided[name]
			})
		},
	}
	// 插件是按普通脚本执行的，不是在模块作用域里，这里还原那个环境。
	new Function('window', 'document', 'fetch', 'console', source)(dom.window, dom.window.document, fetch, console)

	const registered = []
	const panels = []
	const slots = {
		// 真实 slots.inject 的语义是「槽位可用时调用这个工厂」；测试里立即调用。
		inject(name, factory) { return factory() },
		register(definition, component) {
			registered.push({ definition, component })
			return () => {}
		},
	}
	const tavernUi = {
		apiVersion: 2,
		registerPanel(input) { panels.push(input); return () => {} },
	}
	const ctx = {
		cleanups: [],
		openedTab: null,
		get(name) {
			if (name === 'slots') return slots
			if (name === 'tavernUi') return tavernUi
			if (name === 'betterSidebar') return { openTab: (seed, scope) => { ctx.openedTab = { seed, scope } } }
			return undefined
		},
		effect(factory) {
			const dispose = factory()
			const cleanup = typeof dispose === 'function' ? dispose : () => {}
			ctx.cleanups.push(cleanup)
			return cleanup
		},
	}
	plugin.apply(ctx)
	const triggerEntry = registered.find(entry => entry.definition && String(entry.definition.id || '').endsWith(':trigger'))
	return { dom, calls, React, ctx, plugin, triggerEntry, panels, restore: () => { globalThis.fetch = realFetch } }
}

function tick() { return new Promise(resolve => setTimeout(resolve, 0)) }

/** 打开面板并等到列表里出现条目行（异步链路：catalog → 选中书 → 拉条目）。 */
async function openPanel(React, triggerEntry, dom, sessionId) {
	const { act } = React
	const ReactDOMClient = await import('react-dom/client')
	const host = dom.window.document.createElement('div')
	dom.window.document.body.append(host)
	const root = ReactDOMClient.createRoot(host)
	await act(async () => { root.render(React.createElement(triggerEntry.component, { sessionId })) })
	const button = host.querySelector('.dsh-wbp-trigger')
	assert.ok(button, '有 sessionId 时应渲染图标按钮')
	await act(async () => { button.click() })
	const document = dom.window.document
	for (let attempt = 0; attempt < 40; attempt++) {
		await act(async () => { await tick() })
		if (document.querySelector('.dsh-wbp-switch input')) break
	}
	return { document, host, root, button }
}

test('插件：顶栏按钮打开面板，列出条目并即时写回开关', async () => {
	const { dom, calls, React, triggerEntry, restore } = await boot({
		...catalogOf([ENTRY_CONSTANT, ENTRY_KEYWORD]),
		updateWorldBook: body => ({ worldBook: { entries: [] }, operation: body.update.operations[0] }),
	})
	try {
		assert.ok(triggerEntry, '顶栏按钮应注册到 conversation.session.header.utilities')
		assert.equal(triggerEntry.definition.order, 79)
		const { document } = await openPanel(React, triggerEntry, dom, 'session-1')
		assert.ok(document.querySelector('.dsh-wbp-shell'), '点按钮应弹出面板')
		assert.ok(calls.some(call => call[0] === 'listWorldBooks'), '面板应读取世界书目录')
		assert.ok(calls.some(call => call[0] === 'getWorldBook'), '选中书后应读取条目')

		const rows = document.querySelectorAll('.dsh-wbp-row')
		assert.ok(rows.length >= 2, '应列出两条条目，实际 ' + rows.length)
		const toggle = document.querySelector('.dsh-wbp-switch input')
		await React.act(async () => { toggle.click() })
		for (let attempt = 0; attempt < 20 && !calls.some(call => call[0] === 'updateWorldBook'); attempt++) {
			await React.act(async () => { await tick() })
		}
		const update = calls.filter(call => call[0] === 'updateWorldBook').pop()
		assert.ok(update, '开关应写回 updateWorldBook，实际调用：' + calls.map(call => call[0]).join(','))
		assert.equal(update[1].update.operations[0].op, 'update')
		assert.equal(typeof update[1].update.operations[0].patch.enabled, 'boolean')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：完整版的主面板元素与「完整」跳转都在', async () => {
	const { dom, React, triggerEntry, ctx, restore } = await boot(catalogOf([ENTRY_CONSTANT]))
	try {
		const { document } = await openPanel(React, triggerEntry, dom, 'session-2')
		const shell = document.querySelector('.dsh-wbp-shell')
		assert.ok(shell, '面板应挂载')
		assert.ok(document.querySelector('.dsh-wbp-select'), '应有选书下拉')
		assert.ok(document.querySelector('.dsh-wbp-search'), '应有条目搜索框')
		assert.ok(Array.from(document.querySelectorAll('.dsh-wbp-icon')).some(node => node.getAttribute('aria-label') === '设置'), '应有设置入口')
		const full = Array.from(shell.querySelectorAll('.dsh-wbp-btn')).find(node => node.textContent === '完整')
		assert.ok(full, '应有「完整」按钮')
		await React.act(async () => { full.click() })
		assert.equal(ctx.openedTab && ctx.openedTab.seed.type, 'dsh-tavern:worldbooks', '「完整」应打开右侧栏书库')
		assert.equal(ctx.openedTab.scope.sessionId, 'session-2')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：没有会话时不渲染按钮，卸载时清理干净', async () => {
	const { dom, React, triggerEntry, ctx, restore } = await boot(catalogOf([ENTRY_CONSTANT]))
	try {
		const { act } = React
		const ReactDOMClient = await import('react-dom/client')
		const host = dom.window.document.createElement('div')
		dom.window.document.body.append(host)
		const root = ReactDOMClient.createRoot(host)
		await act(async () => { root.render(React.createElement(triggerEntry.component, {})) })
		assert.equal(host.querySelector('.dsh-wbp-trigger'), null, '没有 sessionId 时不渲染')

		const containers = dom.window.document.querySelectorAll('.dsh-wbp-portal')
		assert.equal(containers.length, 1, '面板容器应挂在 body')
		for (const cleanup of ctx.cleanups) cleanup()
		assert.equal(dom.window.document.querySelectorAll('.dsh-wbp-portal').length, 0, '卸载后容器应移除')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：接管核心按钮的两条路径（顶栏直点、折叠进 ⋮ 菜单）', async () => {
	const { dom, React, triggerEntry, restore } = await boot(catalogOf([ENTRY_CONSTANT]))
	try {
		const document = dom.window.document
		const { act } = React
		const ReactDOMClient = await import('react-dom/client')
		// 先渲染一次，让插件记下当前会话号。
		const host = document.createElement('div')
		document.body.append(host)
		const root = ReactDOMClient.createRoot(host)
		await act(async () => { root.render(React.createElement(triggerEntry.component, { sessionId: 'session-9' })) })

		// 路径一：顶栏上直接可见的按钮（外层 span 带 data-header-item）。
		const headerItem = document.createElement('span')
		headerItem.dataset.headerItem = 'dsh-tavern:worldbooks'
		const directButton = document.createElement('button')
		directButton.textContent = '世界书'
		headerItem.append(directButton)
		document.body.append(headerItem)
		await act(async () => { directButton.click() })
		await act(async () => { await tick() })
		assert.ok(document.querySelector('.dsh-wbp-shell'), '点顶栏世界书按钮应弹出插件面板')

		// 关掉。
		await act(async () => { windowEvent(dom, 'keydown', { key: 'Escape' }) })
		await act(async () => { await tick() })
		assert.equal(document.querySelector('.dsh-wbp-shell'), null, 'Esc 应关闭面板')

		// 路径二：折叠进 ⋮ 菜单后，菜单项没有 data-header-item，只能按文本认。
		const more = document.createElement('button')
		more.dataset.tavernHeaderTrigger = 'more'
		document.body.append(more)
		const menu = document.createElement('div')
		menu.className = 'dsh-tavern-more-menu'
		const worldbookItem = document.createElement('button')
		worldbookItem.setAttribute('role', 'menuitem')
		worldbookItem.textContent = '世界书'
		const otherItem = document.createElement('button')
		otherItem.setAttribute('role', 'menuitem')
		otherItem.textContent = '人物卡'
		menu.append(worldbookItem, otherItem)
		document.body.append(menu)

		await act(async () => { otherItem.click() })
		await act(async () => { await tick() })
		assert.equal(document.querySelector('.dsh-wbp-shell'), null, '点别的菜单项不应开世界书面板')

		await act(async () => { worldbookItem.click() })
		await act(async () => { await tick() })
		assert.ok(document.querySelector('.dsh-wbp-shell'), '点 ⋮ 里的世界书应弹出插件面板')
	} finally {
		restore()
		dom.window.close()
	}
})

function windowEvent(dom, type, init) {
	dom.window.document.dispatchEvent(new dom.window.KeyboardEvent(type, Object.assign({ bubbles: true }, init)))
}

test('插件：注册侧栏页，页内是嵌入形态的完整面板（「插件」分区可见的前提）', async () => {
	const { dom, React, panels, restore } = await boot(catalogOf([ENTRY_CONSTANT, ENTRY_KEYWORD]))
	try {
		assert.equal(panels.length, 1, '应注册且只注册一个侧栏页')
		const [panel] = panels
		// Tavern 只把 tavern-plugin:<owner>:<id> 归进侧栏「插件」分组；id 必须是短 slug。
		assert.equal(panel.id, 'worldbooks')
		assert.equal(panel.title, '加强版世界书', '侧栏卡片与页标题都用插件名')
		assert.match(panel.id, /^[a-z0-9][a-z0-9._-]{0,63}$/, 'registerPanel 的 id 只能是小写 slug')
		assert.equal(typeof panel.render, 'function')

		const { act } = React
		const ReactDOMClient = await import('react-dom/client')
		const host = dom.window.document.createElement('div')
		dom.window.document.body.append(host)
		const root = ReactDOMClient.createRoot(host)
		await act(async () => { root.render(React.createElement(panel.render, { gameId: 'session-7', visible: true })) })
		for (let attempt = 0; attempt < 40; attempt++) {
			await act(async () => { await tick() })
			if (dom.window.document.querySelector('.dsh-wbp-tab')) break
		}

		const shell = dom.window.document.querySelector('.dsh-wbp-shell')
		assert.ok(shell, '侧栏页里应渲染面板')
		assert.ok(shell.classList.contains('is-embed'), '侧栏页里必须是嵌入形态，不能是浮层')
		assert.equal(shell.getAttribute('role'), 'region', '嵌入形态不是对话框')
		// 浮层的定位靠 inline style；嵌入形态必须一无所有，否则会飘出侧栏。
		assert.equal(shell.style.position, '', '嵌入形态不应写 inline 定位')
		assert.equal(shell.style.left, '')
		assert.equal(shell.style.width, '')
		// 走手机那套单列 + 标签页，侧栏宽度放得下。
		assert.ok(shell.classList.contains('is-mobile'))
		const tabs = Array.from(dom.window.document.querySelectorAll('.dsh-wbp-tab')).map(node => node.textContent.trim())
		assert.deepEqual(tabs, ['世界书', '条目', '常用', '完整'], '应有四个标签')
		// 侧栏页默认停在「世界书」（换书），而不是空着的「条目」页。
		const active = dom.window.document.querySelector('.dsh-wbp-tab.is-active')
		assert.equal(active && active.textContent.trim(), '世界书', '默认停在世界书页')

		// 切到「条目」页，开关列表就在这里。
		const entriesTab = Array.from(dom.window.document.querySelectorAll('.dsh-wbp-tab')).find(node => node.textContent.trim() === '条目')
		await act(async () => { entriesTab.click() })
		for (let attempt = 0; attempt < 20; attempt++) {
			await act(async () => { await tick() })
			if (dom.window.document.querySelector('.dsh-wbp-row')) break
		}
		const rows = dom.window.document.querySelectorAll('.dsh-wbp-row')
		assert.ok(rows.length >= 2, '条目页应列出条目，实际 ' + rows.length)
	} finally {
		restore()
		dom.window.close()
	}
})

// 人物卡内置的世界书属于它那张卡：换到别的卡的对局里就不该看见。
test('插件：内置世界书跟着本局会话的卡走', async () => {
	const handlersOf = scoped => ({
		listWorldBooks: () => Object.assign({
			standalone: [{ kind: 'standalone', path: 'worldbooks/常用.json', name: '常用世界', globalEnabled: true, entryCount: 1, enabledCount: 1, diagnostics: 0, importedAt: 0, updatedAt: 0 }],
			embedded: [
				{ kind: 'card', cardPath: 'cards/阿珂.png', name: '阿珂世界书', cardName: '阿珂', entryCount: 1, enabledCount: 1 },
				{ kind: 'card', cardPath: 'cards/小白.png', name: '小白世界书', cardName: '小白', entryCount: 1, enabledCount: 1 },
			],
			diagnostics: [],
		}, scoped ? { sessionCardPath: 'cards/阿珂.png' } : {}),
		getWorldBook: body => ({
			source: body.source, globalEnabled: true,
			view: { displayName: '常用世界', scanDepth: 2, entries: [ENTRY_CONSTANT] },
		}),
	})
	async function listedBookNames(scoped) {
		const { dom, React, triggerEntry, restore } = await boot(handlersOf(scoped))
		try {
			const { document } = await openPanel(React, triggerEntry, dom, 'session-3')
			const allButton = Array.from(document.querySelectorAll('.dsh-wbp-icon')).find(node => node.getAttribute('title') === '全部世界书')
			assert.ok(allButton, '应有「全部世界书」入口')
			await React.act(async () => { allButton.click() })
			for (let attempt = 0; attempt < 20 && !document.querySelector('.dsh-wbp-book-row'); attempt++) {
				await React.act(async () => { await tick() })
			}
			return Array.from(document.querySelectorAll('.dsh-wbp-book-row .dsh-wbp-row-name')).map(node => node.textContent).sort()
		} finally {
			restore()
			dom.window.close()
		}
	}
	// 宿主带回本局的卡：只列这张卡的内置书，别家卡的书留到它们自己的会话。
	assert.deepEqual(await listedBookNames(true), ['常用世界', '阿珂世界书'].sort())
	// 宿主没给会话卡（旧版 Tavern）：保持原样，一本都不藏。
	assert.deepEqual(await listedBookNames(false), ['小白世界书', '常用世界', '阿珂世界书'].sort())
})

// ---- 热点路径：跨挂载缓存、ifRevision、summaryOnly 补正文、乐观开关 ----
// 可控服务端：能按住读/写响应，用来证明「缓存命中 0ms」与「乐观更新不等 RPC」。
function stubServer(options = {}) {
	const conf = Object.assign({ enabled: false, revision: 7, failWrite: false, failToggle: false }, options)
	const state = {
		holdReads: false, holdWrites: false, holdToggles: false,
		readBodies: [], writeBodies: [], setBodies: [],
		pendingReads: [], pendingWrites: [], pendingToggles: [],
	}
	const recordOf = body => {
		// 与宿主 worldBookViewForWire 的 summary 形态一致：content 留空串 + contentOmitted。
		const entries = [ENTRY_CONSTANT, ENTRY_KEYWORD].map(entry => body && body.summaryOnly
			? Object.assign({}, entry, { contentOmitted: true, content: '', contentLength: entry.content.length })
			: entry)
		return {
			source: body.source,
			globalEnabled: conf.enabled,
			revision: conf.revision,
			summaryOnly: Boolean(body && body.summaryOnly),
			view: { displayName: '王城世界', entryCount: entries.length, enabledCount: entries.length, scanDepth: 2, entries },
		}
	}
	const handlers = {
		listWorldBooks: () => ({
			standalone: [{ kind: 'standalone', path: 'worldbooks/a.json', name: '王城世界', globalEnabled: conf.enabled, entryCount: 2, enabledCount: 2, diagnostics: 0, importedAt: 0, updatedAt: 0 }],
			embedded: [],
			diagnostics: [],
		}),
		getWorldBook: body => {
			state.readBodies.push(body)
			// 带 ifRevision 且 revision 没变：新版服务端只回 { unchanged: true }。
			const payload = body && body.ifRevision === conf.revision ? { unchanged: true } : recordOf(body)
			if (!state.holdReads) return payload
			return new Promise(resolve => state.pendingReads.push(() => resolve(payload)))
		},
		updateWorldBook: body => {
			state.writeBodies.push(body)
			if (conf.failWrite) return Promise.reject(new Error('写回失败'))
			const payload = { revision: conf.revision + 1, globalEnabled: conf.enabled, lean: true }
			if (!state.holdWrites) return payload
			return new Promise(resolve => state.pendingWrites.push(() => resolve(payload)))
		},
		setGlobalWorldBook: body => {
			state.setBodies.push(body)
			if (conf.failToggle) return Promise.reject(new Error('开关失败'))
			const payload = { changed: true, lean: true }
			if (!state.holdToggles) { conf.enabled = body.enabled === true; return payload }
			return new Promise(resolve => state.pendingToggles.push(() => { conf.enabled = body.enabled === true; resolve(payload) }))
		},
	}
	return {
		state, handlers,
		releaseReads() { state.holdReads = false; state.pendingReads.splice(0).forEach(run => run()) },
		releaseWrites() { state.holdWrites = false; state.pendingWrites.splice(0).forEach(run => run()) },
		releaseToggles() { state.holdToggles = false; state.pendingToggles.splice(0).forEach(run => run()) },
	}
}

const bookWait = async (React, document, predicate) => {
	for (let attempt = 0; attempt < 30; attempt++) {
		if (predicate(document)) return true
		await React.act(async () => { await tick() })
	}
	return predicate(document)
}

test('插件：关掉再点开命中实例缓存，0ms 出条目、不再闪「正在读取世界书…」', async () => {
	const api = stubServer()
	const { dom, React, triggerEntry, restore } = await boot(api.handlers)
	try {
		const { document, button } = await openPanel(React, triggerEntry, dom, 'session-cache')
		assert.ok(document.querySelector('.dsh-wbp-row'), '首屏应列出条目')
		assert.equal(document.body.textContent.includes('正在读取世界书'), false, '首屏加载完不该还留着加载提示')

		// 关掉浮层 = 组件卸载；再点开时按住所有 getWorldBook：还依赖网络就不会有行。
		await React.act(async () => { windowEvent(dom, 'keydown', { key: 'Escape' }) })
		await React.act(async () => { await tick() })
		assert.equal(document.querySelector('.dsh-wbp-shell'), null, 'Esc 应关闭面板')

		api.state.holdReads = true
		await React.act(async () => { button.click() })
		assert.ok(document.querySelector('.dsh-wbp-shell'), '面板应立刻弹出')
		assert.equal(document.body.textContent.includes('正在读取世界书'), false, '缓存命中时不该出现加载提示')
		assert.ok(document.querySelectorAll('.dsh-wbp-row').length >= 2, '缓存命中应立刻有条目行')

		// 后台仍会静默校验，但只花 ifRevision 的几百字节。
		api.releaseReads()
		await bookWait(React, document, () => api.state.readBodies.some(body => body.ifRevision === 7))
		assert.ok(api.state.readBodies.some(body => body.ifRevision === 7 && body.summaryOnly === true), '重开校验应带 ifRevision + summaryOnly，实际：' + JSON.stringify(api.state.readBodies))
		assert.ok(!document.querySelector('.dsh-wbp-error'), 'unchanged 不该报错')
		assert.ok(document.querySelectorAll('.dsh-wbp-row').length >= 2, 'unchanged 后条目仍在')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：首屏用 summaryOnly 拉元信息，点开详情自动补全正文', async () => {
	const api = stubServer()
	const { dom, React, triggerEntry, restore } = await boot(api.handlers)
	try {
		const { document } = await openPanel(React, triggerEntry, dom, 'session-hydrate')
		assert.ok(api.state.readBodies.some(body => body.summaryOnly === true), '首屏应请求 summaryOnly 元信息')

		api.state.holdReads = true
		await React.act(async () => { document.querySelector('.dsh-wbp-row').click() })
		assert.ok(document.querySelector('.dsh-wbp-shell').textContent.includes('正在读取条目'), '正文补回前详情应显示「正在读取条目…」')
		assert.ok(api.state.readBodies.some(body => body.summaryOnly !== true), '点详情应触发一次完整 getWorldBook')

		api.releaseReads()
		const shown = await bookWait(React, document, node => node.querySelector('.dsh-wbp-shell').textContent.includes('王城位于大陆中央'))
		assert.ok(shown, '补全后详情应显示正文，实际：' + document.querySelector('.dsh-wbp-shell').textContent.slice(0, 160))
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：搜索框一有内容就把 summaryOnly 的书补成完整正文', async () => {
	const api = stubServer()
	const { dom, React, triggerEntry, restore } = await boot(api.handlers)
	try {
		const { document } = await openPanel(React, triggerEntry, dom, 'session-search')
		const fullBefore = api.state.readBodies.filter(body => body.summaryOnly !== true).length
		const input = document.querySelector('.dsh-wbp-search')
		await React.act(async () => {
			const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
			setter.call(input, '雨季')
			input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
		})
		const fetched = await bookWait(React, document, () => api.state.readBodies.filter(body => body.summaryOnly !== true).length > fullBefore)
		assert.ok(fetched, '搜索应触发一次完整正文补拉')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：条目开关 0ms 乐观翻转，lean 返回体不把开关翻回去', async () => {
	const api = stubServer()
	const { dom, React, triggerEntry, restore } = await boot(api.handlers)
	try {
		const { document } = await openPanel(React, triggerEntry, dom, 'session-toggle')
		assert.equal(document.querySelector('.dsh-wbp-switch input').checked, true)
		api.state.holdWrites = true
		await React.act(async () => { document.querySelector('.dsh-wbp-switch input').click() })
		assert.equal(document.querySelector('.dsh-wbp-switch input').checked, false, '开关应立即翻转，不等写回')
		const write = api.state.writeBodies[api.state.writeBodies.length - 1]
		assert.equal(write.lean, true, '写回应带 lean: true')
		assert.equal(write.update.operations[0].patch.enabled, false)
		api.releaseWrites()
		await React.act(async () => { await tick() })
		assert.equal(document.querySelector('.dsh-wbp-switch input').checked, false, 'lean 返回体不该把开关翻回去')
		assert.equal(document.querySelector('.dsh-wbp-error'), null, 'lean 返回体不该报错')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：写回失败时条目开关回滚并提示错误', async () => {
	const api = stubServer({ failWrite: true })
	const { dom, React, triggerEntry, restore } = await boot(api.handlers)
	try {
		const { document } = await openPanel(React, triggerEntry, dom, 'session-toggle-fail')
		await React.act(async () => { document.querySelector('.dsh-wbp-switch input').click() })
		const rolled = await bookWait(React, document, node => Boolean(node.querySelector('.dsh-wbp-error')))
		assert.ok(rolled, '失败应提示错误')
		assert.equal(document.querySelector('.dsh-wbp-switch input').checked, true, '失败应回滚到翻转前')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：开启世界书 0ms 乐观生效（lean 写回），失败回滚', async () => {
	const api = stubServer()
	const { dom, React, triggerEntry, restore } = await boot(api.handlers)
	try {
		const { document } = await openPanel(React, triggerEntry, dom, 'session-worldbook')
		const allButton = Array.from(document.querySelectorAll('.dsh-wbp-icon')).find(node => node.getAttribute('title') === '全部世界书')
		await React.act(async () => { allButton.click() })
		await bookWait(React, document, node => Boolean(node.querySelector('.dsh-wbp-book-row .dsh-wbp-switch input')))
		assert.equal(document.querySelector('.dsh-wbp-book-row .dsh-wbp-switch input').checked, false)

		api.state.holdToggles = true
		await React.act(async () => { document.querySelector('.dsh-wbp-book-row .dsh-wbp-switch input').click() })
		assert.equal(document.querySelector('.dsh-wbp-book-row .dsh-wbp-switch input').checked, true, '开关应立即生效，不等 setGlobalWorldBook')
		const sent = api.state.setBodies[api.state.setBodies.length - 1]
		assert.equal(sent.lean, true, '开启世界书应带 lean: true')
		assert.equal(sent.enabled, true)
		api.releaseToggles()
		await React.act(async () => { await tick() })
		await React.act(async () => { await tick() })
		assert.equal(document.querySelector('.dsh-wbp-book-row .dsh-wbp-switch input').checked, true, '后台对齐后开关仍是开启')
	} finally {
		restore()
		dom.window.close()
	}
})

test('插件：开启世界书失败时回滚目录与开关', async () => {
	const api = stubServer({ failToggle: true })
	const { dom, React, triggerEntry, restore } = await boot(api.handlers)
	try {
		const { document } = await openPanel(React, triggerEntry, dom, 'session-worldbook-fail')
		const allButton = Array.from(document.querySelectorAll('.dsh-wbp-icon')).find(node => node.getAttribute('title') === '全部世界书')
		await React.act(async () => { allButton.click() })
		await bookWait(React, document, node => Boolean(node.querySelector('.dsh-wbp-book-row .dsh-wbp-switch input')))
		await React.act(async () => { document.querySelector('.dsh-wbp-book-row .dsh-wbp-switch input').click() })
		const rolled = await bookWait(React, document, node => Boolean(node.querySelector('.dsh-wbp-error')))
		assert.ok(rolled, '失败应提示错误')
		assert.equal(document.querySelector('.dsh-wbp-book-row .dsh-wbp-switch input').checked, false, '失败应回滚开关')
	} finally {
		restore()
		dom.window.close()
	}
})
